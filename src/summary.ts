import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";
import { markFramedBlockComponent } from "@oh-my-pi/pi-tui/render";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

export type TrackedToolName = "bash" | "eval" | "grep" | "glob";

export function isTrackedToolName(name: string): name is TrackedToolName {
	return (
		name === "bash" || name === "eval" || name === "grep" || name === "glob"
	);
}

interface TurnGroup {
	bash: number;
	eval: number;
	grep: number;
	glob: number;
}

function emptyTurnGroup(): TurnGroup {
	return { bash: 0, eval: 0, grep: 0, glob: 0 };
}

function total(group: TurnGroup): number {
	return group.bash + group.eval + group.grep + group.glob;
}

function promptCount(entries: readonly SessionEntry[]): number {
	return entries.filter(
		(entry) => entry.type === "message" && entry.message.role === "user",
	).length;
}

// Provider call IDs can repeat after a prompt or resume; aliases are prompt-local.
function callKey(prompt: number, id: string, name: string): string {
	return `${prompt}:${id}:${name}`;
}

interface Membership {
	group: TurnGroup;
	index: number;
}

interface TurnGroupSummary extends TurnGroup {
	turn: number;
	index: number;
}

type Message = Extract<SessionEntry, { type: "message" }>["message"];
type AssistantBlock = Extract<
	Message,
	{ role: "assistant" }
>["content"][number];
type ObservationPhase = "update" | "final" | "end";

function isBoundary(block: AssistantBlock): boolean {
	return (
		(block.type === "text" && block.text.trim().length > 0) ||
		(block.type === "toolCall" && !isTrackedToolName(block.name))
	);
}

interface Observation {
	prompt: number;
	content: AssistantBlock[];
	cursor: number;
	boundaries: Set<number>;
	finalized: boolean;
	ended: boolean;
}

export class TurnGroups {
	private current: TurnGroup = emptyTurnGroup();
	private readonly calls = new WeakMap<object, Membership>();
	private readonly liveById = new Map<string, Membership>();
	private readonly persistedTotals = new WeakMap<TurnGroup, TurnGroup>();
	private branch = new WeakMap<object, TurnGroupSummary>();
	private pending?: Observation;
	private readonly observations = new WeakMap<object, Observation>();
	private readonly messagesByCall = new Map<string, Observation>();
	private readonly recorded = new Set<string>();
	private prompt = 0;
	private awaitingUser = false;

	constructor(entries: readonly SessionEntry[] = []) {
		this.prompt = promptCount(entries);
		this.rebuild(entries);
	}

	private closeGroup(): void {
		this.current = emptyTurnGroup();
	}

	private advance(observation: Observation, end: number): void {
		while (observation.cursor < end) {
			const index = observation.cursor;
			const block = observation.content[index];
			if (isBoundary(block) && !observation.boundaries.has(index)) {
				if (
					block.type !== "toolCall" ||
					!this.recorded.has(callKey(observation.prompt, block.id, block.name))
				)
					this.closeGroup();
				observation.boundaries.add(index);
			}
			observation.cursor++;
		}
	}

	private drain(observation: Observation): void {
		while (observation.cursor < observation.content.length) {
			const block = observation.content[observation.cursor];
			if (
				block.type === "toolCall" &&
				!observation.ended &&
				!this.recorded.has(callKey(observation.prompt, block.id, block.name))
			)
				return;
			const index = observation.cursor;
			this.advance(observation, index + 1);
			// The last streaming text block can still grow from blank to prose.
			if (
				!observation.finalized &&
				index === observation.content.length - 1 &&
				block.type !== "toolCall"
			) {
				observation.cursor = index;
				return;
			}
		}
	}

