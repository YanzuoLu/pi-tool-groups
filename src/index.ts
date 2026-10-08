import {
	AssistantMessageComponent,
	BashExecutionComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Painter } from "./format.ts";
import { groupChildren, kindOf, ToolGroup, type GroupState, type Role, type ThoughtLike, type ToolRow } from "./group.ts";
import { ClaudeRow, type OwnRow } from "./row.ts";

const WIDGET_KEY = "pi-tool-groups";
const HOOK_KEY = Symbol.for("pi-tool-groups.chat-render");

type Render = (this: unknown, ...args: unknown[]) => unknown;
type Hook = { behavior: (self: { children: unknown[] }, args: unknown[], original: Render) => unknown };

/**
 * Route `target[method]` through `behavior`. Pi's chat outlives a /reload while
 * this module does not, so the wrapper is installed once and each load only
 * swaps the behavior it calls.
 */
function hookMethod(target: object, method: string, behavior: Hook["behavior"]): void {
	const holder = target as Record<PropertyKey, unknown>;
	const existing = holder[HOOK_KEY] as Hook | undefined;
	if (existing) {
		existing.behavior = behavior;
		return;
	}
	const original = holder[method] as Render;
	const hook: Hook = { behavior };
	holder[method] = function (this: { children: unknown[] }, ...args: unknown[]) {
		return hook.behavior(this, args, original);
	};
	Object.defineProperty(holder, HOOK_KEY, { value: hook });
}

/** Pi's chat is the last child of the document container, the TUI's first child. */
function findChat(tui: unknown): { children: unknown[] } | undefined {
	const document = (tui as { children?: Array<{ children?: unknown[] }> }).children?.[0]?.children;
	const chat = document?.at(-1) as { children?: unknown } | undefined;
	return chat && Array.isArray(chat.children) ? (chat as { children: unknown[] }) : undefined;
}

/** `instanceof`, also across copies of Pi's classes loaded from another path. */
function isKind(child: unknown, kind: abstract new (...args: never[]) => unknown): boolean {
	return child instanceof kind || (typeof child === "object" && child !== null && child.constructor?.name === kind.name);
}

type AssistantLike = {
	lastMessage?: { content: Array<{ type: string; text?: string; thinking?: string }>; stopReason?: string };
};

/** A turn's role: its answer text, or an error with no call to show it, ends a group; thinking alone anchors one. */
function assistantRole(child: AssistantLike): Role {
	const message = child.lastMessage;
	if (!message) return "neutral";
	if (message.content.some((block) => block.type === "text" && block.text?.trim())) return "breaker";
	const calls = message.content.some((block) => block.type === "toolCall");
	if (!calls && (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")) return "breaker";
	return message.content.some((block) => block.type === "thinking" && block.thinking?.trim()) ? "thought" : "neutral";
}

/**
 * Only what someone says or does ends a group: your messages and commands, the
 * model's answers, and calls that keep their own row. Anything else, whichever
 * extension added it, folds in when it sits between two members.
 */
function roleOf(child: unknown): Role {
	if (isKind(child, ToolExecutionComponent)) return kindOf(child as ToolRow) ? "member" : "breaker";
	if (isKind(child, AssistantMessageComponent)) return assistantRole(child as AssistantLike);
	if (isKind(child, UserMessageComponent) || isKind(child, BashExecutionComponent) || isKind(child, SkillInvocationMessageComponent)) {
		return "breaker";
	}
	return "neutral";
}

type ScrollLike = { scrollTop: number; isFollowingEnd: boolean; scrollTo(top: number, options: { disableFollow: boolean }): void };

/**
 * In fullscreen mode a view that follows the end would push a line opened by a
 * click up and away. Stop following there, so the line stays under the pointer
 * and what opens below it pushes nothing above.
 */
function holdViewport(tui: unknown): void {
	const view = (tui as { getPrimaryScrollView?: () => ScrollLike | undefined }).getPrimaryScrollView?.();
	if (view?.isFollowingEnd) view.scrollTo(view.scrollTop, { disableFollow: true });
}

type Message = { role?: string; timestamp?: number };

export default function toolGroups(pi: ExtensionAPI): void {
	/** When each assistant turn, keyed by its start time, finished streaming. */
	const finished = new Map<number, number>();
	const groupStates = new WeakMap<object, GroupState>();
	const ownRows = new WeakMap<object, ClaudeRow>();
	/** Whether the agent is running, kept from events: a ctx must not be read while drawing, as a reload makes it stale. */
	let running = false;
	const agentRunning = () => running;
	/** Pi's chat, while this load draws it. */
	let hookedChat: object | undefined;

	const remember = (ctx: ExtensionContext) => {
		finished.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message as Message;
			if (message.role === "assistant" && typeof message.timestamp === "number") {
				finished.set(message.timestamp, Date.parse(entry.timestamp));
			}
		}
	};

	pi.on("message_end", (event) => {
		const message = event.message as Message;
		if (message.role === "assistant" && typeof message.timestamp === "number") finished.set(message.timestamp, Date.now());
	});

	pi.on("agent_start", () => {
		running = true;
	});
	pi.on("agent_end", () => {
		running = false;
	});

	// The chat outlives this load. Hand its drawing back to Pi before a reload or
	// session switch, so nothing from this load runs once it is gone.
	pi.on("session_shutdown", (_event, ctx) => {
		if (hookedChat) hookMethod(hookedChat, "render", (self, args, original) => original.apply(self, args));
		hookedChat = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		running = false;
		remember(ctx);
		// An invisible widget is the extension API's way to reach Pi's TUI and its chat.
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			const chat = findChat(tui);
			if (chat) {
				hookedChat = chat;
				hookMethod(chat, "render", (self, args, original) => {
					const children = self.children;
					const width = args[0] as number;
					const painter = theme as Painter;
					const requestRender = () => tui.requestRender();
					const beforeToggle = () => holdViewport(tui);
					const finishedAt = (message: { timestamp: number }) => finished.get(message.timestamp);

					const makeGroup = (members: unknown[]) => {
						let state = groupStates.get(members[0] as object);
						if (!state) {
							state = { expanded: false };
							groupStates.set(members[0] as object, state);
						}
						const rows = members.filter((member) => roleOf(member) === "member") as ToolRow[];
						const thoughts = members.filter((member) => roleOf(member) === "thought") as ThoughtLike[];
						return new ToolGroup(rows, thoughts, members as Component[], {
							painter, state, finishedAt, requestRender, beforeToggle, agentRunning,
						});
					};
					const ownRow = (child: unknown) => {
						if (!isKind(child, ToolExecutionComponent) || kindOf(child as ToolRow)) return child;
						let row = ownRows.get(child as object);
						if (!row) {
							row = new ClaudeRow(child as OwnRow, { painter, requestRender, beforeToggle, agentRunning });
							ownRows.set(child as object, row);
						}
						return row;
					};

					const grouped = groupChildren(children, roleOf, makeGroup).map(ownRow);
					const last = grouped.findLastIndex((child) => child instanceof ToolGroup);
					if (last >= 0 && agentRunning()) {
						const after = grouped.slice(last + 1) as Component[];
						(grouped[last] as ToolGroup).working = after.every((child) => child.render(width).length === 0);
					}
					self.children = grouped;
					try {
						return original.apply(self, args);
					} finally {
						self.children = children;
					}
				});
			}
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
	});
}
