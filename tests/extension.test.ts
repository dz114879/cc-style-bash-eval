// biome-ignore-all lint/style/noNonNullAssertion: Required registrations and native cards are asserted at the ExtensionAPI seam.
import { expect, mock, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type SessionMessageEntry,
	type ToolDefinition,
	type ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Theme, type ThemeColor, type ThemeBg } from "@oh-my-pi/pi-tui/theme";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import ccStyleBashEval from "../src/index";

initThemeSync("unicode");

const collapsed = { expanded: false, isPartial: false };
const nativeResult = {
	content: [{ type: "text" as const, text: "native output" }],
	details: {},
};

type RegisteredTool = ToolDefinition & Pick<ToolInfo, "promptGuidelines">;
type Handler = (
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) => unknown;

function harness() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Handler[]>();
	const sessionManager = SessionManager.inMemory();
	const getAllTools = mock((): ToolInfo[] => []);
	const api = {
		getAllTools,
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	ccStyleBashEval(api as unknown as ExtensionAPI);
	return {
		tools,
		getAllTools,
		sessionManager,
		async emit(type: string, event: Record<string, unknown> = {}) {
			let result: unknown;
			for (const handler of handlers.get(type) ?? []) {
				result = await handler({ type, ...event }, {
					sessionManager,
				} as unknown as ExtensionContext);
			}
			return result;
		},
	};
}

function nativeTools(): ToolInfo[] {
	return [
		{
			name: "bash",
			description: "Live shell description",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
			},
			promptGuidelines: ["Prefer independent shell commands."],
		},
		{
			name: "eval",
			description: "Live Python-only notebook",
			parameters: {
				type: "object",
				properties: { language: { enum: ["py"] }, code: { type: "string" } },
			},
			promptGuidelines: ["Use the session's enabled runtime."],
		},
		{
			name: "read",
			description: "Native read",
			parameters: { type: "object" },
		},
	] as unknown as ToolInfo[];
}

function assistantMessage(
	...content: Extract<
		SessionMessageEntry["message"],
		{ role: "assistant" }
	>["content"]
): Extract<SessionMessageEntry["message"], { role: "assistant" }> {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("session_start installs same-name overrides using live schemas and delegates native execution unchanged", async () => {
	const h = harness();
	expect(h.tools.size).toBe(0);
	expect(h.getAllTools).not.toHaveBeenCalled();
	const liveTools = nativeTools();
	h.getAllTools.mockReturnValue(liveTools);
	await h.emit("session_start");
	expect([...h.tools.keys()]).toEqual(["bash", "eval"]);

	for (const native of liveTools.slice(0, 2)) {
		const tool = h.tools.get(native.name)!;
		expect(tool.description).toBe(native.description);
		expect(tool.parameters).toBe(native.parameters);
		expect(tool.promptGuidelines).toBe(native.promptGuidelines);
		expect(tool.approval).toBe("exec");
		expect(tool.loadMode).toBe("essential");
		expect(tool.strict).toBe(true);
		const params =
			native.name === "bash"
				? { command: "printf native" }
				: { language: "py", code: "print(42)" };
		const signal = new AbortController().signal;
		const onUpdate = mock();
		const result = {
			content: [{ type: "text" as const, text: "full native output" }],
			details: { exitCode: 0 },
		};
		const invokeTool = mock(
			async (_params: unknown, _options: unknown) => result,
		);
		expect(
			await tool.execute("call-1", params, signal, onUpdate, {
				invokeTool,
			} as unknown as ExtensionContext),
		).toBe(result);
		expect(invokeTool.mock.calls).toEqual([[params, { signal, onUpdate }]]);
	}
});

test("one live summary line counts bash calls across internal turns, prose and non-target tools", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	await h.emit("before_agent_start");
	const bash = h.tools.get("bash")!;
	const first = { command: "echo first" };
	await h.emit("tool_call", {
		toolName: "bash",
		toolCallId: "b1",
		input: first,
	});
	const summary = bash.renderCall?.(first, collapsed, theme);
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command",
	]);
	const narrowSummary = summary!.render(10);
	expect(narrowSummary).toHaveLength(1);
	expect(visibleWidth(narrowSummary[0])).toBeLessThanOrEqual(10);
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command",
	]);
	expect(
		bash.renderResult?.(nativeResult, collapsed, theme, first),
	).toBeUndefined();

	await h.emit("turn_start");
	await h.emit("message_end", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Continuing" }],
		},
	});
	await h.emit("tool_call", {
		toolName: "read",
		toolCallId: "r1",
		input: { path: "sample.txt" },
	});
	const second = { command: "echo second" };
	await h.emit("tool_call", {
		toolName: "bash",
		toolCallId: "b2",
		input: second,
	});
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 commands",
	]);
	for (let repaint = 0; repaint < 2; repaint++) {
		expect(bash.renderCall?.(second, collapsed, theme)).toBeUndefined();
		expect(
			bash.renderResult?.(nativeResult, collapsed, theme, second),
		).toBeUndefined();
		expect(
			bash
				.renderCall?.(first, collapsed, theme)
				?.render(100)
				.map(stripVTControlCharacters),
		).toEqual([" • Ran 2 commands"]);
	}
});

