/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
}

/**
 * OpenAI-style chat message used for router requests.
 */
export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content?: string | ChatMessageContent[];
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

/**
 * 聊天消息内容接口（支持多模态）
 */
export interface ChatMessageContent {
	type: "text" | "image_url";
	text?: string;
	image_url?: {
		url: string;
	};
}

/**
 * A single underlying provider (e.g., together, groq) for a model.
 */
export interface HFProvider {
	provider: string;
	status: string;
	supports_tools?: boolean;
	supports_structured_output?: boolean;
	context_length?: number;
}

/**
 * A model entry returned by the Hugging Face router models endpoint.
 */
export interface HFArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

export interface HFModelItem {
	id: string;
	object?: string;
	created?: number;
	owned_by: string;
	configId?: string;
	baseUrl?: string;
	providers?: HFProvider[];
	architecture?: HFArchitecture;
	context_length?: number;
	vision?: boolean;
	max_tokens?: number;
	// OpenAI new standard parameter
	max_completion_tokens?: number;
	reasoning_effort?: string;
	enable_thinking?: boolean;
	thinking_budget?: number;
	// New thinking configuration for Zai provider
	thinking?: ThinkingConfig;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	temperature?: number | null;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	top_p?: number | null;
	top_k?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	reasoning?: ReasoningConfig;
	/**
	 * Optional family specification for the model. This allows users to specify
	 * the model family (e.g., "gpt-4", "claude-3", "gemini") to enable family-specific
	 * optimizations and behaviors in the Copilot extension. If not specified,
	 * defaults to "oai-compatible".
	 */
	family?: string;

	/**
	 * Extra configuration parameters that can be used for custom functionality.
	 * This allows users to add any additional parameters they might need
	 * without modifying the core interface.
	 */
	extra?: Record<string, unknown>;

	/**
	 * Custom HTTP headers to be sent with every request to this model's provider.
	 * These headers will be merged with the default headers (Authorization, Content-Type, User-Agent).
	 * Example: { "X-API-Version": "v1", "X-Custom-Header": "value" }
	 */
	headers?: Record<string, string>;
}

/**
 * OpenRouter reasoning configuration
 */
export interface ReasoningConfig {
	effort?: string;
	exclude?: boolean;
	max_tokens?: number;
	enabled?: boolean;
}

/**
 * Supplemental model info from the Hugging Face hub API.
 */
// Deprecated: extra model info was previously fetched from the hub API
export interface HFExtraModelInfo {
	id: string;
	pipeline_tag?: string;
}

/**
 * Response envelope for the router models listing.
 */
export interface HFModelsResponse {
	object: string;
	data: HFModelItem[];
}

/**
 * Buffer used to accumulate streamed tool call parts until arguments are valid JSON.
 */
export interface ToolCallBuffer {
	id?: string;
	name?: string;
	args: string;
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

export interface ReasoningDetailCommon {
	id: string | null;
	format: string; // e.g., "anthropic-claude-v1", "openai-responses-v1"
	index?: number;
}

export interface ReasoningSummaryDetail extends ReasoningDetailCommon {
	type: "reasoning.summary";
	summary: string;
}

export interface ReasoningEncryptedDetail extends ReasoningDetailCommon {
	type: "reasoning.encrypted";
	data: string; // Base64 encoded
}

export interface ReasoningTextDetail extends ReasoningDetailCommon {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
}

export type ReasoningDetail = ReasoningSummaryDetail | ReasoningEncryptedDetail | ReasoningTextDetail;

/**
 * Thinking configuration for Zai provider
 */
export interface ThinkingConfig {
	type?: string;
}

/**
 * Retry configuration for rate limiting
 */
export interface RetryConfig {
	enabled?: boolean;
	max_attempts?: number;
	interval_ms?: number;
}
