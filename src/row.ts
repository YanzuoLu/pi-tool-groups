import { relative, isAbsolute } from "node:path";
import { getLanguageFromPath, highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ToolArgs } from "./classify.ts";
import { isActive, type ToolRow } from "./group.ts";
import { plural, previewOutput, RESULT_INDENT, RESULT_PREFIX, statusDot, type Painter } from "./format.ts";

/** The parts of Pi's tool row that a call of its own reads, beyond what a group needs. */
export interface OwnRow extends ToolRow {
	toolDefinition?: { label?: string };
	cwd?: string;
	hideComponent?: boolean;
	setExpanded(expanded: boolean): void;
}

export interface RowOptions {
	painter: Painter;
	/** "ctrl+o to expand", shown after a cut preview. */
	expandHint: string;
	/** Whether the agent is running; a call left without a result by an earlier run is not. */
	agentRunning?: () => boolean;
	/** Runs before a click opens the row, to keep the line under the pointer. */
	beforeToggle?: () => void;
	now?: () => number;
}

/** Claude Code's names for Pi's file tools. */
const NAMES: Readonly<Record<string, string>> = { edit: "Update", write: "Write" };
const WRITE_PREVIEW_ROWS = 10;

function displayPath(path: string, cwd: string | undefined): string {
	if (!cwd || !isAbsolute(path)) return path;
	const relativePath = relative(cwd, path);
	return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value.replace(/\s*\n\s*/gu, " "));
	if (value === undefined) return "undefined";
	return JSON.stringify(value) ?? String(value);
}

/** Arguments the way Claude Code lists them for a tool it has no words for: `key: value, …`. */
export function formatArguments(args: ToolArgs): string {
	return Object.entries(args).map(([key, value]) => `${key}: ${formatValue(value)}`).join(", ");
}

function outputOf(row: ToolRow): string {
	return (row.result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

/** Lines added and removed in a diff in Pi's `+12 text` / `-12 text` format. */
export function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (/^\+\s*\d/u.test(line)) added++;
		else if (/^-\s*\d/u.test(line)) removed++;
	}
	return { added, removed };
}

function lineCount(text: string): number {
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * A call that keeps its own row, drawn the way Claude Code draws it while closed:
 * its marker, `Name(arguments)`, and a short `⎿` result. Opened by a click or
 * Pi's tool-output toggle, it is Pi's own row.
 */
export class ClaudeRow implements Component {
	constructor(
		readonly row: OwnRow,
		private readonly options: RowOptions,
	) {}

	render(width: number): string[] {
		if (this.row.expanded) return this.row.render(width);
		if (this.row.hideComponent) return [];
		return ["", this.header(width), ...this.body(width)];
	}

	invalidate(): void {
		this.row.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.row.expanded) return this.row.handleMouse?.(event);
		if (event.y < 1 || event.button !== "left") return undefined;
		if (event.type === "click") {
			this.options.beforeToggle?.();
			this.row.setExpanded(true);
		}
		return { handled: true };
	}

	private active(): boolean {
		return isActive(this.row) && (this.options.agentRunning?.() ?? true);
	}

	private header(width: number): string {
		const { painter } = this.options;
		const { row } = this;
		const state = this.active() ? "running" : row.result?.isError || !row.result ? "error" : "success";
		const name = NAMES[row.toolName] ?? row.toolDefinition?.label ?? row.toolName;
		const path = typeof row.args.path === "string" ? row.args.path : "";
		const argument = NAMES[row.toolName] ? displayPath(path, row.cwd) : formatArguments(row.args ?? {});
		const title = painter.bold(name) + (argument ? `(${argument})` : "");
		return truncateToWidth(statusDot(painter, state, (this.options.now ?? Date.now)()) + title, width);
	}

	private body(width: number): string[] {
		const { row } = this;
		if (this.active()) return [];
		if (!row.result) return this.block([this.options.painter.fg("dim", "Interrupted")], width);
		if (row.result?.isError) return this.failure(width);
		if (row.toolName === "edit") return this.edit(width);
		if (row.toolName === "write") return this.write(width);
		return this.output(width);
	}

	/** Prefix the first line with `⎿` and indent the rest under it, wrapping to the width. */
	private block(lines: readonly string[], width: number): string[] {
		const inner = Math.max(1, width - RESULT_PREFIX.length);
		return lines
			.flatMap((line) => wrapTextWithAnsi(line, inner))
			.map((line, index) => (index === 0 ? RESULT_PREFIX : RESULT_INDENT) + line);
	}

	private failure(width: number): string[] {
		const { painter, expandHint } = this.options;
		const text = outputOf(this.row).trim();
		const message = /^error\b/iu.test(text) ? text : `Error: ${text}`;
		const { rows, more } = previewOutput(message, width, expandHint);
		return this.block([...rows.map((line) => painter.fg("error", line)), ...(more ? [painter.fg("dim", more)] : [])], width);
	}

	private edit(width: number): string[] {
		const { painter } = this.options;
		const details = this.row.result?.details as { diff?: unknown } | undefined;
		const diff = typeof details?.diff === "string" ? details.diff : "";
		if (!diff) return this.output(width);
		const { added, removed } = countDiff(diff);
		const parts: string[] = [];
		if (added > 0) parts.push(`Added ${painter.bold(String(added))} ${plural(added, "line")}`);
		if (removed > 0) parts.push(`${added > 0 ? "r" : "R"}emoved ${painter.bold(String(removed))} ${plural(removed, "line")}`);
		const summary = parts.join(", ");
		return this.block([...(summary ? [summary] : []), ...renderDiff(diff).split("\n")], width);
	}

	private write(width: number): string[] {
		const { painter, expandHint } = this.options;
		const content = typeof this.row.args.content === "string" ? this.row.args.content : "";
		const path = typeof this.row.args.path === "string" ? this.row.args.path : "";
		const count = lineCount(content);
		const summary = `Wrote ${painter.bold(String(count))} ${plural(count, "line")} to ${painter.bold(displayPath(path, this.row.cwd))}`;
		if (!content) return this.block([summary, "(No content)"], width);
		const shown = content.split("\n").slice(0, WRITE_PREVIEW_ROWS);
		const code = highlightCode(shown.join("\n"), getLanguageFromPath(path));
		const gutter = String(shown.length).length;
		const preview = code.map((line, index) => `${painter.fg("dim", String(index + 1).padStart(gutter))} ${line}`);
		const hidden = count - shown.length;
		const more = hidden > 0 ? [painter.fg("dim", `… +${hidden} ${plural(hidden, "line")} (${expandHint})`)] : [];
		return [...this.block([summary], width), ...preview.map((line) => truncateToWidth(RESULT_INDENT + line, width)), ...more.map((line) => RESULT_INDENT + line)];
	}

	private output(width: number): string[] {
		const { painter, expandHint } = this.options;
		const { rows, more } = previewOutput(outputOf(this.row), width, expandHint);
		if (rows.length === 0) return this.block([painter.fg("dim", "(No content)")], width);
		return this.block([...rows, ...(more ? [painter.fg("dim", more)] : [])], width);
	}
}