test("a new prompt gets its own eval summary line while earlier turn groups remain intact", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	await h.emit("before_agent_start");
	const bash = h.tools.get("bash")!;
	const evalTool = h.tools.get("eval")!;
	const oldArgs = { command: "echo old prompt" };
	await h.emit("tool_call", {
		toolName: "bash",
		toolCallId: "old",
		input: oldArgs,
	});
	const oldSummary = bash.renderCall?.(oldArgs, collapsed, theme);
	await h.emit("before_agent_start");
	const first = { language: "py", code: "print(1)" };
	await h.emit("tool_call", {
		toolName: "eval",
		toolCallId: "e1",
		input: first,
	});
	const summary = evalTool.renderCall?.(first, collapsed, theme);
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Evaluated 1 cell",
	]);
	const second = { language: "py", code: "print(2)" };
	await h.emit("turn_start");
	await h.emit("tool_call", {
		toolName: "eval",
		toolCallId: "e2",
		input: second,
	});
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Evaluated 2 cells",
	]);
	expect(evalTool.renderCall?.(second, collapsed, theme)).toBeUndefined();
	expect(
		evalTool.renderResult?.(nativeResult, collapsed, theme, first),
	).toBeUndefined();
	expect(
		evalTool.renderResult?.(nativeResult, collapsed, theme, second),
	).toBeUndefined();
	expect(oldSummary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command",
	]);
	expect(
		bash
			.renderCall?.(oldArgs, collapsed, theme)
			?.render(100)
			.map(stripVTControlCharacters),
	).toEqual([" • Ran 1 command"]);
	await h.emit("before_agent_start");
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Evaluated 2 cells",
	]);
});

test("mixed turn groups keep first-call ownership and bash-first wording in either execution order", async () => {
	for (const names of [
		["bash", "eval"],
		["eval", "bash"],
	]) {
		const h = harness();
		h.getAllTools.mockReturnValue(nativeTools());
		await h.emit("session_start");
		await h.emit("before_agent_start");
		const calls = names.map((name, index) => ({
			name,
			input:
				name === "bash"
					? { command: "echo mixed" }
					: { language: "py", code: "print(3)" },
			id: `mixed-${index}`,
		}));
		const owner = h.tools.get(calls[0].name)!;
		await h.emit("tool_call", {
			toolName: calls[0].name,
			toolCallId: calls[0].id,
			input: calls[0].input,
		});
		const summary = owner.renderCall?.(calls[0].input, collapsed, theme);
		await h.emit("tool_call", {
			toolName: calls[1].name,
			toolCallId: calls[1].id,
			input: calls[1].input,
		});
		expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
			" • Ran 1 command, evaluated 1 cell",
		]);
		const later = h.tools.get(calls[1].name)!;
		expect(
			later.renderCall?.(calls[1].input, collapsed, theme),
		).toBeUndefined();
		expect(
			later.renderResult?.(nativeResult, collapsed, theme, calls[1].input),
		).toBeUndefined();
		await h.emit("tool_call", {
			toolName: "bash",
			toolCallId: "b-extra",
			input: { command: "echo extra" },
		});
		expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
			" • Ran 2 commands, evaluated 1 cell",
		]);
		await h.emit("tool_call", {
			toolName: "eval",
			toolCallId: "e-extra",
			input: { language: "py", code: "print(4)" },
		});
		expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
			" • Ran 2 commands, evaluated 2 cells",
		]);
		expect(
			owner
				.renderCall?.(calls[0].input, collapsed, theme)
				?.render(100)
				.map(stripVTControlCharacters),
		).toEqual([" • Ran 2 commands, evaluated 2 cells"]);
	}
});

