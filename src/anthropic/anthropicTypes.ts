/**
 * Anthropic API message format
 * @see https://docs.anthropic.com/en/api/messages
 */

export type AnthropicRole = "user" | "assistant";

/**
 * Anthropic prompt caching breakpoint.
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export interface AnthropicCacheControl {
	type: "ephemeral";
	/** Optional cache lifetime — "5m" (default) or "1h". */
	ttl?: "5m" | "1h";
}

export interface AnthropicTextBlock {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
	is_error?: boolean;
	cache_control?: AnthropicCacheControl;
}

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

export interface AnthropicMessage {
	role: AnthropicRole;
	content: string | AnthropicContentBlock[];
}

export interface AnthropicRequestBody {
	model: string;
	messages: AnthropicMessage[];
	max_tokens?: number;
	system?: string | AnthropicTextBlock[];
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	metadata?: {
		user_id?: string;
	};
	service_tier?: "auto" | "standard_only";
	thinking?: {
		type: "enabled";
		budget_tokens: number;
	};
	tools?: AnthropicToolDefinition[];
	tool_choice?: AnthropicToolChoice;
}

export interface AnthropicToolDefinition {
	name: string;
	description?: string;
	input_schema?: object;
	cache_control?: AnthropicCacheControl;
}

export type AnthropicToolChoice =
	| { type: "auto" }
	| { type: "any" }
	| { type: "tool"; name: string }
	| { type: "none" };

export interface AnthropicStreamChunk {
	type:
		| "message_start"
		| "content_block_start"
		| "content_block_delta"
		| "content_block_stop"
		| "message_delta"
		| "message_stop"
		| "ping"
		| "error";
	index?: number;
	message?: {
		id: string;
		type: "message";
		role: "assistant";
		content: AnthropicContentBlock[];
		model: string;
		stop_reason?: string;
		stop_sequence?: string;
	};
	content_block?: {
		type: "text" | "thinking" | "tool_use";
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
		input?: Record<string, unknown>;
	};
	delta?: {
		type: "text_delta" | "thinking_delta" | "input_json_delta" | "signature_delta";
		text?: string;
		thinking?: string;
		partial_json?: string;
		signature?: string;
	};
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
	error?: {
		type: string;
		message: string;
	};
}
