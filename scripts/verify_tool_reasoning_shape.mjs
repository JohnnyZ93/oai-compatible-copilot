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

const mockVscode = {
	LanguageModelTextPart,
	LanguageModelThinkingPart,
	LanguageModelDataPart,
	LanguageModelToolCallPart,
	LanguageModelChatMessageRole: {
		User: 1,
		Assistant: 2,
		System: 3,
	},
	LanguageModelChatToolMode: {
		Required: 1,
	},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "vscode") {
		return mockVscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const outDir = path.resolve(__dirname, "../out");
	const { OpenaiApi } = require(path.join(outDir, "openai/openaiApi.js"));
	const { convertToolsToOpenAI } = require(path.join(outDir, "utils.js"));

	const USER = mockVscode.LanguageModelChatMessageRole.User;
	const ASSISTANT = mockVscode.LanguageModelChatMessageRole.Assistant;
	const SYSTEM = mockVscode.LanguageModelChatMessageRole.System;

	const messages = [
		{
			role: SYSTEM,
			content: [new LanguageModelTextPart("You are an assistant")],
		},
		{
			role: USER,
			content: [new LanguageModelTextPart("What's the weather like in Beijing?")],
		},
		{
			role: ASSISTANT,
			content: [
				new LanguageModelTextPart("I'll check that for you."),
				new LanguageModelThinkingPart("I should call the weather tool before replying."),
				new LanguageModelToolCallPart("call_weather_1", "get_weather", { city: "Beijing" }),
			],
		},
		{
			role: USER,
			content: [
				{
					callId: "call_weather_1",
					content: [
						new LanguageModelTextPart('{"weather":"Sunny","temp":"25°C"}'),
					],
				},
			],
		},
	];

	const toolConfig = convertToolsToOpenAI({
		tools: [
			{
				name: "get_weather",
				description: "Get weather information",
				inputSchema: {
					type: "object",
					properties: {
						city: { type: "string" },
					},
					required: ["city"],
				},
			},
		],
	});

	const api = new OpenaiApi();
	const converted = api.convertMessages(messages, { includeReasoningInRequest: true });

	const assistantMessage = converted.find((message) => message.role === "assistant");
	const toolMessage = converted.find((message) => message.role === "tool");

	if (!assistantMessage) {
		throw new Error("Assistant message missing from converted output");
	}
	if (assistantMessage.reasoning_content !== "I should call the weather tool before replying.") {
		throw new Error(`Unexpected reasoning_content: ${assistantMessage.reasoning_content ?? "<missing>"}`);
	}
	if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length !== 1) {
		throw new Error("Assistant tool_calls were not serialized correctly");
	}
	if (assistantMessage.tool_calls[0].function.name !== "get_weather") {
		throw new Error("Tool call function name mismatch");
	}
	if (!toolMessage || toolMessage.tool_call_id !== "call_weather_1") {
		throw new Error("Tool result message missing or mismatched");
	}
	if (toolMessage.content !== '{"weather":"Sunny","temp":"25°C"}') {
		throw new Error("Tool result content mismatch");
	}
	if (!toolConfig.tools || toolConfig.tools.length !== 1 || toolConfig.tools[0].function.name !== "get_weather") {
		throw new Error("Top-level tools configuration mismatch");
	}

	console.log("Tool reasoning shape validation passed.");
	console.log(
		JSON.stringify(
			{
				requestShape: {
					messages: converted,
					...toolConfig,
				},
			},
			null,
			2
		)
	);
} finally {
	Module._load = originalLoad;
}