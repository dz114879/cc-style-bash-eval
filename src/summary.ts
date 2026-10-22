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

interface PersistedGroup extends TurnGroup {
	prompt: number;
	calls: { id: string; name: TrackedToolName; arguments: object }[];
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

class Observation {
	private content: AssistantBlock[] = [];
	private cursor = 0;
	private readonly boundaries = new Map<number, (() => void) | undefined>();
	private readonly consumed = new Map<number, string>();
	private finalized = false;
	private ended = false;

	constructor(
		readonly prompt: number,
		private readonly closeGroup: () => () => void,
		private readonly wasRecorded: (id: string, name: string) => boolean,
	) {}

	get isEnded(): boolean {
		return this.ended;
	}

	get isFinalized(): boolean {
		return this.finalized;
	}

	*calls(content = this.content) {
		for (const [index, block] of content.entries()) {
			if (block.type !== "toolCall") continue;
			yield {
				...block,
				id: this.consumed.get(index) ?? block.id,
				recorded: this.consumed.has(index),
			};
		}
	}

	update(content: AssistantBlock[], phase: ObservationPhase): void {
		this.content = content;
		this.finalized = phase !== "update";
		this.ended = phase === "end";
		this.retractBlankBoundaries();
		if (this.ended) {
			for (const [index, block] of content.entries()) {
				if (
					block.type === "toolCall" &&
					!this.consumed.has(index) &&
					this.wasRecorded(block.id, block.name)
				)
					this.consumed.set(index, block.id);
			}
		}
		// Finalization can replace a blank block before the pending tool slot.
		const cursor = Math.min(this.cursor, content.length);
		this.cursor = 0;
		this.advance(cursor);
		this.drain();
	}

	record(name: string, id: string): object | undefined {
		const matches = (block: AssistantBlock, index: number) =>
			index >= this.cursor &&
			!this.consumed.has(index) &&
			block.type === "toolCall" &&
			block.name === name;
		let index = this.content.findIndex(
			(block, index) =>
				matches(block, index) && block.type === "toolCall" && block.id === id,
		);
		if (index < 0) index = this.content.findIndex(matches);
		if (index < 0) return undefined;
		this.advance(index + 1);
		this.consumed.set(index, id);
		const block = this.content[index];
		return block.type === "toolCall" ? block.arguments : undefined;
	}

	private retractBlankBoundaries(): void {
		for (const [index, restore] of this.boundaries) {
			if (!restore) continue;
			const block = this.content[index];
			if (block && isBoundary(block)) continue;
			restore();
			this.boundaries.delete(index);
		}
	}

	private advance(end: number): void {
		while (this.cursor < end) {
			const index = this.cursor;
			const block = this.content[index];
			if (isBoundary(block) && !this.boundaries.has(index)) {
				const restore =
					block.type !== "toolCall" || !this.consumed.has(index)
						? this.closeGroup()
						: undefined;
				this.boundaries.set(index, block.type === "text" ? restore : undefined);
			}
			this.cursor++;
		}
	}

	drain(): void {
		while (this.cursor < this.content.length) {
			const block = this.content[this.cursor];
			if (
				block.type === "toolCall" &&
				!this.ended &&
				!this.consumed.has(this.cursor)
			)
				return;
			const index = this.cursor;
			this.advance(index + 1);
			// The last streaming text block can still grow from blank to prose.
			if (
				!this.finalized &&
				index === this.content.length - 1 &&
				block.type !== "toolCall"
			) {
				this.cursor = index;
				return;
			}
		}
	}
}

export class TurnGroups {
	private current: TurnGroup = emptyTurnGroup();
	private readonly calls = new WeakMap<object, Membership>();
	private readonly liveById = new Map<string, Membership>();
	private readonly persistedTotals = new WeakMap<TurnGroup, PersistedGroup>();
	private readonly members = new WeakMap<TurnGroup, Membership[]>();
	private readonly mergedInto = new WeakMap<TurnGroup, TurnGroup>();
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

	private closeGroup(): () => void {
		const previous = this.current;
		const next = emptyTurnGroup();
		this.current = next;
		return () => this.mergeGroups(previous, next);
	}

	private resolveGroup(group: TurnGroup): TurnGroup {
		let merged = this.mergedInto.get(group);
		while (merged) {
			group = merged;
			merged = this.mergedInto.get(group);
		}
		return group;
	}

