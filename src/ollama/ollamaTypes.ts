import { OpenAIFunctionToolDef } from "../openai/openaiTypes";

/**
 * Ollama native API message format
 * @see https://docs.ollama.com/api#generate-a-chat-message
 */
export interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	thinking?: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string; // For tool role messages
}

/**
 * Ollama native API request body
 * @see https://docs.ollama.com/api#generate-a-chat-message
 */
export interface OllamaRequestBody {
	model: string;
	messages: OllamaMessage[];
	stream?: boolean;
	think?: boolean | string;
	options?: OllamaModelOptions;
	tools?: OpenAIFunctionToolDef[];
}

/**
 * Ollama model options for controlling text generation
 * @see https://docs.ollama.com/api#generate-a-chat-message
 */
export interface OllamaModelOptions {
	seed?: number;
	temperature?: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
	stop?: string | string[];
	num_ctx?: number;
	num_predict?: number;
}

/**
 * Ollama tool call format
 * @see https://docs.ollama.com/api#tool-calling
 */
export interface OllamaToolCall {
	function: {
		name: string;
		arguments: Record<string, unknown>;
	};
}

/**
 * Ollama native API streaming response chunk
 */
export interface OllamaStreamChunk {
	model: string;
	created_at: string;
	message: {
		role: string;
		content: string;
		thinking?: string;
		tool_calls?: OllamaToolCall[];
	};
	done: boolean;
	done_reason?: string;
}

/**
 * Ollama /api/tags response format
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models
 */
export interface OllamaTagModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details?: {
		parent_model: string;
		format: string;
		family: string;
		families: string[];
		parameter_size: string;
		quantization_level: string;
	};
}

export interface OllamaTagsResponse {
	models: OllamaTagModel[];
}
