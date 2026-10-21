import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTrackedTools } from "./bash-eval";
import { TurnGroups } from "./summary";

export default function ccStyleToolSummary(pi: ExtensionAPI): void {
	let groups = new TurnGroups();
	pi.on("session_start", (_event, ctx) => {
		groups = new TurnGroups(ctx.sessionManager.getBranch());
		registerTrackedTools(pi, groups);
	});
	pi.on("before_agent_start", (_event, ctx) =>
		groups.startPrompt(ctx.sessionManager.getBranch()),
	);
	pi.on("message_update", (event) => groups.observe(event.message, "update"));
	pi.on("assistant_message", (event) => groups.observe(event.message, "final"));
	pi.on("tool_call", (event) =>
		groups.record(event.toolName, event.input, event.toolCallId),
	);
	pi.on("message_end", (event, ctx) => {
		if (event.message) groups.observe(event.message);
		groups.rebuild(ctx.sessionManager.getBranch());
	});
	pi.on("tool_result", (_event, ctx) =>
		groups.rebuild(ctx.sessionManager.getBranch()),
	);
}
