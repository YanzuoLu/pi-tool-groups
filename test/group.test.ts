import { describe, expect, it } from "vitest";
import { classifyCommand, classifyTool } from "../src/classify.ts";
import { formatDuration, previewOutput, type Painter } from "../src/format.ts";
import { groupChildren, summarize, tally, ToolGroup, type GroupState, type Role, type ToolRow } from "../src/group.ts";

describe("classifyCommand", () => {
	it.each([
		["rg -n foo src", "search"],
		["cd /repo && rg 'a|b' src 2>/dev/null | head -20", "search"],
		["cd /repo; grep -rn x . ; echo done", "search"],
		["cat a.txt | wc -l", "read"],
		["ls -la && find . -name '*.ts'", "list"],
		["FOO=1 head -5 file", "read"],
		["/usr/bin/tail -f log 2>&1", "read"],
		["git status", "bash"],
		["rg foo > out.txt", "bash"],
		["cat $(ls)", "bash"],
		["find . -name x -delete", "bash"],
		["cat <<EOF\nx\nEOF", "bash"],
		["cd /repo", "bash"],
		['rg "a;b" src', "search"],
	])("%s is %s", (command, kind) => {
		expect(classifyCommand(command)).toBe(kind);
	});

	it("leaves edits and other tools to their own rows", () => {
		expect(classifyTool("edit", { path: "a" })).toBeUndefined();
		expect(classifyTool("update_plan", {})).toBeUndefined();
		expect(classifyTool("grep", { pattern: "x" })).toBe("search");
	});
});

describe("summarize", () => {
	it("words parts like Claude Code", () => {
		expect(summarize({ search: 2, read: 1, list: 0, bash: 3 }, false, undefined)).toBe(
			"Searched for 2 patterns, read 1 file, ran 3 shell commands",
		);
		expect(summarize({ search: 0, read: 0, list: 1, bash: 1 }, true, undefined)).toBe("Listing 1 directory, running 1 shell command");
	});

	it("leads with the thinking time, at least one second", () => {
		expect(summarize({ search: 0, read: 2, list: 0, bash: 0 }, false, 12_400)).toBe("Thought for 12s, read 2 files");
		expect(summarize({ search: 0, read: 0, list: 0, bash: 0 }, true, 300)).toBe("Thinking for 1s");
	});

	it("counts distinct paths for the read tool", () => {
		const rows = [
			{ toolName: "read", args: { path: "a" } },
			{ toolName: "read", args: { path: "a", offset: 10 } },
			{ toolName: "bash", args: { command: "cat b" } },
		];
		expect(tally(rows)).toEqual({ search: 0, read: 2, list: 0, bash: 0 });
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "0s"],
		[59_999, "59s"],
		[65_000, "1m 5s"],
		[3_603_000, "1h 0m 3s"],
	])("%d ms is %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});
});

describe("previewOutput", () => {
	it("shows three rows, or four when only one more would hide", () => {
		expect(previewOutput("1\n2\n3\n4", 80).rows).toEqual(["1", "2", "3", "4"]);
		expect(previewOutput("1\n2\n3\n4\n5", 80)).toEqual({ rows: ["1", "2", "3"], more: "… +2 lines" });
	});
});

describe("groupChildren", () => {
	const roles: Record<string, Role> = { r: "member", t: "thought", n: "neutral", b: "breaker" };
	const run = (children: string[]) =>
		groupChildren(children, (child) => roles[child[0]!]!, (members) => `[${members.join(",")}]`);

	it("folds what sits between two anchors where it stands", () => {
		expect(run(["b1", "r1", "n1", "r2", "n2", "b2", "r3", "n3"])).toEqual(["b1", "[r1,n1,r2]", "n2", "b2", "[r3]", "n3"]);
	});

	it("lets thinking open a group and join the calls after it", () => {
		expect(run(["n1", "t1", "n2", "r1", "t2", "b1"])).toEqual(["n1", "[t1,n2,r1,t2]", "b1"]);
		expect(run(["t1", "b1"])).toEqual(["[t1]", "b1"]);
	});
});

const plain: Painter = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };

function row(toolName: string, args: Record<string, unknown>, done = true, extra: Partial<ToolRow> = {}): ToolRow {
	return {
		toolName,
		args,
		result: done ? { content: [{ type: "text", text: "ok" }] } : undefined,
		render: () => [`<${toolName}>`],
		invalidate() {},
		...extra,
	};
}

function group(rows: ToolRow[], options: { state?: GroupState; now?: () => number } = {}) {
	const state = options.state ?? { expanded: false };
	return new ToolGroup(rows, [], rows, {
		painter: plain,
		state,
		finishedAt: () => undefined,
		requestRender() {},
		now: options.now,
	});
}

const click = (x: number, y: number) =>
	({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 10, shift: false, alt: false, ctrl: false }) as const;

describe("ToolGroup", () => {
	it("draws one dim line when done", () => {
		const rows = [row("read", { path: "a" }), row("bash", { command: "make" })];
		expect(group(rows).render(80)).toEqual(["", "  Read 1 file, ran 1 shell command"]);
	});

	it("opens to its members on a click on text, and closes from its show-less line", () => {
		const state = { expanded: false };
		const g = group([row("read", { path: "a" }), row("bash", { command: "make" })], { state });
		g.render(20);
		expect(g.handleMouse(click(0, 1))).toBeUndefined();
		expect(g.handleMouse(click(4, 1))).toEqual({ handled: true });
		expect(state.expanded).toBe(true);
		expect(g.render(8)).toEqual(["<read>", "<bash>", "", " show less"]);
		expect(g.handleMouse(click(1, 0))).toBeUndefined();
		expect(state.expanded).toBe(true);
		g.handleMouse(click(2, 3));
		expect(state.expanded).toBe(false);
	});

	it("stays live while the agent works right after it", () => {
		const g = group([row("read", { path: "a" })], { now: () => 600 });
		g.working = true;
		expect(g.render(80)[1]).toBe("  Reading 1 file…");
		expect(g.render(80)[2]).toBe("  ⎿  a");
	});

	it("shows elapsed time and the running command", () => {
		let now = 0;
		const rows = [row("grep", { pattern: "x" }), row("bash", { command: "sleep 10\necho" }, false)];
		const g = group(rows, { now: () => now });
		expect(g.render(80)[1]).toBe(`${process.platform === "darwin" ? "⏺" : "●"} Searching for 1 pattern, running 1 shell command…`);
		now = 3000;
		expect(g.render(80).slice(1)).toEqual([
			"  Searching for 1 pattern, running 1 shell command · 3s…",
			"  ⎿  $ sleep 10 … (3s)",
		]);
	});
});

describe("an opened ToolGroup", () => {
	it("passes clicks on a member to that member", () => {
		const seen: number[] = [];
		const member = { ...row("read", { path: "a" }), render: () => ["", "<read>"], handleMouse: (event: { y: number }) => (seen.push(event.y), { handled: true }) };
		const g = group([row("bash", { command: "x" }), member as ToolRow], { state: { expanded: true } });
		g.render(20);
		expect(g.handleMouse(click(1, 2))).toEqual({ handled: true });
		expect(seen).toEqual([1]);
	});
});
