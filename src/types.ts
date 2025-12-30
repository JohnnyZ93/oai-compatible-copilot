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
	displayName?: string;
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

	/**
	 * Whether to include reasoning_content in assistant messages sent to the API.
	 * Support deepseek-v3.2 or others.
	 */
	include_reasoning_in_request?: boolean;

	/**
	 * API mode: "openai" for OpenAI Chat Completions, "openai-responses" for OpenAI Responses,
	 * "ollama" for Ollama native API, "anthropic" for Anthropic Messages, "gemini" for Gemini native API.
	 * Default is "openai".
	 */
	apiMode?: HFApiMode;

	/**
	 * Model-specific delay in milliseconds between consecutive requests.
	 * If not specified, falls back to global `oaicopilot.delay` configuration.
	 */
	delay?: number;
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
	status_codes?: number[];
}

/** Supports API mode. */
export type HFApiMode = "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini";
