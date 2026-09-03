import * as assert from "assert";
import * as vscode from "vscode";
import {
	createSessionIdPart,
	DEFAULT_SESSION_ID_HEADER,
	getConversationAnchor,
	isSessionIdHeaderEnabled,
	parseSessionIdPart,
	randomSessionId,
	resolveSessionId,
	SESSION_ID_MIME,
} from "../sessionId";

function makeMessage(role: vscode.LanguageModelChatMessageRole, content: unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role, content, name: undefined } as vscode.LanguageModelChatRequestMessage;
}

function sessionPart(sessionId: string): vscode.LanguageModelDataPart {
	return createSessionIdPart(sessionId);
}

suite("sessionId", () => {
	test("mints a fresh id when history has no persisted session id", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("hello")]),
		];
		const id = resolveSessionId(messages);
		assert.ok(id.length > 0, "should return a non-empty id");
	});

	test("mints a fresh id when history is empty", () => {
		const id = resolveSessionId([]);
		assert.ok(id.length > 0, "should return a non-empty id");
	});

	test("reuses the session id persisted in a prior assistant message", () => {
		const persisted = "abc123";
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("hello")]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelTextPart("hi"),
				sessionPart(persisted),
			]),
		];
		assert.strictEqual(resolveSessionId(messages), persisted);
	});

	test("prefers the most recent persisted session id", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [sessionPart("old-id")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("more")]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [sessionPart("new-id")]),
		];
		assert.strictEqual(resolveSessionId(messages), "new-id");
	});

	test("ignores data parts with other mime types", () => {
		const foreign = new vscode.LanguageModelDataPart(
			new TextEncoder().encode("whatever"),
			"application/vnd.oaicopilot.stateful-marker"
		);
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelTextPart("hi"),
				foreign,
			]),
		];
		// No session id persisted -> mint a fresh one, and it must not be the foreign payload.
		const id = resolveSessionId(messages);
		assert.notStrictEqual(id, "whatever");
	});

	test("does not treat user messages as a source of session ids", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [sessionPart("user-side-id")]),
		];
		const id = resolveSessionId(messages);
		assert.notStrictEqual(id, "user-side-id");
	});

	test("reuses the cached id for the same conversation anchor", () => {
		const cache = new Map<string, string>();
		const firstTurn = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("refactor this")]),
		];
		const secondTurn = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("refactor this")]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("done")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("now explain")]),
		];

		const firstId = resolveSessionId(firstTurn, cache);
		const secondId = resolveSessionId(secondTurn, cache);
		assert.strictEqual(secondId, firstId);
	});

	test("mints a different id for a different conversation anchor", () => {
		const cache = new Map<string, string>();
		const convA = [makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("question one")])];
		const convB = [makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("question two")])];

		const idA = resolveSessionId(convA, cache);
		const idB = resolveSessionId(convB, cache);
		assert.notStrictEqual(idB, idA);
	});

	test("distinguishes same first message across different workspaces", () => {
		const cache = new Map<string, string>();
		const convA = [makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("explain this code")])];
		const convB = [makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("explain this code")])];

		const idA = resolveSessionId(convA, cache, "backend");
		const idB = resolveSessionId(convB, cache, "frontend");
		assert.notStrictEqual(idB, idA);

		// Same workspace reuses the id across turns.
		const turn2 = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("explain this code")]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("sure")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("and this too")]),
		];
		assert.strictEqual(resolveSessionId(turn2, cache, "backend"), idA);
	});

	test("persisted history id wins over the in-process cache", () => {
		const cache = new Map<string, string>();
		const firstTurn = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("question")]),
		];
		const firstId = resolveSessionId(firstTurn, cache);

		// Same conversation, but the history now carries a persisted id (e.g. restored
		// from a previous VS Code session) that differs from the cached one.
		const restoredTurn = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("question")]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [sessionPart("restored-id")]),
		];
		assert.strictEqual(resolveSessionId(restoredTurn, cache), "restored-id");
		assert.notStrictEqual(firstId, "restored-id");
	});

	test("getConversationAnchor returns the first user text message", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("hello world")]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("hi")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("second")]),
		];
		assert.strictEqual(getConversationAnchor(messages), "hello world");
	});

	test("getConversationAnchor namespaces the anchor with the workspace name", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("hello world")]),
		];
		assert.strictEqual(getConversationAnchor(messages, "my-project"), "my-project\nhello world");
		assert.strictEqual(getConversationAnchor(messages, ""), "hello world");
	});

	test("getConversationAnchor skips empty/whitespace-only user messages", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("   ")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("real question")]),
		];
		assert.strictEqual(getConversationAnchor(messages), "real question");
	});

	test("getConversationAnchor prefers the first user message carrying a <userRequest> tag over the environment template", () => {
		const requestMsg = new vscode.LanguageModelTextPart(
			"<context>\n...\n</context>\n<userRequest>hi</userRequest>"
		);
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart(
					"<environment_info>\nThe user's current OS is: macOS\n</environment_info>\n<workspace_info>\n...\n</workspace_info>"
				),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [requestMsg]),
		];
		assert.strictEqual(
			getConversationAnchor(messages),
			"<context>\n...\n</context>\n<userRequest>hi</userRequest>"
		);
	});

	test("getConversationAnchor stays stable across turns with changing environment templates", () => {
		const envTurn1 = new vscode.LanguageModelTextPart(
			"<environment_info>os A</environment_info>\n<workspace_info>folder A</workspace_info>"
		);
		const envTurn2 = new vscode.LanguageModelTextPart(
			"<environment_info>os A</environment_info>\n<workspace_info>folder A, now with a longer task list</workspace_info>\n<repoMemory>extra memory</repoMemory>"
		);
		const firstTurn = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [envTurn1]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>file.ts</context>\n<userRequest>hi</userRequest>"),
			]),
		];
		const secondTurn = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [envTurn2]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>file.ts</context>\n<userRequest>hi</userRequest>"),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("hello!")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [envTurn2]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>file.ts</context>\n<userRequest>explain more</userRequest>"),
			]),
		];
		assert.strictEqual(getConversationAnchor(firstTurn), "<context>file.ts</context>\n<userRequest>hi</userRequest>");
		assert.strictEqual(getConversationAnchor(secondTurn), "<context>file.ts</context>\n<userRequest>hi</userRequest>");
	});

	test("getConversationAnchor distinguishes same request text with different context snapshots", () => {
		const convA = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>a.ts</context>\n<userRequest>hi</userRequest>"),
			]),
		];
		const convB = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>b.ts</context>\n<userRequest>hi</userRequest>"),
			]),
		];
		assert.notStrictEqual(getConversationAnchor(convA), getConversationAnchor(convB));
	});

	test("getConversationAnchor matches a tag split across multiple text parts", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>a.ts</context>\n<userRequest>fix the"),
				new vscode.LanguageModelTextPart(" bug</userRequest>"),
			]),
		];
		assert.strictEqual(
			getConversationAnchor(messages),
			"<context>a.ts</context>\n<userRequest>fix the\n bug</userRequest>"
		);
	});

	test("getConversationAnchor skips messages with empty tags and falls through to the next message", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>a.ts</context>\n<userRequest>   </userRequest>"),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<context>b.ts</context>\n<userRequest>real question</userRequest>"),
			]),
		];
		assert.strictEqual(
			getConversationAnchor(messages),
			"<context>b.ts</context>\n<userRequest>real question</userRequest>"
		);
	});

	test("getConversationAnchor namespaces a tagged anchor with the workspace name", () => {
		const messages = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<environment_info>...</environment_info>"),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<userRequest>hi</userRequest>"),
			]),
		];
		assert.strictEqual(getConversationAnchor(messages, "my-project"), "my-project\n<userRequest>hi</userRequest>");
	});

	test("resolveSessionId reuses the cached id across turns with changing environment templates", () => {
		const cache = new Map<string, string>();
		const turn1 = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<environment_info>os A</environment_info>"),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<userRequest>hi</userRequest>"),
			]),
		];
		const id1 = resolveSessionId(turn1, cache);
		const turn2 = [
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart(
					"<environment_info>os A</environment_info>\n<repoMemory>new</repoMemory>"
				),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<userRequest>hi</userRequest>"),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("hello!")]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart(
					"<environment_info>os A</environment_info>\n<repoMemory>new</repoMemory>"
				),
			]),
			makeMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("<userRequest>explain more</userRequest>"),
			]),
		];
		assert.strictEqual(resolveSessionId(turn2, cache), id1);
	});

	test("getConversationAnchor returns empty string when there is no user text", () => {
		assert.strictEqual(getConversationAnchor([]), "");
		assert.strictEqual(
			getConversationAnchor([makeMessage(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("hi")])]),
			""
		);
	});

	test("randomSessionId returns distinct non-empty values", () => {
		const a = randomSessionId();
		const b = randomSessionId();
		assert.ok(a.length > 0);
		assert.notStrictEqual(a, b);
	});

	test("createSessionIdPart / parseSessionIdPart round-trip", () => {
		const part = sessionPart("sess-42");
		assert.strictEqual(part.mimeType, SESSION_ID_MIME);
		assert.strictEqual(parseSessionIdPart(part), "sess-42");
	});

	test("parseSessionIdPart rejects wrong mime, non-Uint8Array data, and empty payloads", () => {
		assert.strictEqual(parseSessionIdPart(null), null);
		assert.strictEqual(parseSessionIdPart(undefined), null);
		assert.strictEqual(parseSessionIdPart({ mimeType: "text/plain", data: new TextEncoder().encode("x") }), null);
		assert.strictEqual(parseSessionIdPart({ mimeType: SESSION_ID_MIME, data: "not-bytes" }), null);
		assert.strictEqual(parseSessionIdPart({ mimeType: SESSION_ID_MIME, data: new TextEncoder().encode("  ") }), null);
		assert.strictEqual(parseSessionIdPart({ mimeType: SESSION_ID_MIME, data: new TextEncoder().encode("  ok  ") }), "ok");
	});

	test("isSessionIdHeaderEnabled honors the disable values", () => {
		assert.strictEqual(isSessionIdHeaderEnabled("X-Session-ID"), true);
		assert.strictEqual(isSessionIdHeaderEnabled(DEFAULT_SESSION_ID_HEADER), true);
		assert.strictEqual(isSessionIdHeaderEnabled("none"), false);
		assert.strictEqual(isSessionIdHeaderEnabled("None"), false);
		assert.strictEqual(isSessionIdHeaderEnabled(""), false);
		assert.strictEqual(isSessionIdHeaderEnabled("   "), false);
		assert.strictEqual(isSessionIdHeaderEnabled(undefined), false);
	});
});
