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
import {
	isMountableUnderXdev,
	XDEV_KEEP_TOP_LEVEL,
} from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import {
	initThemeSync,
	Theme,
	type ThemeBg,
	type ThemeColor,
	theme,
} from "@oh-my-pi/pi-tui/theme";
import {
	type GlobToolDetails,
	globToolRenderer,
} from "@oh-my-pi/pi-tui/tools/glob";
import {
	type GrepToolDetails,
	grepToolRenderer,
} from "@oh-my-pi/pi-tui/tools/grep";
import chalk from "@oh-my-pi/pi-utils/chalk";
import ccStyleToolSummary from "../src/index";

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
	ccStyleToolSummary(api as unknown as ExtensionAPI);
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
			name: "grep",
			description: "Live content search",
			parameters: {
				type: "object",
				properties: { pattern: { type: "string" }, path: { type: "string" } },
			},
			promptGuidelines: ["Search before reading files."],
		},
		{
			name: "glob",
			description: "Native path search",
			parameters: { type: "object" },
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

type Call = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

function call(name: string, id: string): Call {
	return {
		type: "toolCall",
		id,
		name,
		arguments:
			name === "bash"
				? { command: "true" }
				: name === "eval"
					? { language: "py", code: "print(1)" }
					: { pattern: "needle", path: "src" },
	};
}

async function start(h = harness()) {
	h.getAllTools.mockReturnValue(nativeTools());
	await h.emit("session_start");
	return h;
}

async function record(h: ReturnType<typeof harness>, item: Call) {
	await h.emit("tool_call", {
		toolName: item.name,
		toolCallId: item.id,
		input: item.arguments,
	});
}

function summary(h: ReturnType<typeof harness>, item: Call, uiTheme = theme) {
	return h.tools.get(item.name)!.renderCall!(
		item.arguments,
		collapsed,
		uiTheme,
	);
}

function expectNoStateBg(rendered: string) {
	for (const bg of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const) {
		const code = theme.bg(bg, "X").split("X")[0];
		expect(code).not.toBe("");
		expect(rendered).not.toContain(code);
	}
}

test("v0.2 package loads ccStyleToolSummary through its declared extension entrypoint", async () => {
	const packageUrl = new URL("../package.json", import.meta.url);
	const metadata = await Bun.file(packageUrl).json();
	expect(metadata.name).toBe("cc-style-tool-summary");
	expect(metadata.version).toBe("0.2.0");
	expect(metadata.omp.extensions).toHaveLength(1);
	const entrypoint = new URL(metadata.omp.extensions[0], packageUrl);
	const { default: factory } = await import(entrypoint.href);
	expect(factory).toBe(ccStyleToolSummary);
	expect(factory).toBeInstanceOf(Function);
	expect(factory.name).toBe("ccStyleToolSummary");
});

test("session_start installs same-name overrides using live schemas and delegates native execution unchanged", async () => {
	const h = harness();
	expect(h.tools.size).toBe(0);
	expect(h.getAllTools).not.toHaveBeenCalled();
	const liveTools = nativeTools();
	h.getAllTools.mockReturnValue(liveTools);
	await h.emit("session_start");
	expect([...h.tools.keys()]).toEqual(["bash", "eval", "grep", "glob"]);

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

test("grep copies and refreshes live metadata while retaining top-level routing", async () => {
	const h = harness();
	await h.emit("session_start");
	expect(h.tools.size).toBe(0);
	const liveTools = nativeTools();
	const native = liveTools.find((tool) => tool.name === "grep")!;
	h.getAllTools.mockReturnValue(liveTools);
	await h.emit("session_start");
	const grep = h.tools.get("grep");
	expect(grep).toBeDefined();
	expect(grep!.description).toBe(native.description);
	expect(grep!.parameters).toBe(native.parameters);
	expect(grep!.promptGuidelines).toBe(native.promptGuidelines);
	expect(grep!.label).toBe("Grep");
	expect(grep!.loadMode).toBe("discoverable");
	expect(grep!.strict).toBe(true);
	expect(grep).not.toHaveProperty("mergeCallAndResult");
	expect(XDEV_KEEP_TOP_LEVEL.grep).toBe(true);
	expect(isMountableUnderXdev(grep!)).toBe(false);

	delete native.promptGuidelines;
	native.description = "Updated search contract";
	await h.emit("session_start");
	expect(h.tools.get("grep")!.promptGuidelines).toBeUndefined();
	expect(h.tools.get("grep")!.description).toBe("Updated search contract");
});

test("grep approval preserves native path aliases, SSH tiers and alias precedence", async () => {
	const h = await start();
	const grep = h.tools.get("grep")!;
	const approval = grep!.approval;
	if (typeof approval !== "function")
		throw new Error("Expected dynamic approval");
	for (const paths of [undefined, ".", "src", ["src", "tests"]]) {
		for (const alias of ["path", "paths"]) {
			expect(approval({ pattern: "needle", [alias]: paths })).toBe("read");
		}
	}
	expect(approval({ pattern: "needle" })).toBe("read");
	for (const paths of [
		"ssh://host/repo",
		["ssh://host/repo"],
		["src", "ssh://host/repo"],
		"ssh://one/repo;ssh://two/repo",
		"src;ssh://host/repo",
		["src;ssh://host/repo", "tests"],
	]) {
		for (const alias of ["path", "paths"]) {
			expect(approval({ pattern: "needle", [alias]: paths })).toBe("exec");
		}
	}
	expect(approval({ path: "src", paths: "ssh://host/repo" })).toBe("read");
	expect(approval({ path: undefined, paths: "ssh://host/repo" })).toBe("exec");
});

test("grep delegates native execution, progress and cancellation errors unchanged", async () => {
	const h = await start();
	const grep = h.tools.get("grep")!;

	const params = { pattern: "needle", path: ["src", "tests"] };
	const controller = new AbortController();
	const onUpdate = mock();
	const progress = { ...nativeResult, details: { matches: 2 } };
	const failure = new Error("native search cancelled");
	const invokeTool = mock(
		async (
			input: unknown,
			options: {
				signal: AbortSignal;
				onUpdate: typeof onUpdate;
			},
		) => {
			expect(input).toBe(params);
			expect(options.signal).toBe(controller.signal);
			expect(options.onUpdate).toBe(onUpdate);
			options.onUpdate(progress);
			if (options.signal.aborted) throw failure;
			return nativeResult;
		},
	);
	const ctx = { invokeTool } as unknown as ExtensionContext;
	expect(
		await grep!.execute("g1", params, controller.signal, onUpdate, ctx),
	).toBe(nativeResult);
	expect(onUpdate.mock.calls[0][0]).toBe(progress);
	controller.abort();
	await expect(
		grep!.execute("g2", params, controller.signal, onUpdate, ctx),
	).rejects.toBe(failure);
});

test("glob copies and refreshes live metadata without synthesizing unavailable tools", async () => {
	const h = harness();
	expect(h.tools.size).toBe(0);
	expect(h.getAllTools).not.toHaveBeenCalled();
	await h.emit("session_start");
	expect(h.tools.size).toBe(0);
	const native = nativeTools().find((tool) => tool.name === "glob")!;
	h.getAllTools.mockReturnValue([native]);
	await h.emit("session_start");
	const glob = h.tools.get("glob");
	expect(glob).toBeDefined();
	expect(glob!.description).toBe(native.description);
	expect(glob!.parameters).toBe(native.parameters);
	expect(glob!.promptGuidelines).toBeUndefined();
	expect(glob!.label).toBe("Glob");
	expect(glob!.loadMode).toBe("essential");
	expect(glob!.approval).toBe("read");
	expect(glob!.strict).toBe(true);
	expect(glob).not.toHaveProperty("mergeCallAndResult");
	native.description = "Updated path search contract";
	native.parameters = {
		type: "object",
		properties: { path: { type: "string" } },
	} as ToolInfo["parameters"];
	native.promptGuidelines = ["Use paths to locate files."];
	await h.emit("session_start");
	expect(h.tools.get("glob")!.description).toBe(native.description);
	expect(h.tools.get("glob")!.parameters).toBe(native.parameters);
	expect(h.tools.get("glob")!.promptGuidelines).toBe(native.promptGuidelines);
	delete native.promptGuidelines;
	await h.emit("session_start");
	expect(h.tools.get("glob")!.promptGuidelines).toBeUndefined();
});

test("glob delegates identical arguments, streaming updates, cancellation and higher-tier refusal unchanged", async () => {
	const h = await start();
	const glob = h.tools.get("glob")!;
	const params = { path: "src/**/*.ts", hidden: true, limit: 20 };
	const controller = new AbortController();
	const onUpdate = mock();
	const updates = [
		{ ...nativeResult, details: { fileCount: 1 } },
		{ ...nativeResult, details: { fileCount: 8 } },
	];
	const cancelled = new Error("native glob cancelled");
	const refusal = new Error(
		"URL requires exec approval; glob has read approval",
	);
	const invokeTool = async (
		input: unknown,
		options: { signal: AbortSignal; onUpdate: typeof onUpdate },
	) => {
		expect(input).toBe(params);
		expect(options.signal).toBe(controller.signal);
		expect(options.onUpdate).toBe(onUpdate);
		if (options.signal.aborted) throw cancelled;
		if (params.path.startsWith("ssh://")) throw refusal;
		for (const update of updates) options.onUpdate(update);
		return nativeResult;
	};
	const ctx = { invokeTool } as unknown as ExtensionContext;
	expect(
		await glob.execute("scan", params, controller.signal, onUpdate, ctx),
	).toBe(nativeResult);
	expect(onUpdate.mock.calls).toEqual(updates.map((update) => [update]));
	expect(onUpdate.mock.calls[0][0]).toBe(updates[0]);
	expect(onUpdate.mock.calls[1][0]).toBe(updates[1]);
	params.path = "ssh://host/repo/**";
	await expect(
		glob.execute("refused", params, controller.signal, onUpdate, ctx),
	).rejects.toBe(refusal);
	controller.abort();
	await expect(
		glob.execute("cancelled", params, controller.signal, onUpdate, ctx),
	).rejects.toBe(cancelled);
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
		" • Ran 1 bash command",
	]);
	const narrowSummary = summary!.render(10);
	expect(narrowSummary).toHaveLength(1);
	expect(visibleWidth(narrowSummary[0])).toBeLessThanOrEqual(10);
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 bash command",
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
		" • Ran 2 bash commands",
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
		).toEqual([" • Ran 2 bash commands"]);
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
		" • Ran 1 bash command",
	]);
	expect(
		bash
			.renderCall?.(oldArgs, collapsed, theme)
			?.render(100)
			.map(stripVTControlCharacters),
	).toEqual([" • Ran 1 bash command"]);
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
			" • Ran 1 bash command, evaluated 1 cell",
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
			" • Ran 2 bash commands, evaluated 1 cell",
		]);
		await h.emit("tool_call", {
			toolName: "eval",
			toolCallId: "e-extra",
			input: { language: "py", code: "print(4)" },
		});
		expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
			" • Ran 2 bash commands, evaluated 2 cells",
		]);
		expect(
			owner
				.renderCall?.(calls[0].input, collapsed, theme)
				?.render(100)
				.map(stripVTControlCharacters),
		).toEqual([" • Ran 2 bash commands, evaluated 2 cells"]);
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
			expect(text).not.toContain("Ran 2 bash commands");
			expect(
				tool
					.renderCall?.(call.input, collapsed, theme)
					?.render(100)
					.map(stripVTControlCharacters),
			).toEqual(
				index === 0 ? [" • Ran 2 bash commands, evaluated 1 cell"] : undefined,
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
			summary: " • Ran 2 bash commands",
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
			summary: " • Ran 1 bash command, evaluated 2 cells",
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
		" • Ran 1 bash command",
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
		" • Ran 1 bash command, evaluated 1 cell",
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
		" • Ran 2 bash commands, evaluated 1 cell",
	]);
	expect(
		bash
			.renderCall?.(first, collapsed, theme)
			?.render(100)
			.map(stripVTControlCharacters),
	).toEqual([" • Ran 2 bash commands, evaluated 1 cell"]);
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
		" • Ran 1 bash command",
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
		" • Ran 1 bash command",
	]);
	await h.emit("tool_call", {
		toolName: "eval",
		toolCallId: "e1",
		input: calls[1].arguments,
	});
	expect(summary?.render(100).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 bash command, evaluated 1 cell",
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
			" • Ran 1 bash command, evaluated 1 cell",
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
		" • Ran 2 bash commands, evaluated 1 cell",
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
		" • Ran 2 bash commands, evaluated 2 cells",
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
		" • Ran 2 bash commands, evaluated 2 cells",
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
						? [" • Ran 2 bash commands, evaluated 2 cells"]
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
		expect(summary.render(100)).toEqual([
			prefix +
				customTheme.fg("muted", "Ran ") +
				count(1) +
				customTheme.fg("muted", " bash command") +
				customTheme.fg("muted", ", ") +
				customTheme.fg("muted", "evaluated ") +
				count(1) +
				customTheme.fg("muted", " cell"),
		]);
		expect(stripVTControlCharacters(summary.render(100)[0]!)).toBe(
			" ◆ Ran 1 bash command, evaluated 1 cell",
		);
		await h.emit("tool_call", { toolName: "bash", input: { command: "true" } });
		await h.emit("tool_call", { toolName: "eval", input: { code: "2" } });
		const expected =
			prefix +
			customTheme.fg("muted", "Ran ") +
			count(2) +
			customTheme.fg("muted", " bash commands") +
			customTheme.fg("muted", ", ") +
			customTheme.fg("muted", "evaluated ") +
			count(2) +
			customTheme.fg("muted", " cells");
		expect(summary.render(100)).toEqual([expected]);
		expect(stripVTControlCharacters(summary.render(100)[0]!)).toBe(
			" ◆ Ran 2 bash commands, evaluated 2 cells",
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
			const args: Record<string, string> =
				name === "bash"
					? { command: "printf HOST-OUTPUT" }
					: { language: "py", code: "print('HOST-OUTPUT')" };
			const tool = h.tools.get(name)!;
			const createCard = (callArgs: Record<string, string>) =>
				new ToolExecutionComponent(
					name,
					callArgs,
					{ useBuiltInRenderer: false },
					// Host core types erase the extension Theme and execution context.
					tool as unknown as ConstructorParameters<
						typeof ToolExecutionComponent
					>[3],
					{
						requestRender() {},
						requestComponentRender() {},
						resetDisplay() {},
					},
				);
			const component = createCard(args);
			const components = [component];
			expect(trimBlankEdges(component.render(100))).toHaveLength(0);
			await h.emit("tool_call", { toolName: name, input: args });
			component.setArgsComplete();
			component.setExecutionStarted();
			let expected =
				name === "bash" ? " • Ran 1 bash command" : " • Evaluated 1 cell";
			const check = (width = 100) => {
				const rows = trimBlankEdges(component.render(width));
				expect(rows).toHaveLength(1);
				expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
				if (width === 100)
					expect(stripVTControlCharacters(rows[0])).toBe(
						expected.padEnd(width),
					);
				expectNoStateBg(rows[0]);
				for (const later of components.slice(1)) {
					expect(trimBlankEdges(later.render(width))).toHaveLength(0);
				}
			};
			const checkExpanded = (
				card: ToolExecutionComponent,
				expectedOutput: string,
			) => {
				card.setTranscriptAllocation(100, { tick: 0, now: 0 });
				card.setExpanded(true);
				const expanded = trimBlankEdges(card.render(100));
				expect(expanded.length).toBeGreaterThan(1);
				const text = stripVTControlCharacters(expanded.join("\n"));
				expect(text).toContain(expectedOutput);
				expect(text).not.toContain(expected);
				card.setExpanded(false);
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
					checkExpanded(component, "HOST-OUTPUT");
					check();
					component.setTranscriptAllocation(1, { tick: 0, now: 0 });
					check(10);
					check();
				}
			}
			check(10);
			const laterArgs: Record<string, string> =
				name === "bash"
					? { command: "printf LATER-OUTPUT" }
					: { language: "py", code: "print('LATER-OUTPUT')" };
			const later = createCard(laterArgs);
			await h.emit("tool_call", { toolName: name, input: laterArgs });
			later.setArgsComplete();
			later.setExecutionStarted();
			components.push(later);
			expected =
				name === "bash" ? " • Ran 2 bash commands" : " • Evaluated 2 cells";
			check(10);
			check();
			later.setTranscriptAllocation(1, { tick: 0, now: 0 });
			check();
			later.updateResult({
				content: [{ type: "text", text: "LATER-OUTPUT" }],
				details: name === "bash" ? { exitCode: 0 } : {},
				isError: false,
			});
			check();
			for (let toggle = 0; toggle < 2; toggle++) {
				for (const [index, card] of components.entries()) {
					checkExpanded(card, index === 0 ? "HOST-OUTPUT" : "LATER-OUTPUT");
				}
				check();
				for (const card of components) {
					card.setTranscriptAllocation(1, { tick: 0, now: 0 });
				}
				check(10);
				check();
			}
		}
	} finally {
		chalk.level = level;
	}
});

