export interface GeminiInlineData {
	mimeType: string;
	data: string;
}

export interface GeminiFunctionCall {
	name: string;
	args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
	name: string;
	response: Record<string, unknown>;
}

export interface GeminiPart {
	text?: string;
	inlineData?: GeminiInlineData;
	fileData?: { fileUri: string; mimeType?: string };
	functionCall?: GeminiFunctionCall;
	functionResponse?: GeminiFunctionResponse;
	// 2025+ thinking fields (may appear in streaming responses)
	thought?: boolean | string;
	thought_signature?: string;
	thoughtSignature?: string;
}

export interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

export interface GeminiSystemInstruction {
	role: "user";
	parts: Array<{ text: string }>;
}

export interface GeminiFunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

export interface GeminiTool {
	functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiToolConfig {
	functionCallingConfig: {
		mode: "AUTO" | "ANY" | "NONE";
		allowedFunctionNames?: string[];
	};
}

export interface GeminiGenerationConfig {
	temperature?: number;
	topP?: number;
	topK?: number;
	maxOutputTokens?: number;
	stopSequences?: string[];
	presencePenalty?: number;
	frequencyPenalty?: number;
}

export interface GeminiGenerateContentRequest {
	contents: GeminiContent[];
	systemInstruction?: GeminiSystemInstruction;
	generationConfig?: GeminiGenerationConfig;
	tools?: GeminiTool[];
	toolConfig?: GeminiToolConfig;
	[key: string]: unknown;
}

export interface GeminiGenerateContentResponse {
	candidates?: Array<{
		content?: { role?: string; parts?: GeminiPart[] };
		finishReason?: string;
		finish_reason?: string;
	}>;
	usageMetadata?: unknown;
	[key: string]: unknown;
}

export interface GeminiModelListResponse {
	models?: GeminiModelEntry[];
	nextPageToken?: string;
}

export interface GeminiModelEntry {
	name?: string;
	displayName?: string;
	inputTokenLimit?: number;
	outputTokenLimit?: number;
}
