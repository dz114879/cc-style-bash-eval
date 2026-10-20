import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";
import { markFramedBlockComponent } from "@oh-my-pi/pi-tui/render";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

interface TurnGroup {
	bash: number;
	eval: number;
}

interface TurnGroupSummary extends TurnGroup {
	turn: number;
	index: number;
}

export class TurnGroups {
	private current: TurnGroup = { bash: 0, eval: 0 };
	private readonly calls = new WeakMap<
		object,
		{ group: TurnGroup; index: number }
	>();
	private branch = new WeakMap<object, TurnGroupSummary>();

	rebuild(entries: readonly SessionEntry[]): void {
		const groups: (TurnGroup & { calls: object[] })[] = [];
		let group: TurnGroup & { calls: object[] } = {
			bash: 0,
			eval: 0,
			calls: [],
		};
		groups.push(group);
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") {
				group = { bash: 0, eval: 0, calls: [] };
				groups.push(group);
			} else if (entry.message.role === "assistant") {
				for (const content of entry.message.content) {
					if (
						content.type !== "toolCall" ||
						(content.name !== "bash" && content.name !== "eval")
					)
						continue;
					group[content.name]++;
					group.calls.push(content.arguments);
				}
			}
		}
		this.branch = new WeakMap();
		for (const [turn, { bash, eval: cells, calls }] of groups.entries()) {
			for (const [index, input] of calls.entries()) {
				this.branch.set(input, { turn, index, bash, eval: cells });
			}
		}
	}

	startPrompt(): void {
		this.current = { bash: 0, eval: 0 };
	}

	record(toolName: string, input: object): void {
		if (toolName !== "bash" && toolName !== "eval") return;
		const index = this.current.bash + this.current.eval;
		this.current[toolName]++;
		this.calls.set(input, { group: this.current, index });
	}

	private lookup(
		input: object,
	): { group: TurnGroup; index: number } | undefined {
		const live = this.calls.get(input);
		// Active counts must not be replaced by an ahead-of-execution or lagging branch snapshot.
		if (live?.group === this.current) return live;
		const branch = this.branch.get(input);
		return branch ? { group: branch, index: branch.index } : live;
	}

	summary(input: object, theme: Theme): Component | undefined {
		const call = this.lookup(input);
		if (call?.index !== 0) return undefined;
		return markFramedBlockComponent({
			render: (width: number) => {
				const currentCall = this.lookup(input);
				if (currentCall?.index !== 0) return [];
				const group = currentCall.group;
				const count = (value: number) =>
					theme.fg("accent", theme.bold(String(value)));
				let wording = "";
				if (group.bash > 0) {
					wording +=
						theme.fg("muted", "Ran ") +
						count(group.bash) +
						theme.fg("muted", group.bash === 1 ? " command" : " commands");
				}
				if (group.eval > 0) {
					wording +=
						theme.fg("muted", group.bash > 0 ? ", evaluated " : "Evaluated ") +
						count(group.eval) +
						theme.fg("muted", group.eval === 1 ? " cell" : " cells");
				}
				return [
					truncateToWidth(
						` ${theme.fg("dim", theme.format.bullet)} ${wording}`,
						width,
					),
				];
			},
		});
	}
}
