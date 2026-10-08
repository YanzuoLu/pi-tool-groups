import { describe, expect, it } from "vitest";
import type { Painter } from "../src/format.ts";
import { ClaudeRow, countDiff, formatArguments, type OwnRow } from "../src/row.ts";

const plain: Painter = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
const dot = process.platform === "darwin" ? "⏺" : "●";

function own(extra: Partial<OwnRow>): OwnRow {
	return {
		toolName: "web_search",
		args: { query: "pi tui", limit: 3 },
		result: { content: [{ type: "text", text: "a\nb\nc\nd\ne" }] },
		render: () => ["<native>"],
		invalidate() {},
		setExpanded(expanded) {
			this.expanded = expanded;
		},
		...extra,
	};
}

describe("ClaudeRow", () => {
	it("draws a marker, Name(arguments), and a short result", () => {
		const row = new ClaudeRow(own({ toolDefinition: { label: "Web Search" } }), { painter: plain, expandHint: "ctrl+o to expand" });
		expect(row.render(80)).toEqual([
			"",
			`${dot} Web Search(query: "pi tui", limit: 3)`,
			"  ⎿  a",
			"     b",
			"     c",
			"     … +2 lines (ctrl+o to expand)",
		]);
	});

	it("shows a failure in place of the output", () => {
		const row = new ClaudeRow(own({ result: { isError: true, content: [{ type: "text", text: "boom" }] } }), { painter: plain, expandHint: "x" });
		expect(row.render(80).slice(2)).toEqual(["  ⎿  Error: boom"]);
	});

	it("becomes Pi's own row once opened by a click", () => {
		const target = own({});
		const row = new ClaudeRow(target, { painter: plain, expandHint: "x" });
		const event = { type: "click", button: "left", x: 0, y: 1, screenX: 0, screenY: 1, width: 80, height: 6, shift: false, alt: false, ctrl: false } as const;
		expect(row.handleMouse(event)).toEqual({ handled: true });
		expect(row.render(80)).toEqual(["<native>"]);
	});
});

describe("helpers", () => {
	it("counts a Pi diff", () => {
		expect(countDiff("  1 a\n-2 b\n+2 c\n+3 d\n    ...")).toEqual({ added: 2, removed: 1 });
	});

	it("lists arguments", () => {
		expect(formatArguments({ a: "x\ny", b: [1] })).toBe('a: "x y", b: [1]');
	});
});