test("expanded mode restores every native card once and collapsing restores only the summary line", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	await h.emit("before_agent_start");
	const calls = [
		{
			name: "bash",
			input: { command: "printf bash-first" },
			source: "printf bash-first",
			output: "BASH-FIRST-OUTPUT",
			details: { exitCode: 0 },
		},
		{
			name: "eval",
			input: { language: "py", code: "print(12345)" },
			source: "print(12345)",
			output: "12345",
			details: {
				cells: [
					{
						index: 0,
						code: "print(12345)",
						output: "12345",
						status: "complete",
						language: "python",
					},
				],
			},
		},
		{
			name: "bash",
			input: { command: "printf bash-last" },
			source: "printf bash-last",
			output: "BASH-LAST-OUTPUT",
			details: { exitCode: 0 },
		},
	];
	for (const [index, call] of calls.entries()) {
		await h.emit("tool_call", {
			toolName: call.name,
			toolCallId: `expand-${index}`,
			input: call.input,
		});
	}
	for (let toggle = 0; toggle < 2; toggle++) {
		for (const [index, call] of calls.entries()) {
			const tool = h.tools.get(call.name)!;
			const result = {
				content: [{ type: "text" as const, text: call.output }],
				details: call.details,
			};
			const expanded = { expanded: true, isPartial: false };
			expect(tool.renderCall?.(call.input, expanded, theme)).toBeUndefined();
			const card = tool.renderResult?.(result, expanded, theme, call.input);
			expect(card).toBeDefined();
			const text = stripVTControlCharacters(card!.render(100).join("\n"));
			expect(text.split(call.source)).toHaveLength(2);
			expect(text).toContain(call.output);
			expect(text).not.toContain("Ran 2 commands");
			expect(
				tool
					.renderCall?.(call.input, collapsed, theme)
					?.render(100)
					.map(stripVTControlCharacters),
			).toEqual(
				index === 0 ? [" • Ran 2 commands, evaluated 1 cell"] : undefined,
			);
			expect(
				tool.renderResult?.(result, collapsed, theme, call.input),
			).toBeUndefined();
		}
	}
});

test("branch fallback resumes one summary line per user turn across bash, eval and mixed turn groups", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	const turns = [
		{
			calls: [
				{ name: "bash", arguments: { command: "echo same" } },
				{ name: "bash", arguments: { command: "echo same" } },
			],
			summary: " • Ran 2 commands",
		},
		{
			calls: [
				{ name: "eval", arguments: { language: "py", code: "print(1)" } },
				{ name: "eval", arguments: { language: "py", code: "print(2)" } },
			],
			summary: " • Evaluated 2 cells",
		},
		{
			calls: [
				{ name: "eval", arguments: { language: "py", code: "print(3)" } },
				{ name: "bash", arguments: { command: "echo same" } },
				{ name: "eval", arguments: { language: "py", code: "print(4)" } },
			],
			summary: " • Ran 1 command, evaluated 2 cells",
		},
	];
	for (const [turn, { calls }] of turns.entries()) {
		h.sessionManager.appendMessage({
			role: "user",
			content: `Prompt ${turn}`,
			timestamp: 0,
		});
		for (const [index, call] of calls.entries()) {
			h.sessionManager.appendMessage(
				assistantMessage(
					{ type: "toolCall", id: `${turn}-${index}`, ...call },
					{ type: "text", text: "Continuing this user turn" },
					{
						type: "toolCall",
						id: `read-${turn}-${index}`,
						name: "read",
						arguments: { path: "sample.txt" },
					},
				),
			);
		}
	}
	await h.emit("session_start");
	for (const { calls, summary } of turns) {
		for (const [index, call] of calls.entries()) {
			const tool = h.tools.get(call.name)!;
			expect(
				tool
					.renderCall?.(call.arguments, collapsed, theme)
					?.render(100)
					.map(stripVTControlCharacters),
			).toEqual(index === 0 ? [summary] : undefined);
			expect(
				tool.renderResult?.(nativeResult, collapsed, theme, call.arguments),
			).toBeUndefined();
		}
	}
});

