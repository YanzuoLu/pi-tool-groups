import { sliceByColumn, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** The colors and styles this extension draws with, a subset of Pi's theme. */
export interface Painter {
	fg(color: "accent" | "error" | "success" | "dim" | "muted" | "toolOutput", text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

/** Claude Code's prefix for what a call produced, five columns wide. */
export const RESULT_PREFIX = "  ⎿  ";
export const RESULT_INDENT = "     ";

/** Claude Code's call marker. */
export const DOT = process.platform === "darwin" ? "⏺" : "●";
/** How long the marker of an unfinished call stays on or off. */
const BLINK_MS = 600;

/** The two-column status marker: blinking and dim while unresolved, then green or red. */
export function statusDot(painter: Painter, state: "running" | "success" | "error", now: number): string {
	if (state === "success") return `${painter.fg("success", DOT)} `;
	if (state === "error") return `${painter.fg("error", DOT)} `;
	return Math.floor(now / BLINK_MS) % 2 === 0 ? `${painter.fg("dim", DOT)} ` : "  ";
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return count === 1 ? one : many;
}

/** Durations as Claude Code writes them: "0s", "12s", "1m 5s", "2h 0m 3s". */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	let hours = Math.floor(ms / 3_600_000);
	let minutes = Math.floor((ms % 3_600_000) / 60_000);
	let seconds = Math.round((ms % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

/** Split a line into pieces of at most `width` columns. */
function hardWrap(line: string, width: number): string[] {
	const total = visibleWidth(line);
	if (total <= width) return [line.trimEnd()];
	const pieces: string[] = [];
	for (let start = 0; start < total; start += width) pieces.push(sliceByColumn(line, start, width).trimEnd());
	return pieces;
}

const PREVIEW_ROWS = 3;

/**
 * Output as Claude Code previews it: wrapped to the width less ten columns,
 * three rows, or four when only one more would be hidden, then how many rows
 * are left.
 */
export function previewOutput(text: string, width: number): { rows: string[]; more: string | undefined } {
	const trimmed = text.trimEnd();
	if (!trimmed) return { rows: [], more: undefined };
	const wrapWidth = Math.max(width - 10, 10);
	const rows = trimmed.split("\n").flatMap((line) => hardWrap(line, wrapWidth));
	const hidden = rows.length - PREVIEW_ROWS;
	if (hidden <= 1) return { rows, more: undefined };
	return { rows: rows.slice(0, PREVIEW_ROWS), more: `… +${hidden} ${plural(hidden, "line")}` };
}

/** The line under an item opened by a click; a click on it closes the item. */
export function showLess(painter: Painter): string {
	return painter.fg("dim", " show less");
}

/** Whether a click lands on text: Claude Code ignores clicks on blank cells. */
export function hitsText(lines: readonly string[], event: TuiMouseEvent): boolean {
	const line = lines[event.y];
	if (line === undefined) return false;
	return stripTerminalSequences(sliceByColumn(line, event.x, 1)).trim().length > 0;
}