test.each([
	[["bash"], " • Ran 1 bash command"],
	[["eval"], " • Evaluated 1 cell"],
	[["grep"], " • Grepped 1 pattern"],
	[["eval", "bash"], " • Ran 1 bash command, evaluated 1 cell"],
	[["grep", "bash"], " • Ran 1 bash command, grepped 1 pattern"],
	[["eval", "grep"], " • Evaluated 1 cell, grepped 1 pattern"],
	[
		["grep", "eval", "bash"],
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern",
	],
	[["bash", "bash"], " • Ran 2 bash commands"],
	[["eval", "eval"], " • Evaluated 2 cells"],
	[["grep", "grep"], " • Grepped 2 patterns"],
	[
		["bash", "eval", "bash", "eval"],
		" • Ran 2 bash commands, evaluated 2 cells",
	],
	[
		["bash", "grep", "grep", "bash"],
		" • Ran 2 bash commands, grepped 2 patterns",
	],
	[
		["grep", "eval", "grep", "eval"],
		" • Evaluated 2 cells, grepped 2 patterns",
	],
	[
		["eval", "grep", "bash", "grep", "bash", "eval"],
		" • Ran 2 bash commands, evaluated 2 cells, grepped 2 patterns",
	],
	[["glob"], " • Globbed 1 pattern"],
	[["glob", "bash"], " • Ran 1 bash command, globbed 1 pattern"],
	[["glob", "eval"], " • Evaluated 1 cell, globbed 1 pattern"],
	[["glob", "grep"], " • Grepped 1 pattern, globbed 1 pattern"],
	[
		["eval", "glob", "bash"],
		" • Ran 1 bash command, evaluated 1 cell, globbed 1 pattern",
	],
	[
		["grep", "glob", "bash"],
		" • Ran 1 bash command, grepped 1 pattern, globbed 1 pattern",
	],
	[
		["glob", "grep", "eval"],
		" • Evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	],
	[
		["glob", "grep", "eval", "bash"],
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	],
	[
		["bash", "glob", "grep", "eval"],
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	],
	[
		["grep", "eval", "glob", "bash"],
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	],
	[["glob", "glob"], " • Globbed 2 patterns"],
	[
		["bash", "glob", "glob", "bash"],
		" • Ran 2 bash commands, globbed 2 patterns",
	],
	[
		["eval", "glob", "eval", "glob"],
		" • Evaluated 2 cells, globbed 2 patterns",
	],
	[
		["grep", "glob", "glob", "grep"],
		" • Grepped 2 patterns, globbed 2 patterns",
	],
	[
		["glob", "eval", "bash", "eval", "bash", "glob"],
		" • Ran 2 bash commands, evaluated 2 cells, globbed 2 patterns",
	],
	[
		["glob", "grep", "bash", "glob", "bash", "grep"],
		" • Ran 2 bash commands, grepped 2 patterns, globbed 2 patterns",
	],
	[
		["eval", "glob", "grep", "grep", "glob", "eval"],
		" • Evaluated 2 cells, grepped 2 patterns, globbed 2 patterns",
	],
	[
		["eval", "glob", "grep", "bash", "grep", "glob", "bash", "eval"],
		" • Ran 2 bash commands, evaluated 2 cells, grepped 2 patterns, globbed 2 patterns",
	],
] as [string[], string][])(
	"turn group %j has fixed wording and first-call ownership",
	async (names, expected) => {
		const h = await start();
		await h.emit("before_agent_start");
		const calls = names.map((name, index) => call(name, `call-${index}`));
		await record(h, calls[0]);
		const owner = summary(h, calls[0]);
		expect(owner).toBeDefined();
		for (const item of calls.slice(1)) {
			await record(h, item);
			expect(summary(h, item)).toBeUndefined();
		}
		for (const item of calls) {
			for (const isPartial of [true, false]) {
				expect(
					h.tools.get(item.name)!.renderResult!(
						nativeResult,
						{ ...collapsed, isPartial },
						theme,
						item.arguments,
					),
				).toBeUndefined();
			}
		}
		expect(owner?.render(120).map(stripVTControlCharacters)).toEqual([
			expected,
		]);
	},
);

test("glob-owned summary line updates after completion across internal turns and isolates new prompts", async () => {
	const h = await start();
	const first = call("glob", "first");
	expect(summary(h, first)).toBeUndefined();
	await h.emit("before_agent_start");
	await record(h, first);
	const owner = summary(h, first);
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Globbed 1 pattern",
	]);
	await h.emit("tool_result", {
		toolName: "glob",
		input: first.arguments,
		...nativeResult,
	});
	await h.emit("turn_start", { turnIndex: 1 });
	await h.emit("message_end", {
		message: assistantMessage({
			type: "text",
			text: "Continuing the same prompt",
		}),
	});
	for (const name of ["read", "find", "web_search"]) {
		await record(h, call(name, name));
	}
	await record(h, call("bash", "bash-1"));
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 bash command, globbed 1 pattern",
	]);
	for (const name of ["grep", "bash", "eval", "grep", "grep"]) {
		await record(h, call(name, `later-${name}`));
	}
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 bash commands, evaluated 1 cell, grepped 3 patterns, globbed 1 pattern",
	]);
	await h.emit("before_agent_start");
	const next = call("grep", "next");
	await record(h, next);
	expect(summary(h, next).render(120).map(stripVTControlCharacters)).toEqual([
		" • Grepped 1 pattern",
	]);
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Ran 2 bash commands, evaluated 1 cell, grepped 3 patterns, globbed 1 pattern",
	]);
});

