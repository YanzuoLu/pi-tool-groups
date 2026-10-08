import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { classifyTool, type Kind, type ToolArgs } from "./classify.ts";
import { drawOpened, formatDuration, hitsText, plural, RESULT_PREFIX, statusDot, type Painter } from "./format.ts";

/** The parts of Pi's tool row that this extension reads. */
export interface ToolRow extends Component {
	toolName: string;
	args: ToolArgs;
	result?: { isError?: boolean; content?: Array<{ type: string; text?: string }>; details?: unknown };
	isPartial?: boolean;
	expanded?: boolean;
}

/** An assistant turn that only thought, as Pi's assistant component holds it. */
export interface ThoughtLike {
	lastMessage?: { timestamp: number; content: Array<{ type: string; thinking?: string }> };
	isStreaming?: boolean;
}

/**
 * How a chat child takes part in grouping. Members and thoughts anchor a group;
 * anything neutral between two anchors folds in where it stands; a breaker ends
 * the group and keeps its own place.
 */
export type Role = "member" | "thought" | "neutral" | "breaker";

/**
 * Fold each run of anchors, and whatever sits between two of them, into one
 * group, keeping every child in its order. What follows the last anchor of a
 * run stays outside the group.
 */
export function groupChildren<T>(children: readonly T[], roleOf: (child: T) => Role, makeGroup: (members: T[]) => T): T[] {
	const grouped: T[] = [];
	let members: T[] = [];
	let pending: T[] = [];
	const flush = () => {
		if (members.length > 0) grouped.push(makeGroup(members));
		grouped.push(...pending);
		members = [];
		pending = [];
	};
	for (const child of children) {
		const role = roleOf(child);
		if (role === "member" || role === "thought") {
			members.push(...pending, child);
			pending = [];
		} else if (role === "neutral" && members.length > 0) {
			pending.push(child);
		} else if (role === "neutral") {
			grouped.push(child);
		} else {
			flush();
			grouped.push(child);
		}
	}
	flush();
	return grouped;
}

const kinds = new WeakMap<object, { args: ToolArgs; kind: Kind | undefined }>();

/** What a row counts as, cached until its arguments change. */
export function kindOf(row: Pick<ToolRow, "toolName" | "args">): Kind | undefined {
	const cached = kinds.get(row);
	if (cached?.args === row.args) return cached.kind;
	const kind = classifyTool(row.toolName, row.args ?? {});
	kinds.set(row, { args: row.args, kind });
	return kind;
}

export function isActive(row: Pick<ToolRow, "result" | "isPartial">): boolean {
	return !row.result || row.isPartial === true;
}

type Tally = Record<Kind, number>;

export function tally(rows: readonly Pick<ToolRow, "toolName" | "args">[]): Tally {
	const counts: Tally = { search: 0, read: 0, list: 0, bash: 0 };
	const readPaths = new Set<string>();
	for (const row of rows) {
		const kind = kindOf(row);
		if (!kind) continue;
		if (row.toolName === "read" && typeof row.args.path === "string") readPaths.add(row.args.path);
		else counts[kind]++;
	}
	counts.read += readPaths.size;
	return counts;
}

/** Claude Code's wording, in its order: verb while running, verb when done, noun, plural noun. */
const PHRASES: ReadonlyArray<[Kind, string, string, string, string]> = [
	["search", "searching for", "searched for", "pattern", "patterns"],
	["read", "reading", "read", "file", "files"],
	["list", "listing", "listed", "directory", "directories"],
	["bash", "running", "ran", "shell command", "shell commands"],
];

/**
 * "Thought for 12s, searched for 2 patterns, read 1 file", with counts and the
 * thinking time passed through `bold`. `thoughtMs` is undefined when the group
 * holds no thinking.
 */