	rebuild(entries: readonly SessionEntry[]): void {
		type BranchGroup = TurnGroup & {
			prompt: number;
			calls: Extract<AssistantBlock, { type: "toolCall" }>[];
		};
		let prompt = 0;
		let group: BranchGroup = { ...emptyTurnGroup(), prompt, calls: [] };
		const groups: BranchGroup[] = [group];
		const split = () => {
			group = { ...emptyTurnGroup(), prompt, calls: [] };
			groups.push(group);
		};
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") {
				prompt++;
				split();
			} else if (entry.message.role === "assistant") {
				for (const block of entry.message.content) {
					if (isBoundary(block)) split();
					else if (block.type === "toolCall" && isTrackedToolName(block.name)) {
						group[block.name]++;
						group.calls.push(block);
					}
				}
			}
		}
		this.branch = new WeakMap();
		for (const [
			turn,
			{ bash, eval: cells, grep, glob, calls, prompt },
		] of groups.entries()) {
			const totals = { bash, eval: cells, grep, glob };
			const liveGroups = new Set<TurnGroup>();
			for (const [index, call] of calls.entries()) {
				this.branch.set(call.arguments, { ...totals, turn, index });
				// OMP detaches message snapshots, including their argument objects.
				const live =
					this.calls.get(call.arguments) ??
					this.liveById.get(callKey(prompt, call.id, call.name));
				if (live) {
					this.calls.set(call.arguments, live);
					liveGroups.add(live.group);
				}
			}
			// A stale snapshot missing a boundary must not merge distinct live runs.
			if (liveGroups.size !== 1) continue;
			for (const live of liveGroups) {
				const previous = this.persistedTotals.get(live) ?? live;
				if (total(totals) >= total(previous))
					this.persistedTotals.set(live, totals);
			}
		}
	}

	startPrompt(entries: readonly SessionEntry[]): void {
		this.prompt = Math.max(this.prompt + 1, promptCount(entries) + 1);
		this.awaitingUser = true;
		this.closeGroup();
		this.pending = undefined;
	}

	observe(message: Message, phase: ObservationPhase = "end"): void {
		if (message.role === "user") {
			// before_agent_start and its following user notification share one prompt.
			if (!this.awaitingUser) this.prompt++;
			this.awaitingUser = false;
			this.closeGroup();
			this.pending = undefined;
		}
		if (message.role !== "assistant") return;
		let observation = this.observations.get(message);
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const key = callKey(
				observation?.prompt ?? this.prompt,
				block.id,
				block.name,
			);
			observation ??= this.messagesByCall.get(key);
			const live = this.liveById.get(key);
			if (live) this.calls.set(block.arguments, live);
		}
		observation ??=
			this.pending && !this.pending.finalized
				? this.pending
				: {
						prompt: this.prompt,
						content: [],
						cursor: 0,
						boundaries: new Set(),
						finalized: false,
						ended: false,
					};
		this.observations.set(message, observation);
		if (observation.ended) return;
		observation.content = message.content;
		// Finalized text can replace a blank block before the pending tool slot.
		const cursor = observation.cursor;
		observation.cursor = 0;
		this.advance(observation, cursor);
		observation.finalized = phase !== "update";
		observation.ended = phase === "end";
		this.pending = observation;
		for (const block of message.content) {
			if (block.type === "toolCall")
				this.messagesByCall.set(
					callKey(observation.prompt, block.id, block.name),
					observation,
				);
		}
		this.drain(observation);
	}

	record(toolName: string, input: object, toolCallId: string): void {
		const key = callKey(this.prompt, toolCallId, toolName);
		if (this.recorded.has(key)) return;
		const observation = this.messagesByCall.get(key);
		if (observation) {
			const index = observation.content.findIndex(
				(block) =>
					block.type === "toolCall" &&
					block.id === toolCallId &&
					block.name === toolName,
			);
			this.advance(observation, index + 1);
		}
		this.recorded.add(key);
		if (isTrackedToolName(toolName)) {
			const index = total(this.current);
			this.current[toolName]++;
			const membership = { group: this.current, index };
			this.calls.set(input, membership);
			this.liveById.set(key, membership);
		} else if (!observation) this.closeGroup();
		if (observation) this.drain(observation);
	}

	private lookup(input: object): Membership | undefined {
		const live = this.calls.get(input);
		if (live) {
			// Open groups use invocation counts, even when persistence is ahead.
			if (live.group === this.current) return live;
			const persisted = this.persistedTotals.get(live.group);
			return persisted && total(persisted) >= total(live.group)
				? { group: persisted, index: live.index }
				: live;
		}
		const branch = this.branch.get(input);
		return branch ? { group: branch, index: branch.index } : undefined;
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
				const appendClause = (
					total: number,
					leadingVerb: string,
					followingVerb: string,
					singularNoun: string,
					pluralNoun: string,
				) => {
					if (total === 0) return;
					if (wording) wording += theme.fg("muted", ", ");
					wording +=
						theme.fg("muted", wording ? followingVerb : leadingVerb) +
						count(total) +
						theme.fg("muted", total === 1 ? singularNoun : pluralNoun);
				};
				appendClause(
					group.bash,
					"Ran ",
					"ran ",
					" bash command",
					" bash commands",
				);
				appendClause(group.eval, "Evaluated ", "evaluated ", " cell", " cells");
				appendClause(
					group.grep,
					"Grepped ",
					"grepped ",
					" pattern",
					" patterns",
				);
				appendClause(
					group.glob,
					"Globbed ",
					"globbed ",
					" pattern",
					" patterns",
				);
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