test("four-tool theme segments restore current counts and muted wording after narrow renders", async () => {
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
		const h = await start();
		const first = call("glob", "first");
		await record(h, first);
		const owner = summary(h, first, customTheme);
		const dim = (text: string) => customTheme.fg("dim", text);
		const muted = (text: string) => customTheme.fg("muted", text);
		const count = (n: number) =>
			customTheme.fg("accent", customTheme.bold(String(n)));
		expect(owner.render(120)).toEqual([
			` ${dim("◆")} ${muted("Globbed ")}${count(1)}${muted(" pattern")}`,
		]);
		for (const name of [
			"eval",
			"grep",
			"bash",
			"grep",
			"eval",
			"bash",
			"glob",
			"grep",
		]) {
			await record(h, call(name, name));
			for (const width of [1, 5, 12, 24]) {
				const rows = owner.render(width);
				expect(rows).toHaveLength(1);
				expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
			}
		}
		expect(owner.render(120)).toEqual([
			` ${dim("◆")} ${muted("Ran ")}${count(2)}${muted(" bash commands")}${muted(", ")}${muted("evaluated ")}${count(2)}${muted(" cells")}${muted(", ")}${muted("grepped ")}${count(3)}${muted(" patterns")}${muted(", ")}${muted("globbed ")}${count(2)}${muted(" patterns")}`,
		]);
		expect(stripVTControlCharacters(owner.render(120)[0])).toBe(
			" ◆ Ran 2 bash commands, evaluated 2 cells, grepped 3 patterns, globbed 2 patterns",
		);
	} finally {
		chalk.level = level;
	}
});