	private reconciledTotals(group: TurnGroup): TurnGroup {
		const persisted = this.persistedTotals.get(group);
		return persisted && total(persisted) >= total(group) ? persisted : group;
	}

	private includePersistedCalls(group: TurnGroup): void {
		const snapshot = this.persistedTotals.get(group);
		if (!snapshot) return;
		const members = this.members.get(group) ?? [];
		for (const call of snapshot.calls) {
			const key = callKey(snapshot.prompt, call.id, call.name);
			if (this.calls.has(call.arguments) || this.liveById.has(key)) continue;
			const membership = { group, index: total(group) };
			group[call.name]++;
			members.push(membership);
			// Retain identity so another snapshot or a later callback cannot count it again.
			this.calls.set(call.arguments, membership);
			this.liveById.set(key, membership);
		}
		this.members.set(group, members);
	}

	private mergeGroups(previous: TurnGroup, next: TurnGroup): void {
		// Earlier rewrites may already have merged either side of this boundary.
		previous = this.resolveGroup(previous);
		next = this.resolveGroup(next);
		if (previous === next) return;
		this.includePersistedCalls(previous);
		this.includePersistedCalls(next);
		const offset = total(previous);
		const members = this.members.get(previous) ?? [];
		for (const member of this.members.get(next) ?? []) {
			member.group = previous;
			member.index += offset;
			members.push(member);
		}
		this.members.set(previous, members);
		this.members.delete(next);
		previous.bash += next.bash;
		previous.eval += next.eval;
		previous.grep += next.grep;
		previous.glob += next.glob;
		this.persistedTotals.delete(previous);
		this.persistedTotals.delete(next);
		this.mergedInto.set(next, previous);
		if (this.current === next) this.current = previous;
	}

	rebuild(entries: readonly SessionEntry[]): void {
		let prompt = 0;
		let group: PersistedGroup = { ...emptyTurnGroup(), prompt, calls: [] };
		const groups: PersistedGroup[] = [group];
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
						group.calls.push({
							id: block.id,
							name: block.name,
							arguments: block.arguments,
						});
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
					this.persistedTotals.set(live, { ...totals, prompt, calls });
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
		const pending = this.pending?.isEnded ? undefined : this.pending;
		for (const block of message.content) {
			if (observation || block.type !== "toolCall") continue;
			const candidate = this.messagesByCall.get(
				callKey(this.prompt, block.id, block.name),
			);
			if (candidate && (!candidate.isEnded || (phase === "end" && !pending)))
				observation = candidate;
		}
		observation ??=
			pending && (!pending.isFinalized || phase === "end")
				? pending
				: new Observation(
						this.prompt,
						() => this.closeGroup(),
						(id, name) => this.recorded.has(callKey(this.prompt, id, name)),
					);
		this.observations.set(message, observation);
		if (!observation.isEnded) {
			observation.update(message.content, phase);
			this.pending = observation;
		}
		for (const block of observation.calls(message.content)) {
			const key = callKey(observation.prompt, block.id, block.name);
			this.messagesByCall.set(key, observation);
			const live = block.recorded ? this.liveById.get(key) : undefined;
			if (live) this.calls.set(block.arguments, live);
		}
	}

	record(toolName: string, input: object, toolCallId: string): void {
		const key = callKey(this.prompt, toolCallId, toolName);
		if (this.recorded.has(key)) return;
		let observation = this.messagesByCall.get(key);
		if (
			(!observation || observation.isEnded) &&
			this.pending &&
			!this.pending.isEnded
		)
			observation = this.pending;
		const snapshotInput = observation?.record(toolName, toolCallId);
		if (snapshotInput && observation) this.messagesByCall.set(key, observation);
		this.recorded.add(key);
		if (isTrackedToolName(toolName)) {
			let membership = this.liveById.get(key);
			if (!membership) {
				const index = total(this.current);
				this.current[toolName]++;
				membership = { group: this.current, index };
				const members = this.members.get(this.current) ?? [];
				members.push(membership);
				this.members.set(this.current, members);
				this.liveById.set(key, membership);
			}
			this.calls.set(input, membership);
			if (snapshotInput) this.calls.set(snapshotInput, membership);
		} else if (!observation) this.closeGroup();
		observation?.drain();
	}

	private lookup(input: object): Membership | undefined {
		const live = this.calls.get(input);
		if (live) {
			// Open groups use invocation counts, even when persistence is ahead.
			if (live.group === this.current) return live;
			return { group: this.reconciledTotals(live.group), index: live.index };
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