test("branch fallback refreshes existing summary lines on message_end and observes tool_result without changing model output", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	const bash = h.tools.get("bash")!;
	const evalTool = h.tools.get("eval")!;
	const first = { command: "echo first" };
	h.sessionManager.appendMessage({
		role: "user",
		content: "Continue",
		timestamp: 0,
	});
	const message = assistantMessage({
		type: "toolCall",
		id: "b1",
		name: "bash",
		arguments: first,
	});
	h.sessionManager.appendMessage(message);
	await h.emit("message_end", { message });
	const summary = bash.renderCall?.(first, collapsed, theme);
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command",
	]);

	const second = { language: "py", code: "print(42)" };
	h.sessionManager.appendMessage(
		assistantMessage({
			type: "toolCall",
			id: "e1",
			name: "eval",
			arguments: second,
		}),
	);
	const result = Object.freeze({
		toolName: "eval",
		toolCallId: "e1",
		input: second,
		isError: false,
		content: Object.freeze([
			Object.freeze({
				type: "text",
				text: "complete stdout\\ncomplete stderr",
			}),
		]),
		details: Object.freeze({ untouched: "native details" }),
	});
	expect(await h.emit("tool_result", result)).toBeUndefined();
	expect(result.content).toEqual([
		{ type: "text", text: "complete stdout\\ncomplete stderr" },
	]);
	expect(result.details).toEqual({ untouched: "native details" });
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command, evaluated 1 cell",
	]);
	expect(evalTool.renderCall?.(second, collapsed, theme)).toBeUndefined();

	const third = { command: "echo third" };
	const lastMessage = assistantMessage({
		type: "toolCall",
		id: "b2",
		name: "bash",
		arguments: third,
	});
	h.sessionManager.appendMessage(lastMessage);
	await h.emit("message_end", { message: lastMessage });
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 commands, evaluated 1 cell",
	]);
	expect(
		bash
			.renderCall?.(first, collapsed, theme)
			?.render(100)
			.map(stripVTControlCharacters),
	).toEqual([" • Ran 2 commands, evaluated 1 cell"]);
	expect(bash.renderCall?.(third, collapsed, theme)).toBeUndefined();
});

test("live summary lines reconcile to completed branch totals across result, message and prompt boundaries", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	await h.emit("before_agent_start");
	h.sessionManager.appendMessage({
		role: "user",
		content: "First prompt",
		timestamp: 0,
	});
	const calls = [
		{
			name: "bash",
			arguments: { command: "printf first" },
		},
		{
			name: "eval",
			arguments: { language: "py", code: "print(17)" },
		},
		{
			name: "bash",
			arguments: { command: "printf third" },
		},
		{
			name: "eval",
			arguments: { language: "py", code: "print(29)" },
		},
	];
	const first = calls[0].arguments;
	const bash = h.tools.get("bash")!;
	await h.emit("tool_call", {
		toolName: "bash",
		toolCallId: "b1",
		input: first,
	});
	const summary = bash.renderCall?.(first, collapsed, theme);
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command",
	]);

	const message = assistantMessage(
		...calls.slice(0, 2).map((call, index) => ({
			type: "toolCall" as const,
			id: `call-${index}`,
			name: call.name,
			arguments: call.arguments,
		})),
	);
	h.sessionManager.appendMessage(message);
	await h.emit("message_end", { message });
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command",
	]);
	await h.emit("tool_call", {
		toolName: "eval",
		toolCallId: "e1",
		input: calls[1].arguments,
	});
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 command, evaluated 1 cell",
	]);
	for (let repaint = 0; repaint < 2; repaint++) {
		await h.emit("tool_result", {
			toolName: "eval",
			toolCallId: "e1",
			input: calls[1].arguments,
			...nativeResult,
			isError: false,
		});
		await h.emit("message_end", { message });
		expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
			" • Ran 1 command, evaluated 1 cell",
		]);
	}
	await h.emit("tool_call", {
		toolName: "bash",
		toolCallId: "b2",
		input: calls[2].arguments,
	});
	await h.emit("tool_result", {
		toolName: "bash",
		toolCallId: "b2",
		input: calls[2].arguments,
		...nativeResult,
		isError: false,
	});
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 commands, evaluated 1 cell",
	]);

	// The final persisted call has no live event, as on an interrupted tool batch.
	const finalMessage = assistantMessage(
		...calls.slice(2).map((call, index) => ({
			type: "toolCall" as const,
			id: `final-${index}`,
			name: call.name,
			arguments: call.arguments,
		})),
	);
	h.sessionManager.appendMessage(finalMessage);
	await h.emit("message_end", { message: finalMessage });
	await h.emit("before_agent_start");
	h.sessionManager.appendMessage({
		role: "user",
		content: "Next prompt",
		timestamp: 0,
	});
	const next = {
		name: "eval",
		arguments: { language: "py", code: "print(31)" },
	};
	await h.emit("tool_call", {
		toolName: "eval",
		toolCallId: "next",
		input: next.arguments,
	});
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 commands, evaluated 2 cells",
	]);
	expect(
		h.tools
			.get("eval")!
			.renderCall?.(next.arguments, collapsed, theme)
			?.render(100)
			.map(stripVTControlCharacters),
	).toEqual([" • Evaluated 1 cell"]);
	const nextMessage = assistantMessage({
		type: "toolCall",
		id: "next",
		name: "eval",
		arguments: next.arguments,
	});
	h.sessionManager.appendMessage(nextMessage);
	await h.emit("message_end", { message: nextMessage });
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 commands, evaluated 2 cells",
	]);
});