test("four-tool branch fallback replays initial, empty, glob-only and mixed user turn groups by argument identity", async () => {
	const h = harness();
	const initial = call("glob", "initial");
	h.sessionManager.appendMessage(assistantMessage(initial));
	h.sessionManager.appendMessage({
		role: "user",
		content: "Search twice",
		timestamp: 1,
	});
	const searches = [call("glob", "g1"), call("glob", "g2")];
	expect(searches[0].arguments).toEqual(searches[1].arguments);
	expect(searches[0].arguments).not.toBe(searches[1].arguments);
	h.sessionManager.appendMessage(
		assistantMessage(
			searches[0],
			{ type: "text", text: "More searching" },
			call("read", "read"),
			searches[1],
		),
	);
	h.sessionManager.appendMessage({
		role: "user",
		content: "Empty turn",
		timestamp: 2,
	});
	h.sessionManager.appendMessage({
		role: "user",
		content: "Mixed turn",
		timestamp: 3,
	});
	const mixed = [
		call("glob", "glob-first"),
		call("grep", "g3"),
		call("eval", "e1"),
		call("bash", "b1"),
		call("grep", "g4"),
	];
	h.sessionManager.appendMessage(
		assistantMessage(...mixed, call("find", "find")),
	);
	await start(h);
	expect(summary(h, initial).render(120).map(stripVTControlCharacters)).toEqual(
		[" • Globbed 1 pattern"],
	);
	expect(
		summary(h, searches[0]).render(120).map(stripVTControlCharacters),
	).toEqual([" • Globbed 2 patterns"]);
	expect(
		summary(h, mixed[0]).render(120).map(stripVTControlCharacters),
	).toEqual([
		" • Ran 1 bash command, evaluated 1 cell, grepped 2 patterns, globbed 1 pattern",
	]);
	for (const item of [searches[1], ...mixed.slice(1)]) {
		expect(summary(h, item)).toBeUndefined();
	}
	expect(summary(h, call("glob", "equal-but-unknown"))).toBeUndefined();
});

