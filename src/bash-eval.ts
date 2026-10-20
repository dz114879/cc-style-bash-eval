import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { Component } from "@oh-my-pi/pi-tui";
import { markFramedBlockComponent, toPathList } from "@oh-my-pi/pi-tui/render";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import { globToolRenderer } from "@oh-my-pi/pi-tui/tools/glob";
import { grepToolRenderer } from "@oh-my-pi/pi-tui/tools/grep";
import {
	isTrackedToolName,
	type TrackedToolName,
	type TurnGroups,
} from "./summary";

type CompressibleTool = Omit<ToolDefinition, "renderCall" | "renderResult"> & {
	promptGuidelines?: string[];
	renderCall: (
		...args: Parameters<NonNullable<ToolDefinition["renderCall"]>>
	) => Component | undefined;
	renderResult: (
		...args: Parameters<NonNullable<ToolDefinition["renderResult"]>>
	) => Component | undefined;
};

const toolDescriptors: Record<
	TrackedToolName,
	Pick<CompressibleTool, "label" | "approval" | "loadMode" | "renderResult">
> = {
	bash: {
		label: "Bash",
		approval: "exec",
		loadMode: "essential",
		renderResult(result, options, theme, args) {
			return bashToolRenderer.renderResult(
				result as Parameters<typeof bashToolRenderer.renderResult>[0],
				options,
				theme,
				args as Parameters<typeof bashToolRenderer.renderResult>[3],
			);
		},
	},
	eval: {
		label: "Eval",
		approval: "exec",
		loadMode: "essential",
		renderResult(result, options, theme, args) {
			return evalToolRenderer.renderResult(
				result as Parameters<typeof evalToolRenderer.renderResult>[0],
				options,
				theme,
				args as Parameters<typeof evalToolRenderer.renderResult>[3],
			);
		},
	},
	grep: {
		label: "Grep",
		approval(args: unknown) {
			const a = args as { path?: string | string[]; paths?: string | string[] };
			return InternalUrlRouter.instance().readTier(
				toPathList(a.path ?? a.paths).join("\n"),
			);
		},
		loadMode: "discoverable",
		renderResult(result, options, theme, args) {
			return markFramedBlockComponent(
				grepToolRenderer.renderResult(
					result as Parameters<typeof grepToolRenderer.renderResult>[0],
					options,
					theme,
					args as Parameters<typeof grepToolRenderer.renderResult>[3],
				),
			);
		},
	},
	glob: {
		label: "Glob",
		approval: "read",
		loadMode: "essential",
		renderResult(result, options, theme, args) {
			return markFramedBlockComponent(
				globToolRenderer.renderResult(
					result as Parameters<typeof globToolRenderer.renderResult>[0],
					options,
					theme,
					args as Parameters<typeof globToolRenderer.renderResult>[3],
				),
			);
		},
	},
};

export function registerTrackedTools(
	pi: ExtensionAPI,
	groups: TurnGroups,
): void {
	for (const native of pi.getAllTools()) {
		if (!isTrackedToolName(native.name)) continue;
		const descriptor = toolDescriptors[native.name];
		const override: CompressibleTool = {
			name: native.name,
			label: descriptor.label,
			description: native.description,
			parameters: native.parameters,
			promptGuidelines: native.promptGuidelines,
			approval: descriptor.approval,
			loadMode: descriptor.loadMode,
			strict: true,
			execute(_id, params, signal, onUpdate, ctx) {
				// biome-ignore lint/style/noNonNullAssertion: Same-name overrides receive native delegation from OMP.
				return ctx.invokeTool!(params as Record<string, unknown>, {
					signal,
					onUpdate,
				});
			},
			renderCall(args, options, theme) {
				return options.expanded
					? undefined
					: groups.summary(args as object, theme);
			},
			renderResult(result, options, theme, args) {
				if (!options.expanded) return undefined;
				return descriptor.renderResult(result, options, theme, args);
			},
		};
		// OMP supports undefined to suppress a card, although its declarations require Component.
		pi.registerTool(override as ToolDefinition);
	}
}