test("historical and resumed bash and eval cards expand fully and collapse to one summary line per turn group", async () => {
	const h = harness();
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	const calls = [
		{
			name: "bash",
			arguments: { command: "printf first" },
			source: "printf first",
		},
		{
			name: "eval",
			arguments: { language: "py", code: "print(17)" },
			source: "print(17)",
		},
		{
			name: "bash",
			arguments: { command: "printf third" },
			source: "printf third",
		},
		{
			name: "eval",
			arguments: { language: "py", code: "print(29)" },
			source: "print(29)",
		},
		{
			name: "eval",
			arguments: { language: "py", code: "print(31)" },
			source: "print(31)",
		},
	];
	for (const [turn, turnCalls] of [
		calls.slice(0, 4),
		calls.slice(4),
	].entries()) {
		await h.emit("before_agent_start");
		h.sessionManager.appendMessage({
			role: "user",
			content: `Historical prompt ${turn}`,
			timestamp: 0,
		});
		const message = assistantMessage(
			...turnCalls.map((call, index) => ({
				type: "toolCall" as const,
				id: `turn-${turn}-call-${index}`,
				name: call.name,
				arguments: call.arguments,
			})),
		);
		h.sessionManager.appendMessage(message);
		for (const [index, call] of turnCalls.entries()) {
			await h.emit("tool_call", {
				toolName: call.name,
				toolCallId: `turn-${turn}-call-${index}`,
				input: call.arguments,
			});
		}
		await h.emit("message_end", { message });
	}
	await h.emit("before_agent_start");

	const resumed = harness();
	resumed.getAllTools.mockReturnValue(nativeTools());
	for (const entry of h.sessionManager.getBranch()) {
		if (
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "assistant")
		) {
			resumed.sessionManager.appendMessage(structuredClone(entry.message));
		}
	}
	await resumed.emit("session_start");
	const resumedCalls = resumed.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content.filter((content) => content.type === "toolCall")
				: [],
		);
	for (const [session, history] of [
		[h, calls],
		[resumed, resumedCalls],
	] as const) {
		for (let toggle = 0; toggle < 2; toggle++) {
			for (const [index, call] of history.entries()) {
				const tool = session.tools.get(call.name)!;
				const expanded = { expanded: true, isPartial: false };
				const source = calls[index].source;
				const result = {
					...nativeResult,
					details:
						call.name === "bash"
							? { exitCode: 0 }
							: {
									cells: [
										{
											index: 0,
											code: source,
											output: "native output",
											status: "complete",
											language: "python",
										},
									],
								},
				};
				expect(
					tool.renderCall?.(call.arguments, expanded, theme),
				).toBeUndefined();
				const card = tool.renderResult?.(
					result,
					expanded,
					theme,
					call.arguments,
				);
				expect(card).toBeDefined();
				const text = stripVTControlCharacters(card!.render(100).join("\n"));
				expect(text.split(source)).toHaveLength(2);
				expect(text).toContain("native output");
				expect(
					tool
						.renderCall?.(call.arguments, collapsed, theme)
						?.render(100)
						.map(stripVTControlCharacters),
				).toEqual(
					index === 0
						? [" • Ran 2 commands, evaluated 2 cells"]
						: index === 4
							? [" • Evaluated 1 cell"]
							: undefined,
				);
				expect(
					tool.renderResult?.(result, collapsed, theme, call.arguments),
				).toBeUndefined();
			}
		}
	}
});