test("four-tool branch fallback refreshes held summary lines on message_end and read-only tool_result", async () => {
	const h = harness();
	h.sessionManager.appendMessage({
		role: "user",
		content: "Search",
		timestamp: 1,
	});
	const first = call("glob", "first");
	h.sessionManager.appendMessage(assistantMessage(first));
	await start(h);
	const owner = summary(h, first);
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Globbed 1 pattern",
	]);
	const message = assistantMessage(
		call("bash", "b1"),
		call("eval", "e1"),
		call("grep", "g2"),
	);
	h.sessionManager.appendMessage(message);
	await h.emit("message_end", { message });
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	]);
	const third = call("glob", "g3");
	h.sessionManager.appendMessage(assistantMessage(third));
	const result = {
		toolName: "glob",
		toolCallId: third.id,
		input: third.arguments,
		content: Object.freeze([
			{ type: "text", text: "full model-visible search output" },
		]),
		details: Object.freeze({ fileCount: 12 }),
		isError: false,
	};
	const before = structuredClone(result);
	for (let rebuild = 0; rebuild < 2; rebuild++) {
		expect(await h.emit("tool_result", Object.freeze(result))).toBeUndefined();
		expect(result).toEqual(before);
		expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
			" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 2 patterns",
		]);
		expect(summary(h, third)).toBeUndefined();
	}
});

