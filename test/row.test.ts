import { describe, expect, it } from "vitest";
import type { Painter } from "../src/format.ts";
import { ClaudeRow, countDiff, formatArguments, type OwnRow } from "../src/row.ts";

const plain: Painter = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text, bg: (_color, text) => `<bg>${text}\x1b[49m` };
const options = { painter: plain, requestRender() {} };
const dot = process.platform === "darwin" ? "⏺" : "●";

function own(extra: Partial<OwnRow>): OwnRow {
	return {
		toolName: "web_search",
		args: { query: "pi tui", limit: 3 },
		result: { content: [{ type: "text", text: "a\nb\nc\nd\ne" }] },
		render: () => ["<native>"],
		invalidate() {},
		...extra,
	};
}

describe("ClaudeRow", () => {
	it("draws a marker, Name(arguments), and a short result", () => {
		const row = new ClaudeRow(own({ toolDefinition: { label: "Web Search" } }), options);
		expect(row.render(80)).toEqual([
			"",
			`${dot} Web Search(query: "pi tui", limit: 3)`,
			"  ⎿  a",
			"     b",
			"     c",
			"     … +2 lines",
		]);
	});

	it("shows a failure in place of the output", () => {
		const row = new ClaudeRow(own({ result: { isError: true, content: [{ type: "text", text: "boom" }] } }), options);
		expect(row.render(80).slice(2)).toEqual(["  ⎿  Error: boom"]);
	});

	it("opens to Pi's own row on a click when it leaves output out, and closes the same way", () => {
		const row = new ClaudeRow(own({}), options);
		row.render(80);
		const event = { type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 80, height: 6, shift: false, alt: false, ctrl: false } as const;
		expect(row.handleMouse(event)).toEqual({ handled: true });
		expect(row.render(10)).toEqual(["<bg><native>  \x1b[49m", "<bg>          \x1b[49m"]);
		row.handleMouse({ ...event, y: 0 });
		expect(row.render(80)[1]).toContain("query");
	});

	it("does not open when nothing was left out", () => {
		const row = new ClaudeRow(own({ result: { content: [{ type: "text", text: "a" }] } }), options);
		row.render(80);
		const event = { type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false } as const;
		expect(row.handleMouse(event)).toBeUndefined();
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
