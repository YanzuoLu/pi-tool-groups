/**
 * Which tool calls fold into a group, and what each one counts as in its summary.
 *
 * Like Claude Code in fullscreen mode, every shell command folds. A command that
 * only searches, reads, or lists counts as that, and anything else counts as a
 * shell command.
 */

export type Kind = "search" | "read" | "list" | "bash";

export type ToolArgs = Record<string, unknown>;

const SEARCH_PROGRAMS = new Set(["find", "fd", "grep", "egrep", "fgrep", "rg", "ag", "ack", "locate", "which", "whereis"]);
const READ_PROGRAMS = new Set([
	"cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq", "tr",
]);
const LIST_PROGRAMS = new Set(["ls", "tree", "du"]);
/** Commands that neither look at nor change anything, such as changing into the directory to look in. */
const NEUTRAL_PROGRAMS = new Set(["cd", "pushd", "popd", "echo", "printf", "true", "false", ":"]);
/** `find` actions that change the disk or run other programs. */
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

type Token = { word: string } | { separator: true };

/**
 * Split a command into words and command separators the way the shell would.
 * Returns undefined for anything this does not model, such as substitutions,
 * subshells, here documents, and redirections that write to a file.
 */
function tokenize(source: string): Token[] | undefined {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	const endWord = () => {
		if (inWord) tokens.push({ word });
		word = "";
		inWord = false;
	};
	const readTarget = (start: number): { target: string; next: number } => {
		let i = start;
		while (source[i] === " " || source[i] === "\t") i++;
		let target = "";
		while (i < source.length && !/[\s;&|<>()]/u.test(source[i]!)) target += source[i++];
		return { target, next: i };
	};
	for (let i = 0; i < source.length; i++) {
		const char = source[i]!;
		if (char === "\\") {
			if (source[i + 1] === "\n") {
				i++;
				continue;
			}
			word += source[i + 1] ?? "";
			inWord = true;
			i++;
		} else if (char === "'") {
			const end = source.indexOf("'", i + 1);
			if (end < 0) return undefined;
			word += source.slice(i + 1, end);
			inWord = true;
			i = end;
		} else if (char === '"') {
			let end = i + 1;
			while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
			if (end >= source.length) return undefined;
			const text = source.slice(i + 1, end);
			if (text.includes("$(") || text.includes("`")) return undefined;
			word += text.replace(/\\(.)/gu, "$1");
			inWord = true;
			i = end;
		} else if (char === "`" || char === "(" || char === ")" || (char === "$" && source[i + 1] === "(")) {
			return undefined;
		} else if (char === ">" || (char === "&" && source[i + 1] === ">")) {
			// A digit-only word right before the operator is the descriptor being redirected.
			if (/^\d*$/u.test(word)) {
				word = "";
				inWord = false;
			} else {
				endWord();
			}
			let next = char === "&" ? i + 2 : i + 1;
			if (source[next] === ">") next++;
			const duplicates = source[next] === "&";
			if (duplicates) next++;
			const { target, next: after } = readTarget(next);
			if (!(target === "/dev/null" || (duplicates && /^\d$/u.test(target)))) return undefined;
			i = after - 1;
		} else if (char === "<") {
			if (source[i + 1] === "<" || source[i + 1] === "(") return undefined;
			endWord();
			i = readTarget(i + 1).next - 1;
		} else if (char === ";" || char === "|" || char === "&" || char === "\n") {
			endWord();
			tokens.push({ separator: true });
			if ((char === "|" || char === "&") && source[i + 1] === char) i++;
		} else if (char === " " || char === "\t") {
			endWord();
		} else {
			if (char === "#" && !inWord) {
				const end = source.indexOf("\n", i);
				if (end < 0) break;
				i = end - 1;
				continue;
			}
			word += char;
			inWord = true;
		}
	}
	endWord();
	return tokens;
}

function kindOfProgram(words: readonly string[]): Kind | "neutral" {
	let start = 0;
	while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[start]!)) start++;
	if (start === words.length) return "neutral";
	const program = words[start]!.split("/").at(-1)!;
	if (NEUTRAL_PROGRAMS.has(program)) return "neutral";
	if (program === "find" && words.slice(start + 1).some((word) => FIND_ACTIONS.has(word))) return "bash";
	if (SEARCH_PROGRAMS.has(program)) return "search";
	if (READ_PROGRAMS.has(program)) return "read";
	if (LIST_PROGRAMS.has(program)) return "list";
	return "bash";
}

/** What a shell command counts as: a search, a read, a listing, or a shell command. */
export function classifyCommand(command: string): Kind {
	const tokens = tokenize(command);
	if (!tokens) return "bash";
	const seen = new Set<Kind>();
	let words: string[] = [];
	const flush = () => {
		if (words.length > 0) {
			const kind = kindOfProgram(words);
			if (kind !== "neutral") seen.add(kind);
		}
		words = [];
	};
	for (const token of tokens) {
		if ("separator" in token) flush();
		else words.push(token.word);
	}
	flush();
	if (seen.has("bash")) return "bash";
	if (seen.has("list")) return "list";
	if (seen.has("search")) return "search";
	if (seen.has("read")) return "read";
	return "bash";
}

/** What a call of a built-in tool counts as, or undefined when it keeps its own row. */
export function classifyTool(name: string, args: ToolArgs): Kind | undefined {
	switch (name) {
		case "read": return "read";
		case "grep": case "find": return "search";
		case "ls": return "list";
		case "bash": return classifyCommand(typeof args.command === "string" ? args.command : "");
		default: return undefined;
	}
}
