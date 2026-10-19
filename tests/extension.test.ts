// biome-ignore-all lint/style/noNonNullAssertion: Required registrations and native cards are asserted at the ExtensionAPI seam.
import { expect, mock, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import ccStyleBashEval from "../src/index";

initThemeSync();

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
		async emit(type: string, event: Record<string, unknown> = {}) {
			for (const handler of handlers.get(type) ?? []) {
				await handler({ type, ...event }, {} as ExtensionContext);
			}
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
	expect(summary?.render(100)).toEqual(["Ran 1 command"]);
	const narrowSummary = summary!.render(10);
	expect(narrowSummary).toHaveLength(1);
	expect(visibleWidth(narrowSummary[0])).toBeLessThanOrEqual(10);
	expect(summary?.render(100)).toEqual(["Ran 1 command"]);
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
	expect(summary?.render(100)).toEqual(["Ran 2 commands"]);
	for (let repaint = 0; repaint < 2; repaint++) {
		expect(bash.renderCall?.(second, collapsed, theme)).toBeUndefined();
		expect(
			bash.renderResult?.(nativeResult, collapsed, theme, second),
		).toBeUndefined();
		expect(bash.renderCall?.(first, collapsed, theme)?.render(100)).toEqual([
			"Ran 2 commands",
		]);
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
	expect(summary?.render(100)).toEqual(["Evaluated 1 cell"]);
	const second = { language: "py", code: "print(2)" };
	await h.emit("turn_start");
	await h.emit("tool_call", {
		toolName: "eval",
		toolCallId: "e2",
		input: second,
	});
	expect(summary?.render(100)).toEqual(["Evaluated 2 cells"]);
	expect(evalTool.renderCall?.(second, collapsed, theme)).toBeUndefined();
	expect(
		evalTool.renderResult?.(nativeResult, collapsed, theme, first),
	).toBeUndefined();
	expect(
		evalTool.renderResult?.(nativeResult, collapsed, theme, second),
	).toBeUndefined();
	expect(oldSummary?.render(100)).toEqual(["Ran 1 command"]);
	expect(bash.renderCall?.(oldArgs, collapsed, theme)?.render(100)).toEqual([
		"Ran 1 command",
	]);
	await h.emit("before_agent_start");
	expect(summary?.render(100)).toEqual(["Evaluated 2 cells"]);
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
		expect(summary?.render(100)).toEqual(["Ran 1 command, evaluated 1 cell"]);
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
		expect(summary?.render(100)).toEqual(["Ran 2 commands, evaluated 1 cell"]);
		await h.emit("tool_call", {
			toolName: "eval",
			toolCallId: "e-extra",
			input: { language: "py", code: "print(4)" },
		});
		expect(summary?.render(100)).toEqual(["Ran 2 commands, evaluated 2 cells"]);
		expect(
			owner.renderCall?.(calls[0].input, collapsed, theme)?.render(100),
		).toEqual(["Ran 2 commands, evaluated 2 cells"]);
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
				tool.renderCall?.(call.input, collapsed, theme)?.render(100),
			).toEqual(index === 0 ? ["Ran 2 commands, evaluated 1 cell"] : undefined);
			expect(
				tool.renderResult?.(result, collapsed, theme, call.input),
			).toBeUndefined();
		}
	}
});
