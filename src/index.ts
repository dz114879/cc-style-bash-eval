import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerBashEval } from "./bash-eval";
import { LiveTurnGroups } from "./summary";

export default function ccStyleBashEval(pi: ExtensionAPI): void {
	const groups = new LiveTurnGroups();
	pi.on("session_start", () => registerBashEval(pi, groups));
	pi.on("before_agent_start", () => groups.startPrompt());
	pi.on("tool_call", (event) => groups.record(event.toolName, event.input));
}