export function summarize(
	counts: Tally,
	active: boolean,
	thoughtMs: number | undefined,
	bold: (text: string) => string = (text) => text,
): string {
	const parts: string[] = [];
	if (thoughtMs !== undefined) {
		parts.push(`${active ? "Thinking" : "Thought"} for ${bold(formatDuration(Math.max(1000, thoughtMs)))}`);
	}
	for (const [kind, running, done, one, many] of PHRASES) {
		const count = counts[kind];
		if (count > 0) parts.push(`${active ? running : done} ${bold(String(count))} ${count === 1 ? one : many}`);
	}
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function firstLine(text: string): string {
	const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	return lines.length > 1 ? `${lines[0]} …` : lines[0]!;
}

/** What a call is working on: its command, path, or pattern. */
export function hintOf(row: Pick<ToolRow, "toolName" | "args">): string {
	const { toolName, args } = row;
	const text = (value: unknown) => (typeof value === "string" ? firstLine(value) : "");
	if (toolName === "bash") return text(args.command) ? `$ ${text(args.command)}` : "";
	if (toolName === "grep" || toolName === "find") return text(args.pattern) ? `"${text(args.pattern)}"` : "";
	if (toolName === "ls") return text(args.path) || ".";
	return text(args.path);
}

/** The last line of a turn's thinking, without Markdown emphasis, as a one-line summary of where it is. */
export function thinkingSummary(thought: ThoughtLike): string {
	const text = (thought.lastMessage?.content ?? [])
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking ?? "")
		.join("\n");
	const lines = text.split(/\r?\n/u).map((line) => line.replace(/[*_`#]+/gu, "").trim()).filter(Boolean);
	return lines.at(-1) ?? "";
}

function outputLines(row: ToolRow): number {
	const text = (row.result?.content ?? []).map((block) => block.text ?? "").join("");
	return text ? text.replace(/\n$/u, "").split("\n").length : 0;
}

/** Claude Code shows elapsed time once a call has run this long. */
const ELAPSED_FROM_MS = 2000;
/** Claude Code caps each stretch of thinking it counts at ten minutes. */
const THINKING_CAP_MS = 600_000;

/** Whether a group is open, kept per group across frames. */
export interface GroupState {
	expanded: boolean;
}

export interface GroupOptions {
	painter: Painter;
	state: GroupState;
	/** When a turn finished streaming, or undefined while it streams. */
	finishedAt: (message: NonNullable<ThoughtLike["lastMessage"]>) => number | undefined;
	/** Whether the agent is running; a call left without a result by an earlier run is not. */
	agentRunning?: () => boolean;
	requestRender: () => void;
	/** Runs before a click opens or closes the group, to keep the line under the pointer. */
	beforeToggle?: () => void;
	now?: () => number;
}

const startTimes = new WeakMap<object, number>();

/**
 * One line that stands for a run of calls and thinking, in Claude Code's
 * fullscreen style. A click opens it in place of that line, to every member as
 * Pi draws it on a highlighted background, and a click on the opened group
 * closes it again. Pi's tool-output toggle only changes how the members draw.
 */
export class ToolGroup implements Component {
	/**
	 * Whether the agent is still at work right after this group: it is running and
	 * nothing has shown up after the group yet. Claude Code keeps such a group live.
	 */
	working = false;
	private lines: string[] = [];
	private layout: Array<{ member: Component; top: number; height: number }> = [];

	constructor(
		readonly rows: readonly ToolRow[],
		readonly thoughts: readonly ThoughtLike[],
		readonly members: readonly Component[],
		private readonly options: GroupOptions,
	) {}

	render(width: number): string[] {
		this.layout = [];
		if (!this.options.state.expanded) {
			this.lines = ["", ...this.header(width)];
			return this.lines;
		}
		const lines: string[] = [];
		for (const member of this.members) {
			const memberLines = member.render(width);
			this.layout.push({ member, top: lines.length, height: memberLines.length });
			lines.push(...memberLines);
		}
		this.lines = drawOpened(lines, width, this.options.painter);
		return this.lines;
	}

	invalidate(): void {
		for (const member of this.members) member.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		if (!hitsText(this.lines, event)) return undefined;
		if (event.type === "click") {
			this.options.beforeToggle?.();
			this.options.state.expanded = !this.options.state.expanded;
			this.options.requestRender();
		}
		return { handled: true };
	}

	private thoughtMs(now: number): number | undefined {
		if (this.thoughts.length === 0) return undefined;
		let total = 0;
		for (const thought of this.thoughts) {
			const message = thought.lastMessage;
			if (!message) continue;
			const end = thought.isStreaming ? now : this.options.finishedAt(message);
			if (end !== undefined && end > message.timestamp) total += Math.min(end - message.timestamp, THINKING_CAP_MS);
		}
		return total;
	}

	private header(width: number): string[] {
		const { painter } = this.options;
		const now = (this.options.now ?? Date.now)();
		const running = this.options.agentRunning?.() ?? true;
		const activeRows = running ? this.rows.filter(isActive) : [];
		const thinking = this.thoughts.some((thought) => thought.isStreaming);
		const active = activeRows.length > 0 || thinking || this.working;
		const summary = summarize(tally(this.rows), active, this.thoughtMs(now), (text) => painter.bold(text));

		if (!active) return [truncateToWidth(`  ${painter.fg("dim", summary)}`, width)];

		for (const row of activeRows) if (!startTimes.has(row)) startTimes.set(row, now);
		let clock = "";
		if (activeRows.length > 0) {
			const elapsed = now - Math.min(...activeRows.map((row) => startTimes.get(row)!));
			if (elapsed >= ELAPSED_FROM_MS) clock = painter.fg("dim", ` · ${formatDuration(elapsed)}`);
		}
		const lines = [truncateToWidth(`${statusDot(painter, "running", now)}${summary}${clock}…`, width)];

		// Thinking that came after the last call says where the turn is; otherwise the last call does.
		const lastThought = this.thoughts.at(-1);
		const lastRow = this.rows.at(-1);
		const thoughtIsLatest = lastThought !== undefined
			&& (lastRow === undefined || this.members.indexOf(lastThought as Component) > this.members.indexOf(lastRow));
		if (thoughtIsLatest) {
			const text = thinkingSummary(lastThought);
			if (text) lines.push(truncateToWidth(painter.fg("dim", RESULT_PREFIX + painter.italic(text)), width));
			return lines;
		}
		if (!lastRow) return lines;
		let text = hintOf(lastRow);
		const bash = activeRows.filter((row) => row.toolName === "bash");
		if (bash.length > 0) {
			const longest = Math.max(...bash.map((row) => now - startTimes.get(row)!));
			if (longest >= ELAPSED_FROM_MS) {
				const count = Math.max(...bash.map(outputLines));
				text += count > 0 ? ` (${formatDuration(longest)} · ${count} ${plural(count, "line")})` : ` (${formatDuration(longest)})`;
			}
		}
		if (text) lines.push(truncateToWidth(painter.fg("dim", RESULT_PREFIX + text), width));
		return lines;
	}
}
