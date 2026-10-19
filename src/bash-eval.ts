import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import type { LiveTurnGroups } from "./summary";

type CompressibleTool = Omit<ToolDefinition, "renderCall" | "renderResult"> & {
	promptGuidelines?: string[];
	renderCall: (
		...args: Parameters<NonNullable<ToolDefinition["renderCall"]>>
	) => Component | undefined;
	renderResult: (
		...args: Parameters<NonNullable<ToolDefinition["renderResult"]>>
	) => Component | undefined;
};

export function registerBashEval(
	pi: ExtensionAPI,
	groups: LiveTurnGroups,
): void {
	for (const native of pi.getAllTools()) {
		if (native.name !== "bash" && native.name !== "eval") continue;
		const override: CompressibleTool = {
			name: native.name,
			label: native.name === "bash" ? "Bash" : "Eval",
			description: native.description,
			parameters: native.parameters,
			promptGuidelines: native.promptGuidelines,
			approval: "exec",
			loadMode: "essential",
			strict: true,
			execute(_id, params, signal, onUpdate, ctx) {
				// biome-ignore lint/style/noNonNullAssertion: Same-name overrides receive native delegation from OMP.
				return ctx.invokeTool!(params as Record<string, unknown>, {
					signal,
					onUpdate,
				});
			},
			renderCall(args, options) {
				return options.expanded ? undefined : groups.summary(args as object);
			},
			renderResult(result, options, theme, args) {
				if (!options.expanded) return undefined;
				if (native.name === "bash") {
					return bashToolRenderer.renderResult(
						result as Parameters<typeof bashToolRenderer.renderResult>[0],
						options,
						theme,
						args as Parameters<typeof bashToolRenderer.renderResult>[3],
					);
				}
				return evalToolRenderer.renderResult(
					result as Parameters<typeof evalToolRenderer.renderResult>[0],
					options,
					theme,
					args as Parameters<typeof evalToolRenderer.renderResult>[3],
				);
			},
		};
		// OMP supports undefined to suppress a card, although its declarations require Component.
		pi.registerTool(override as ToolDefinition);
	}
}