test("four-tool groups reconcile active-live, branch and retained-live membership without crossing prompts", async () => {
	const h = await start();
	await h.emit("before_agent_start");
	h.sessionManager.appendMessage({
		role: "user",
		content: "First prompt",
		timestamp: 1,
	});
	const first = call("glob", "first");
	const second = call("eval", "second");
	const third = call("grep", "third");
	await record(h, first);
	const owner = summary(h, first);
	h.sessionManager.appendMessage(assistantMessage(first, second));
	await h.emit("message_end");
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Globbed 1 pattern",
	]);
	await record(h, second);
	await record(h, third);
	for (let rebuild = 0; rebuild < 2; rebuild++) {
		await h.emit("message_end");
		await h.emit("tool_result", {
			toolName: "grep",
			input: third.arguments,
			...nativeResult,
		});
		expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
			" • Evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
		]);
	}
	h.sessionManager.appendMessage(
		assistantMessage(
			third,
			call("bash", "persisted-only"),
			call("glob", "persisted-glob"),
		),
	);
	await h.emit("tool_result", {
		toolName: "grep",
		input: third.arguments,
		...nativeResult,
	});
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	]);
	await h.emit("before_agent_start");
	h.sessionManager.appendMessage({
		role: "user",
		content: "Next prompt",
		timestamp: 2,
	});
	const next = call("grep", "next");
	await record(h, next);
	const nextOwner = summary(h, next);
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 2 patterns",
	]);
	expect(nextOwner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Grepped 1 pattern",
	]);
	h.sessionManager.appendMessage(assistantMessage(next));
	await h.emit("message_end");
	const getBranch = h.sessionManager.getBranch.bind(h.sessionManager);
	h.sessionManager.getBranch = () => [];
	await h.emit("tool_result");
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Evaluated 1 cell, grepped 1 pattern, globbed 1 pattern",
	]);
	expect(nextOwner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Grepped 1 pattern",
	]);
	h.sessionManager.getBranch = getBranch;
	await h.emit("message_end");
	expect(owner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 2 patterns",
	]);
	expect(nextOwner.render(120).map(stripVTControlCharacters)).toEqual([
		" • Grepped 1 pattern",
	]);
});

