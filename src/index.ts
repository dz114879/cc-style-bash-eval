import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTrackedTools } from "./bash-eval";
import { TurnGroups } from "./summary";

export default function ccStyleToolSummary(pi: ExtensionAPI): void {
	const groups = new TurnGroups();
	pi.on("session_start", (_event, ctx) => {
		groups.rebuild(ctx.sessionManager.getBranch());
		registerTrackedTools(pi, groups);
	});
	pi.on("before_agent_start", () => groups.startPrompt());
	pi.on("tool_call", (event) => groups.record(event.toolName, event.input));
	pi.on("message_end", (_event, ctx) =>
		groups.rebuild(ctx.sessionManager.getBranch()),
	);
	pi.on("tool_result", (_event, ctx) =>
		groups.rebuild(ctx.sessionManager.getBranch()),
	);
}
