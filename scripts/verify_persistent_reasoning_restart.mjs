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
	const firstState = new MemoryMemento(sharedStore);
	const secondState = new MemoryMemento(sharedStore);
	const statusBarItem = { text: "", tooltip: "", backgroundColor: undefined, show() {} };
	const secrets = { get: async () => "dummy-api-key", store: async () => {}, delete: async () => {} };
	const model = { id: "glm-5.1::variant-a", maxInputTokens: 100000, maxOutputTokens: 4096 };
	const noReasoningModel = { id: "glm-5.1::variant-b", maxInputTokens: 100000, maxOutputTokens: 4096 };
	const token = { isCancellationRequested: false };
	const USER = mockVscode.LanguageModelChatMessageRole.User;
	const ASSISTANT = mockVscode.LanguageModelChatMessageRole.Assistant;
	const SYSTEM = mockVscode.LanguageModelChatMessageRole.System;

	const firstTurnMessages = [
		{ role: SYSTEM, content: [new LanguageModelTextPart("You are an assistant")] },
		{ role: SYSTEM, content: [new LanguageModelTextPart("Extra transient instruction")] },
		{ role: USER, content: [new LanguageModelTextPart("Think first and reply READY only")] },
	];

	const secondTurnMessages = [
		{ role: SYSTEM, content: [new LanguageModelTextPart("You are an assistant")] },
		{ role: USER, content: [new LanguageModelTextPart("Think first and reply READY only")] },
		{ role: ASSISTANT, content: [new LanguageModelTextPart("READY")] },
		{ role: USER, content: [new LanguageModelTextPart("What values did you pick?")] },
	];

	const requestBodies = [];
	globalThis.fetch = async (_url, init) => {
		requestBodies.push(JSON.parse(init.body));
		return { ok: true, body: {} };
	};

	originalProcessStreamingResponse = OpenaiApi.prototype.processStreamingResponse;
	OpenaiApi.prototype.processStreamingResponse = async function (_body, progress) {
		progress.report(new LanguageModelThinkingPart("A=0.30,B=0.25,C=0.20,D=0.15,E=0.10"));
		progress.report(new LanguageModelTextPart("READY"));
	};

	const firstProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, firstState);
	await firstProvider.provideLanguageModelChatResponse(
		model,
		firstTurnMessages,
		{ tools: [], requestInitiator: "github.copilot-chat" },
		{ report() {} },
		token
	);

	const secondProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, secondState);
	await secondProvider.provideLanguageModelChatResponse(
		model,
		secondTurnMessages,
		{ tools: [], requestInitiator: "github.copilot-chat" },
		{ report() {} },
		token
	);

	const secondRequest = requestBodies.at(-1);
	const restoredAssistant = secondRequest.messages.find((message) => message.role === "assistant");
	if (!restoredAssistant) {
		throw new Error("Assistant replay message missing from second request");
	}
	if (restoredAssistant.content !== "READY") {
		throw new Error(`Unexpected assistant content replay: ${restoredAssistant.content ?? "<missing>"}`);
	}
	if (restoredAssistant.reasoning_content !== "A=0.30,B=0.25,C=0.20,D=0.15,E=0.10") {
		throw new Error(
			`Persistent reasoning replay failed: ${restoredAssistant.reasoning_content ?? "<missing>"}`
		);
	}

	console.log("Persistent reasoning restart validation passed.");
	console.log(JSON.stringify(restoredAssistant, null, 2));

	const thirdProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, secondState);
	await thirdProvider.provideLanguageModelChatResponse(
		model,
		secondTurnMessages,
		{ tools: [], requestInitiator: "other.extension" },
		{ report() {} },
		token
	);

	const thirdRequest = requestBodies.at(-1);
	const thirdAssistant = thirdRequest.messages.find((message) => message.role === "assistant");
	if (!thirdAssistant) {
		throw new Error("Assistant replay message missing from third request");
	}
	if (thirdAssistant.reasoning_content !== undefined) {
		throw new Error("Reasoning unexpectedly leaked across requestInitiator boundaries");
	}

	console.log("requestInitiator partition validation passed.");
	console.log(JSON.stringify(thirdAssistant, null, 2));

	const fourthProvider = new HuggingFaceChatModelProvider(secrets, statusBarItem, secondState);
	await fourthProvider.provideLanguageModelChatResponse(
		noReasoningModel,
		secondTurnMessages,
		{ tools: [], requestInitiator: "github.copilot-chat" },
		{ report() {} },
		token
	);

	const fourthRequest = requestBodies.at(-1);
	const fourthAssistant = fourthRequest.messages.find((message) => message.role === "assistant");
	if (!fourthAssistant) {
		throw new Error("Assistant replay message missing from fourth request");
	}
	if (fourthAssistant.reasoning_content !== undefined) {
		throw new Error("Reasoning unexpectedly leaked into include_reasoning_in_request=false config variant");
	}

	console.log("configId variant-b isolation validation passed.");
	console.log(JSON.stringify(fourthAssistant, null, 2));
} finally {
	Module._load = originalLoad;
	globalThis.fetch = originalFetch;
	if (originalProcessStreamingResponse) {
		const outDir = path.resolve(__dirname, "../out");
		const { OpenaiApi } = require(path.join(outDir, "openai/openaiApi.js"));
		OpenaiApi.prototype.processStreamingResponse = originalProcessStreamingResponse;
	}
}