function searchResult(
	text: string,
	details: GrepToolDetails | GlobToolDetails = {},
	isError = false,
) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

const grepResults = [
	searchResult("# src/one.ts\n*1│needle\n\n# src/two.ts\n*2│needle", {
		matchCount: 2,
		fileCount: 2,
	}),
	searchResult("No matches found", { matchCount: 0, fileCount: 0 }),
	searchResult("No matches found"),
	searchResult("native grep failure", {}, true),
	searchResult("model detail", { error: "native detailed failure" }),
];

const globResults = [
	searchResult("src/one.ts", { fileCount: 1, files: ["src/one.ts"] }),
	searchResult("src/one.ts\nsrc/two.ts", {
		fileCount: 2,
		files: ["src/one.ts", "src/two.ts"],
		scopePath: "src",
	}),
	searchResult("limited scan", {
		fileCount: 2,
		files: ["src/one.ts", "src/two.ts"],
		truncated: true,
		resultLimitReached: 2,
		missingPaths: ["missing"],
	}),
	searchResult("No files found", { fileCount: 0, files: [] }),
	searchResult("Scan timed out", { fileCount: 0, files: [], timedOut: true }),
	searchResult("Legacy timeout", { fileCount: 0, files: [], truncated: true }),
	searchResult("No files matching pattern"),
	searchResult(""),
	searchResult("legacy/one.ts\nlegacy/two.ts"),
	searchResult("native glob failure", {}, true),
	searchResult("model detail", { error: "native detailed glob failure" }),
];

