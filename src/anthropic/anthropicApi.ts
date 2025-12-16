import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";

import type {
	AnthropicMessage,
	AnthropicRequestBody,
	AnthropicContentBlock,
	AnthropicToolUseBlock,
	AnthropicToolResultBlock,
	AnthropicStreamChunk,
} from "./anthropicTypes";

import { isImageMimeType, isToolResultPart, collectToolResultText, convertToolsToOpenAI, mapRole } from "../utils";

import { CommonApi } from "../commonApi";

export class AnthropicApi extends CommonApi {
	private _systemContent: string | undefined;

	constructor() {
		super();
	}

	/**
	 * Convert VS Code chat messages to Anthropic message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns Anthropic-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): AnthropicMessage[] {
		const out: AnthropicMessage[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: AnthropicToolUseBlock[] = [];
			const toolResults: AnthropicToolResultBlock[] = [];
			const thinkingParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					toolCalls.push({
						type: "tool_use",
						id,
						name: part.name,
						input: (part.input as Record<string, unknown>) ?? {},
					});
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({
						type: "tool_result",
						tool_use_id: callId,
						content,
					});
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			// Handle system messages separately (Anthropic uses top-level system field)
			if (role === "system") {
				if (textParts.length > 0) {
					this._systemContent = textParts.join("\n");
				}
				continue;
			}

			// Build content blocks for user/assistant messages
			const contentBlocks: AnthropicContentBlock[] = [];

			// Add text content
			if (textParts.length > 0) {
				contentBlocks.push({
					type: "text",
					text: textParts.join("\n"),
				});
			}

			// Add image content
			for (const imagePart of imageParts) {
				const base64Data = Buffer.from(imagePart.data).toString("base64");
				contentBlocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: imagePart.mimeType,
						data: base64Data,
					},
				});
			}

			// Add thinking content for assistant messages
			if (role === "assistant" && thinkingParts.length > 0 && modelConfig.includeReasoningInRequest) {
				contentBlocks.push({
					type: "thinking",
					thinking: thinkingParts.join("\n"),
				});
			}

			// Add tool calls for assistant messages
			for (const toolCall of toolCalls) {
				contentBlocks.push(toolCall);
			}

			// For tool results, they should be added to user messages
			// We'll add them to the current message if it's a user message
			if (role === "user" && toolResults.length > 0) {
				for (const toolResult of toolResults) {
					contentBlocks.push(toolResult);
				}
			} else if (toolResults.length > 0) {
				// If tool results appear in non-user messages, log warning
				console.warn("[Anthropic Provider] Tool results found in non-user message, ignoring");
			}

			// Only add message if we have content blocks
			if (contentBlocks.length > 0) {
				out.push({
					role,
					content: contentBlocks,
				});
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: AnthropicRequestBody,
		um: HFModelItem | undefined,
		options: ProvideLanguageModelChatResponseOptions
	): AnthropicRequestBody {
		// Set max_tokens (required for Anthropic)
		if (um?.max_tokens !== undefined) {
			rb.max_tokens = um.max_tokens;
		}

		// Add system content if we extracted it
		if (this._systemContent) {
			rb.system = this._systemContent;
		}

		// Add temperature if configured
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// Add top_p if configured
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// Add top_k if configured
		if (um?.top_k !== undefined) {
			rb.top_k = um.top_k;
		}

		// Add tools configuration
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			// Convert OpenAI tool definitions to Anthropic format
			rb.tools = toolConfig.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters,
			}));
		}

		// Add tool_choice
		if (toolConfig.tool_choice) {
			if (toolConfig.tool_choice === "auto") {
				rb.tool_choice = { type: "auto" };
			} else if (typeof toolConfig.tool_choice === "object" && toolConfig.tool_choice.type === "function") {
				rb.tool_choice = { type: "tool", name: toolConfig.tool_choice.function.name };
			}
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			// Add all extra parameters directly to the request body
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					(rb as unknown as Record<string, unknown>)[key] = value;
				}
			}
		}

		return rb;
	}

	/**
	 * Process Anthropic streaming response (SSE format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim() === "") {
						continue;
					}
					if (!line.startsWith("data: ")) {
						continue;
					}

					const data = line.slice(6);
					if (data === "[DONE]") {
						// Flush any remaining thinking content
						this.reportEndThinking(progress);
						return;
					}

					try {
						const chunk: AnthropicStreamChunk = JSON.parse(data);
						await this.processAnthropicChunk(chunk, progress);
					} catch (e) {
						console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Process a single Anthropic streaming chunk.
	 * @param chunk Parsed Anthropic stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processAnthropicChunk(
		chunk: AnthropicStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		if (chunk.type === "content_block_start" && chunk.content_block) {
			// Start of a content block
			if (chunk.content_block.type === "thinking") {
				// Start thinking block
				if (chunk.content_block.thinking) {
					this.bufferThinkingContent(chunk.content_block.thinking, progress);
				}
			} else if (chunk.content_block.type === "tool_use" && chunk.content_block.tool_use) {
				// Start tool call block
				const toolUse = chunk.content_block.tool_use;
				this._toolCallBuffers.set(this._toolCallBuffers.size, {
					id: toolUse.id,
					name: toolUse.name,
					args: JSON.stringify(toolUse.input),
				});
			}
		} else if (chunk.type === "content_block_delta" && chunk.delta) {
			if (chunk.delta.type === "text_delta" && chunk.delta.text) {
				// Emit text content
				progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
			} else if (chunk.delta.type === "thinking_delta" && chunk.delta.thinking) {
				// Buffer thinking content
				this.bufferThinkingContent(chunk.delta.thinking, progress);
			} else if (chunk.delta.type === "input_json_delta" && chunk.delta.partial_json) {
				// Handle tool call argument streaming
				// Find the latest tool call buffer and append partial JSON
				const lastIndex = this._toolCallBuffers.size - 1;
				const buf = this._toolCallBuffers.get(lastIndex);
				if (buf) {
					buf.args += chunk.delta.partial_json;
					this._toolCallBuffers.set(lastIndex, buf);
					// Try to emit if we have valid JSON
					await this.tryEmitBufferedToolCall(lastIndex, progress);
				}
			}
		} else if (chunk.type === "content_block_stop") {
			// End of a content block - flush thinking if active
			if (this._currentThinkingId) {
				this.flushThinkingBuffer(progress);
			}
			// Try to emit any pending tool calls
			for (const [idx] of Array.from(this._toolCallBuffers.entries())) {
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		} else if (chunk.type === "message_stop") {
			// End of message - ensure thinking is ended and flush all tool calls
			this.reportEndThinking(progress);
			await this.flushToolCallBuffers(progress, false);
		}
	}
}
