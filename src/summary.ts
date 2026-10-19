import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";

interface TurnGroup {
	bash: number;
	eval: number;
}

export class LiveTurnGroups {
	private current: TurnGroup = { bash: 0, eval: 0 };
	private readonly calls = new WeakMap<
		object,
		{ group: TurnGroup; index: number }
	>();

	startPrompt(): void {
		this.current = { bash: 0, eval: 0 };
	}

	record(toolName: string, input: object): void {
		if (toolName !== "bash" && toolName !== "eval") return;
		const index = this.current.bash + this.current.eval;
		this.current[toolName]++;
		this.calls.set(input, { group: this.current, index });
	}

	summary(input: object): Component | undefined {
		const call = this.calls.get(input);
		if (call?.index !== 0) return undefined;
		return {
			render: (width: number) => {
				const group = call.group;
				const parts: string[] = [];
				if (group.bash > 0)
					parts.push(`Ran ${group.bash} command${group.bash === 1 ? "" : "s"}`);
				if (group.eval > 0) {
					parts.push(
						`${group.bash > 0 ? "evaluated" : "Evaluated"} ${group.eval} cell${group.eval === 1 ? "" : "s"}`,
					);
				}
				return [truncateToWidth(parts.join(", "), width)];
			},
		};
	}
}