function host(h: ReturnType<typeof harness>, item: Call, native = false) {
	return new ToolExecutionComponent(
		item.name,
		item.arguments,
		{ useBuiltInRenderer: native },
		native
			? undefined
			: (h.tools.get(item.name)! as unknown as ConstructorParameters<
					typeof ToolExecutionComponent
				>[3]),
		{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
	);
}

async function mountTurnGroup(
	names: string[],
	replay: boolean,
	fullWidth: number,
) {
	const h = harness();
	const calls = names.map((name, index) => call(name, `host-${index}`));
	if (replay) {
		h.sessionManager.appendMessage({
			role: "user",
			content: "Saved search",
			timestamp: 1,
		});
		h.sessionManager.appendMessage(assistantMessage(...calls));
	}
	await start(h);
	const cards: ToolExecutionComponent[] = [];
	for (const item of calls) {
		const card = host(h, item);
		if (!replay) {
			expect(trimBlankEdges(card.render(fullWidth))).toHaveLength(0);
			await record(h, item);
		}
		card.setArgsComplete();
		card.setExecutionStarted();
		cards.push(card);
	}
	return { h, calls, cards };
}

function expectCollapsedTurnGroup(
	cards: ToolExecutionComponent[],
	expected: string,
	width: number,
	fullWidth: number,
) {
	for (const [index, card] of cards.entries()) {
		const rows = trimBlankEdges(card.render(width));
		expect(rows).toHaveLength(index === 0 ? 1 : 0);
		if (index === 0) {
			expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
			if (width === fullWidth)
				expect(stripVTControlCharacters(rows[0])).toBe(
					expected.padEnd(fullWidth),
				);
		}
		expectNoStateBg(rows.join("\n"));
	}
}

function expectExpandedHostResult(
	h: ReturnType<typeof harness>,
	item: Call,
	card: ToolExecutionComponent,
	result: ReturnType<typeof searchResult>,
	fullWidth: number,
	isPartial = false,
) {
	card.setTranscriptAllocation(fullWidth, { tick: 0, now: 0 });
	card.setExpanded(true);
	if (item.name === "grep" || item.name === "glob") {
		const native = host(h, item, true);
		native.setArgsComplete();
		native.setExecutionStarted();
		native.updateResult(result, isPartial);
		native.setExpanded(true);
		native.setTranscriptAllocation(fullWidth, { tick: 0, now: 0 });
		for (const width of [fullWidth, 18, fullWidth]) {
			const rows = trimBlankEdges(card.render(width));
			expect(rows).toEqual(trimBlankEdges(native.render(width)));
			expectNoStateBg(rows.join("\n"));
		}
	} else {
		expect(card.render(fullWidth).join("\n")).toContain("native output");
	}
	card.setExpanded(false);
	card.setTranscriptAllocation(1, { tick: 0, now: 0 });
}

test.each([
	["grep", grepResults, grepToolRenderer, " • Grepped 2 patterns"],
	["glob", globResults, globToolRenderer, " • Globbed 2 patterns"],
] as const)(
	"expanded %s restores native partial, normal, empty and error results for first and later live and replayed calls",
	async (name, results, renderer, expectedSummary) => {
		const level = chalk.level;
		chalk.level = 3;
		try {
			for (const replay of [false, true]) {
				const h = harness();
				const calls = [call(name, "first"), call(name, "later")];
				const args = {
					pattern: "needle.*",
					paths: ["src", "tests"],
					case: false,
					skip: 2,
				};
				for (const item of calls) item.arguments = { ...args };
				if (replay) h.sessionManager.appendMessage(assistantMessage(...calls));
				await start(h);
				if (!replay) for (const item of calls) await record(h, item);
				for (let toggle = 0; toggle < 2; toggle++) {
					for (const item of calls) {
						const tool = h.tools.get(name)!;
						for (const result of results) {
							for (const isPartial of [true, false]) {
								const options = { expanded: true, isPartial };
								expect(
									tool.renderCall!(item.arguments, options, theme),
								).toBeUndefined();
								const actual = tool.renderResult!(
									result,
									options,
									theme,
									item.arguments,
								);
								const native = renderer.renderResult(
									result,
									options,
									theme,
									args,
								);
								for (const width of [100, 18, 100]) {
									expect(actual.render(width)).toEqual(native.render(width));
								}
								expect(
									tool.renderResult!(
										result,
										{ ...collapsed, isPartial },
										theme,
										item.arguments,
									),
								).toBeUndefined();
							}
						}
					}
					expect(
						summary(h, calls[0]).render(100).map(stripVTControlCharacters),
					).toEqual([expectedSummary]);
					expect(summary(h, calls[1])).toBeUndefined();
				}
			}
		} finally {
			chalk.level = level;
		}
	},
);

test.each([false, true])(
	"real host preserves grep inline layout and one-row turn groups through expansion and resize (replay=%s)",
	async (replay) => {
		const level = chalk.level;
		chalk.level = 3;
		try {
			for (const [names, expected] of [
				[["grep"], " • Grepped 1 pattern"],
				[
					["grep", "bash", "eval", "grep"],
					" • Ran 1 bash command, evaluated 1 cell, grepped 2 patterns",
				],
				[
					["bash", "grep", "eval"],
					" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern",
				],
			] as [string[], string][]) {
				const { h, calls, cards } = await mountTurnGroup(names, replay, 100);
				const checkCollapsed = (width: number) =>
					expectCollapsedTurnGroup(cards, expected, width, 100);
				checkCollapsed(100);
				for (const card of cards)
					card.setTranscriptAllocation(1, { tick: 0, now: 0 });
				checkCollapsed(100);
				for (const result of grepResults) {
					for (const [index, card] of cards.entries()) {
						card.updateResult(
							calls[index].name === "grep"
								? result
								: { ...nativeResult, isError: false },
						);
					}
					checkCollapsed(100);
					for (let toggle = 0; toggle < 2; toggle++) {
						for (const [index, card] of cards.entries()) {
							expectExpandedHostResult(
								h,
								calls[index],
								card,
								calls[index].name === "grep"
									? result
									: { ...nativeResult, isError: false },
								100,
							);
						}
						checkCollapsed(18);
						checkCollapsed(100);
					}
				}
			}
		} finally {
			chalk.level = level;
		}
	},
);

test.each([false, true])(
	"real host keeps glob streaming groups compact and native expansion inline (replay=%s)",
	async (replay) => {
		const level = chalk.level;
		chalk.level = 3;
		try {
			for (const names of [
				["glob", "grep", "eval", "bash", "glob"],
				["bash", "glob", "eval", "grep", "glob"],
			]) {
				const { h, calls, cards } = await mountTurnGroup(names, replay, 120);
				const expected =
					" • Ran 1 bash command, evaluated 1 cell, grepped 1 pattern, globbed 2 patterns";
				const checkCollapsed = (width: number) =>
					expectCollapsedTurnGroup(cards, expected, width, 120);
				checkCollapsed(120);
				for (const card of cards)
					card.setTranscriptAllocation(1, { tick: 0, now: 0 });
				checkCollapsed(120);
				const updates: [ReturnType<typeof searchResult>, boolean][] = [
					[globResults[0], true],
					[globResults[1], true],
					...globResults.map((result): [typeof result, boolean] => [
						result,
						false,
					]),
				];
				for (const [result, isPartial] of updates) {
					for (const [index, card] of cards.entries()) {
						card.updateResult(
							calls[index].name === "glob"
								? result
								: { ...nativeResult, isError: false },
							isPartial,
						);
					}
					checkCollapsed(120);
					for (let toggle = 0; toggle < 2; toggle++) {
						for (const [index, card] of cards.entries()) {
							expectExpandedHostResult(
								h,
								calls[index],
								card,
								calls[index].name === "glob"
									? result
									: { ...nativeResult, isError: false },
								120,
								isPartial,
							);
						}
						checkCollapsed(18);
						checkCollapsed(120);
					}
				}
			}
		} finally {
			chalk.level = level;
		}
	},
);