test("explicit theme styles every wording span around bold accent counts and uses its own bullet", async () => {
	const level = chalk.level;
	chalk.level = 3;
	try {
		const customTheme = new Theme(
			{ dim: "#112233", muted: "#445566", accent: "#778899" } as Record<
				ThemeColor,
				string
			>,
			{} as Record<ThemeBg, string>,
			"truecolor",
			"unicode",
			{ "format.bullet": "◆" },
		);
		const h = harness();
		h.getAllTools.mockReturnValue(nativeTools());
		await h.emit("session_start");
		const args = { language: "py", code: "print(1)" };
		await h.emit("tool_call", { toolName: "eval", input: args });
		const summary = h.tools.get("eval")!.renderCall!(
			args,
			collapsed,
			customTheme,
		);
		const prefix = ` ${customTheme.fg("dim", "◆")} `;
		const count = (n: number) =>
			customTheme.fg("accent", customTheme.bold(String(n)));
		expect(count(1)).toContain("\x1b[1m");
		expect(count(1)).toContain("\x1b[39m");
		expect(summary.render(100)).toEqual([
			prefix +
				customTheme.fg("muted", "Evaluated ") +
				count(1) +
				customTheme.fg("muted", " cell"),
		]);
		await h.emit("tool_call", { toolName: "bash", input: { command: "true" } });
		await h.emit("tool_call", { toolName: "bash", input: { command: "true" } });
		await h.emit("tool_call", { toolName: "eval", input: { code: "2" } });
		const expected =
			prefix +
			customTheme.fg("muted", "Ran ") +
			count(2) +
			customTheme.fg("muted", " commands") +
			customTheme.fg("muted", ", evaluated ") +
			count(2) +
			customTheme.fg("muted", " cells");
		expect(summary.render(100)).toEqual([expected]);
		expect(stripVTControlCharacters(summary.render(100)[0]!)).toBe(
			" ◆ Ran 2 commands, evaluated 2 cells",
		);
		for (const width of [1, 5, 12, 24]) {
			const rows = summary.render(width);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
		}
		expect(summary.render(100)).toEqual([expected]);
	} finally {
		chalk.level = level;
	}
});

test("real host trims raw ANSI summaries to one unfilled row through streaming, results, allocation and expansion", async () => {
	const level = chalk.level;
	chalk.level = 3;
	try {
		for (const name of ["bash", "eval"]) {
			const h = harness();
			h.getAllTools.mockReturnValue(nativeTools());
			await h.emit("session_start");
			const args =
				name === "bash"
					? { command: "printf HOST-OUTPUT" }
					: { language: "py", code: "print('HOST-OUTPUT')" };
			const tool = h.tools.get(name)!;
			const component = new ToolExecutionComponent(
				name,
				args,
				{ useBuiltInRenderer: false },
				// Host core types erase the extension Theme and execution context.
				tool as unknown as ConstructorParameters<
					typeof ToolExecutionComponent
				>[3],
				{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
			);
			expect(trimBlankEdges(component.render(100))).toHaveLength(0);
			await h.emit("tool_call", { toolName: name, input: args });
			component.setArgsComplete();
			component.setExecutionStarted();
			const expected =
				name === "bash" ? " • Ran 1 command" : " • Evaluated 1 cell";
			const check = (width = 100) => {
				const rows = trimBlankEdges(component.render(width));
				expect(rows).toHaveLength(1);
				expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
				if (width === 100)
					expect(stripVTControlCharacters(rows[0])).toBe(
						expected.padEnd(width),
					);
				for (const bg of [
					"toolPendingBg",
					"toolSuccessBg",
					"toolErrorBg",
				] as const) {
					const backgroundCode = theme.bg(bg, "X").split("X")[0];
					expect(backgroundCode).not.toBe("");
					expect(rows[0]).not.toContain(backgroundCode);
				}
			};
			check();
			component.setTranscriptAllocation(1, { tick: 0, now: 0 });
			check();
			check(10);
			check();
			for (const isError of [false, true]) {
				component.updateResult({
					content: [{ type: "text", text: "HOST-OUTPUT" }],
					details: name === "bash" ? { exitCode: isError ? 1 : 0 } : {},
					isError,
				});
				check();
				for (let toggle = 0; toggle < 2; toggle++) {
					component.setTranscriptAllocation(100, { tick: 0, now: 0 });
					component.setExpanded(true);
					const expanded = trimBlankEdges(component.render(100));
					expect(expanded.length).toBeGreaterThan(1);
					const text = stripVTControlCharacters(expanded.join("\n"));
					expect(text).toContain("HOST-OUTPUT");
					expect(text).not.toContain(expected);
					component.setExpanded(false);
					check();
					component.setTranscriptAllocation(1, { tick: 0, now: 0 });
					check(10);
					check();
				}
			}
		}
	} finally {
		chalk.level = level;
	}
});
