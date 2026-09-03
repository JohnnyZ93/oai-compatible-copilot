import * as vscode from "vscode";

/**
 * Session affinity support for upstream load balancers.
 *
 * The extension attaches a stable per-conversation session id to every request via a
 * configurable HTTP header (default `X-Session-ID`). The id is resolved with a layered
 * strategy so all requests within one conversation share the same routing key even when
 * VS Code does not round-trip custom `LanguageModelDataPart`s through the chat history:
 *
 * 1. A persisted data part in the history (reused across VS Code restarts when available).
 * 2. An in-process cache keyed by a stable conversation anchor (immune to history
 *    round-trip issues). The anchor is the full text of the first `<userRequest>`-tagged
 *    user message in the history, falling back to the first user text message when no
 *    tag exists.
 * 3. A freshly minted id as a last resort.
 */

/** MIME type used to persist the session id in the conversation history. */
export const SESSION_ID_MIME = "application/vnd.oaicopilot.session-id";

/** Default HTTP header name used for upstream load-balancer session affinity. */
export const DEFAULT_SESSION_ID_HEADER = "X-Session-ID";

/** Cap on cached anchors to avoid unbounded growth across many conversations. */
const MAX_CACHED_SESSION_IDS = 200;

/**
 * Derive the session id for a request.
 *
 * @param messages The conversation history for this request.
 * @param cache Optional in-process cache keyed by the conversation anchor; pass the
 * provider-level cache so one conversation reuses the same id across requests.
 * The anchor is derived from the first `<userRequest>`-tagged user message (falling
 * back to the first user text message), which stays stable within one conversation.
 * @param workspaceName Optional workspace name used to disambiguate conversations that
 * start with the same first user message across different workspaces.
 */
export function resolveSessionId(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	cache?: Map<string, string>,
	workspaceName = ""
): string {
	const anchor = getConversationAnchor(messages, workspaceName);

	// 1) The history may carry a persisted id if VS Code round-tripped our data part.
	const persisted = findPersistedSessionId(messages);
	if (persisted) {
		remember(cache, anchor, persisted);
		return persisted;
	}

	// 2) Reuse the id cached for this conversation's anchor.
	if (anchor) {
		const cached = cache?.get(anchor);
		if (cached) {
			return cached;
		}
		const id = randomSessionId();
		remember(cache, anchor, id);
		return id;
	}

	// 3) No anchor available (e.g. empty history) - mint a fresh id.
	return randomSessionId();
}

/** Regex matching a `<userRequest>...</userRequest>` block in a user message. */
const USER_REQUEST_TAG_REGEX = /<userRequest>([\s\S]*?)<\/userRequest>/;

/**
 * Extract a stable conversation anchor, optionally namespaced by the workspace name.
 *
 * Copilot agent-mode requests wrap the user's actual input in a `<userRequest>` tag
 * inside a user message whose surrounding template (`<environment_info>`,
 * `<workspace_info>`, memory summaries, ...) is regenerated on every turn, so the raw
 * first user text message is an unstable fingerprint. Instead the anchor uses the full
 * text of the first user message carrying a non-empty `<userRequest>` tag: history
 * messages are immutable (requests only append), so that message never changes within a
 * conversation, and its context snapshot (current file, selection, ...) distinguishes
 * conversations far better than the bare tag content. When no such message exists
 * (e.g. plain chat), it falls back to the first non-empty user text message.
 *
 * Prepending the workspace name further distinguishes conversations that happen to
 * share the same anchor in different workspaces.
 */
export function getConversationAnchor(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	workspaceName = ""
): string {
	const tagged = findFirstUserRequestMessage(messages);
	if (tagged !== null) {
		return workspaceName ? `${workspaceName}\n${tagged}` : tagged;
	}

	for (const m of messages) {
		if (m.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		const texts: string[] = [];
		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart && typeof part.value === "string") {
				texts.push(part.value);
			}
		}
		const joined = texts.join("\n").trim();
		if (joined) {
			return workspaceName ? `${workspaceName}\n${joined}` : joined;
		}
	}
	return "";
}

/**
 * Return the full text of the first user message that carries a non-empty
 * `<userRequest>` tag, or null when no such message exists. Text parts of each message
 * are joined first so a tag split across parts is still matched.
 */
function findFirstUserRequestMessage(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): string | null {
	for (const m of messages) {
		if (m.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		const texts: string[] = [];
		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart && typeof part.value === "string") {
				texts.push(part.value);
			}
		}
		const joined = texts.join("\n");
		const match = USER_REQUEST_TAG_REGEX.exec(joined);
		if (!match) {
			continue;
		}
		if (match[1].trim() === "") {
			continue; // Tag present but empty - skip to the next message.
		}
		return joined.trim();
	}
	return null;
}

/** Store an id for an anchor, bounding the cache size. */
function remember(cache: Map<string, string> | undefined, anchor: string, id: string): void {
	if (!cache || !anchor) {
		return;
	}
	if (cache.size >= MAX_CACHED_SESSION_IDS) {
		// Drop the oldest entries (Map preserves insertion order).
		const oldest = cache.keys().next().value as string | undefined;
		if (oldest) {
			cache.delete(oldest);
		}
	}
	cache.set(anchor, id);
}

function findPersistedSessionId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | null {
	// Walk the history back to front and reuse the most recent session id we persisted.
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[i].content ?? []) {
			const parsed = parseSessionIdPart(part);
			if (parsed) {
				return parsed;
			}
		}
	}
	return null;
}

/** Generate a compact, unique-enough id for routing purposes. */
export function randomSessionId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Wrap a session id so it can be persisted in the conversation history. */
export function createSessionIdPart(sessionId: string): vscode.LanguageModelDataPart {
	const bytes = new TextEncoder().encode(sessionId);
	return new vscode.LanguageModelDataPart(bytes, SESSION_ID_MIME);
}

/** Extract the session id from a conversation-history data part, or null if absent. */
export function parseSessionIdPart(part: unknown): string | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== "object") {
		return null;
	}
	if (typeof maybe.mimeType !== "string") {
		return null;
	}
	if (maybe.mimeType !== SESSION_ID_MIME) {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	const id = new TextDecoder().decode(maybe.data).trim();
	return id ? id : null;
}

/**
 * Whether session-affinity headers should be attached.
 * A `none` (case-insensitive) or empty/whitespace-only value disables the feature.
 */
export function isSessionIdHeaderEnabled(headerName: string | undefined): boolean {
	const name = headerName?.trim() ?? "";
	return name !== "" && name.toLowerCase() !== "none";
}
