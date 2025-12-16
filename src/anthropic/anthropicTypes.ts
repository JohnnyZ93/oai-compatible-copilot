/**
 * Anthropic API message format
 * @see https://docs.anthropic.com/en/api/messages
 */

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
	type: "text";
	text: string;
}

export interface AnthropicImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

export interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

export interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | AnthropicTextBlock[];
	is_error?: boolean;
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
		| "message_stop";
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
		tool_use?: {
			id: string;
			name: string;
			input: Record<string, unknown>;
		};
	};
	delta?: {
		type: "text_delta" | "thinking_delta" | "input_json_delta";
		text?: string;
		thinking?: string;
		partial_json?: string;
	};
	usage?: {
		input_tokens: number;
		output_tokens: number;
	};
}
