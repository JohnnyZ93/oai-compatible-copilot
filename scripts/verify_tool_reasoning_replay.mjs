import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}

class LanguageModelThinkingPart {
	constructor(value) {
		this.value = value;
	}
}

class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}

class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}

class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
	toString() {
		return this.content
			.map((part) => (part instanceof LanguageModelTextPart ? part.value : ""))
			.join("");
	}
	async asString() {
		return this.toString();
	}
}

class ThemeColor {
	constructor(id) {
		this.id = id;
	}
}

const Uri = {
	file(fsPath) {
		return { fsPath };
	},
	joinPath(base, ...segments) {
		return { fsPath: path.join(base.fsPath, ...segments) };
	},
};

class MemoryMemento {
	constructor(seed = new Map()) {
		this.store = seed;
	}
	get(key, defaultValue) {
		return this.store.has(key) ? this.store.get(key) : defaultValue;
	}
	async update(key, value) {
		this.store.set(key, value);
	}
}

const mockVscode = {
	LanguageModelTextPart,
	LanguageModelThinkingPart,
	LanguageModelDataPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	version: "1.104.0-test",
	Uri,
	LanguageModelChatMessageRole: {
		User: 1,
		Assistant: 2,
		System: 3,
	},
	LanguageModelChatToolMode: {
		Required: 1,
	},
	ThemeColor,
	workspace: {
		getConfiguration() {
			return {
				get(key, defaultValue) {
					if (key === "oaicopilot.models") {
						return [
							{
								id: "glm-5.1",
								configId: "variant-a",
								owned_by: "zai",
								apiMode: "openai",
								baseUrl: "https://example.invalid/v1",
								include_reasoning_in_request: true,
							},
							{
								id: "glm-5.1",
								configId: "variant-b",
								owned_by: "zai",
								apiMode: "openai",
								baseUrl: "https://example.invalid/v1",
								include_reasoning_in_request: false,
							},
						];
					}
					if (key === "oaicopilot.delay") {
						return 0;
					}
					return defaultValue;
				},
			};
		},
	},
	window: {
		showInputBox: async () => "",
	},
	extensions: {
		getExtension() {
			return { packageJSON: { version: "0.3.4-test" } };
		},
	},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "vscode") {
		return mockVscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

const originalFetch = globalThis.fetch;
let originalProcessStreamingResponse;

try {
	const extensionRoot = path.resolve(__dirname, "..");
	const outDir = path.resolve(__dirname, "../out");
	const { TokenizerManager } = require(path.join(outDir, "tokenizer/tokenizerManager.js"));
	const { HuggingFaceChatModelProvider } = require(path.join(outDir, "provider.js"));
	const { OpenaiApi } = require(path.join(outDir, "openai/openaiApi.js"));
	TokenizerManager.initialize(extensionRoot);

	const sharedStore = new Map();
	const reasoningState = new MemoryMemento(sharedStore);
	const statusBarItem = { text: "", tooltip: "", backgroundColor: undefined, show() {} };
	const secrets = { get: async () => "dummy-api-key", store: async () => {}, delete: async () => {} };
	const reasoningOnModel = { id: "glm-5.1::variant-a", maxInputTokens: 100000, maxOutputTokens: 4096 };
	const reasoningOffModel = { id: "glm-5.1::variant-b", maxInputTokens: 100000, maxOutputTokens: 4096 };
	const token = { isCancellationRequested: false };
	const USER = mockVscode.LanguageModelChatMessageRole.User;
	const SYSTEM = mockVscode.LanguageModelChatMessageRole.System;

	const weatherTool = {
		name: "get_weather",
		description: "Get weather information",
		inputSchema: {
			type: "object",
			properties: {
				city: { type: "string" },
			},
			required: ["city"],
		},
	};

	const firstTurnMessages = [
		{ role: SYSTEM, content: [new LanguageModelTextPart("You are an assistant")] },
		{ role: USER, content: [new LanguageModelTextPart("What's the weather like in Beijing?")] },
	];

	const replayedAssistant = {
		role: mockVscode.LanguageModelChatMessageRole.Assistant,
		content: [
			new LanguageModelTextPart("I'll check that for you."),
			new LanguageModelToolCallPart("call_weather_1", "get_weather", { city: "Beijing" }),
		],
	};

	const secondTurnMessages = [
		firstTurnMessages[0],
		firstTurnMessages[1],
		replayedAssistant,
		{
			role: USER,
			content: [
				new LanguageModelToolResultPart("call_weather_1", [
					new LanguageModelTextPart('{"weather":"Sunny","temp":"25°C"}'),
				]),
			],
		},
		{ role: USER, content: [new LanguageModelTextPart("Summarize the result.")] },
	];

	const requestBodies = [];
	globalThis.fetch = async (_url, init) => {
		requestBodies.push(JSON.parse(init.body));
		return { ok: true, body: {} };
	};

	let invocation = 0;
	originalProcessStreamingResponse = OpenaiApi.prototype.processStreamingResponse;
	OpenaiApi.prototype.processStreamingResponse = async function (_body, progress) {
		invocation += 1;
		if (invocation === 1) {
			progress.report(new LanguageModelThinkingPart("I should call the weather tool before replying."));
			progress.report(new LanguageModelTextPart("I'll check that for you."));
			progress.report(new LanguageModelToolCallPart("call_weather_1", "get_weather", { city: "Beijing" }));
			return;
		}
		progress.report(new LanguageModelTextPart("It is sunny and 25°C."));
	};

	const firstProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, reasoningState);
	await firstProvider.provideLanguageModelChatResponse(
		reasoningOnModel,
		firstTurnMessages,
		{ tools: [weatherTool], requestInitiator: "github.copilot-chat" },
		{ report() {} },
		token
	);

	const secondProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, reasoningState);
	await secondProvider.provideLanguageModelChatResponse(
		reasoningOnModel,
		secondTurnMessages,
		{ tools: [weatherTool], requestInitiator: "github.copilot-chat" },
		{ report() {} },
		token
	);

	const replayRequest = requestBodies.at(-1);
	const assistantMessage = replayRequest.messages.find((message) => message.role === "assistant");
	const toolMessage = replayRequest.messages.find((message) => message.role === "tool");
	if (!assistantMessage) {
		throw new Error("Assistant replay message missing from replay request");
	}
	if (assistantMessage.content !== "I'll check that for you.") {
		throw new Error(`Unexpected assistant replay content: ${assistantMessage.content ?? "<missing>"}`);
	}
	if (assistantMessage.reasoning_content !== "I should call the weather tool before replying.") {
		throw new Error(`Unexpected replayed reasoning_content: ${assistantMessage.reasoning_content ?? "<missing>"}`);
	}
	if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length !== 1) {
		throw new Error("Replayed assistant tool_calls missing or malformed");
	}
	if (assistantMessage.tool_calls[0].id !== "call_weather_1") {
		throw new Error("Replayed assistant tool call id mismatch");
	}
	if (assistantMessage.tool_calls[0].function.name !== "get_weather") {
		throw new Error("Replayed assistant tool call name mismatch");
	}
	if (!toolMessage || toolMessage.tool_call_id !== "call_weather_1") {
		throw new Error("Tool result replay missing or mismatched");
	}
	if (toolMessage.content !== '{"weather":"Sunny","temp":"25°C"}') {
		throw new Error("Tool result content replay mismatch");
	}

	console.log("Tool reasoning replay validation passed.");
	console.log(JSON.stringify({ assistantMessage, toolMessage }, null, 2));

	const thirdProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, reasoningState);
	await thirdProvider.provideLanguageModelChatResponse(
		reasoningOffModel,
		secondTurnMessages,
		{ tools: [weatherTool], requestInitiator: "github.copilot-chat" },
		{ report() {} },
		token
	);

	const noReasoningRequest = requestBodies.at(-1);
	const noReasoningAssistant = noReasoningRequest.messages.find((message) => message.role === "assistant");
	if (!noReasoningAssistant) {
		throw new Error("Assistant replay message missing for include_reasoning_in_request=false request");
	}
	if (noReasoningAssistant.reasoning_content !== undefined) {
		throw new Error("reasoning_content leaked into include_reasoning_in_request=false tool replay request");
	}
	if (!noReasoningAssistant.tool_calls || noReasoningAssistant.tool_calls.length !== 1) {
		throw new Error("Tool calls should remain present for include_reasoning_in_request=false tool replay request");
	}

	console.log("Tool variant-b isolation validation passed.");
	console.log(JSON.stringify(noReasoningAssistant, null, 2));
} finally {
	Module._load = originalLoad;
	globalThis.fetch = originalFetch;
	if (originalProcessStreamingResponse) {
		const outDir = path.resolve(__dirname, "../out");
		const { OpenaiApi } = require(path.join(outDir, "openai/openaiApi.js"));
		OpenaiApi.prototype.processStreamingResponse = originalProcessStreamingResponse;
	}
}