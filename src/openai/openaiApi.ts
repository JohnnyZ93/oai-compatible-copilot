import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem, ReasoningConfig } from "../types";

import type {
	OpenAIChatMessage,
	OpenAIToolCall,
	ChatMessageContent,
	ReasoningDetail,
	ReasoningSummaryDetail,
	ReasoningTextDetail,
} from "./openaiTypes";

import {
	isImageMimeType,
	createDataUrl,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAI,
	mapRole,
} from "../utils";

import { ReasoningCache } from "../cache/reasoningCache";

import { CommonApi } from "../commonApi";

export class OpenaiApi extends CommonApi {
	constructor() {
		super();
	}

	// Capture state for the current request
	private _capturedReasoning = "";
	private _capturedToolCallIds = new Set<string>();

	/**
	 * Convert VS Code chat request messages into OpenAI-compatible message objects.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns OpenAI-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): OpenAIChatMessage[] {
		const out: OpenAIChatMessage[] = [];
		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const reasoningParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					let args = "{}";
					try {
						args = JSON.stringify(part.input ?? {});
					} catch {
						args = "{}";
					}
					toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, content });
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					reasoningParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = reasoningParts.join("").trim();

			// process assistant message
			if (role === "assistant") {
				const assistantMessage: OpenAIChatMessage = {
					role: "assistant",
				};

				if (joinedText) {
					assistantMessage.content = joinedText;
				}

				if (modelConfig.includeReasoningInRequest) {
					if (joinedThinking) {
						assistantMessage.reasoning_content = joinedThinking;
					} else if (toolCalls.length > 0) {
						// Fallback: If reasoning content is missing but we have tool calls,
						// try to retrieve it from cache using the first tool call ID.
						// This is critical for DeepSeek API which requires reasoning_content for tool calls.
						const cache = ReasoningCache.getInstance();
						let cachedThinking: string | undefined;

						for (const tc of toolCalls) {
							cachedThinking = cache.get(tc.id);
							if (cachedThinking) {
								break;
							}
						}

						if (cachedThinking) {
							assistantMessage.reasoning_content = cachedThinking;
						} else {
							// Explicitly set to null if not found in cache to satisfy API requirement
							assistantMessage.reasoning_content = null;
						}
					}
				}

				if (toolCalls.length > 0) {
					assistantMessage.tool_calls = toolCalls;
				}

				if (
					assistantMessage.content ||
					assistantMessage.reasoning_content !== undefined ||
					assistantMessage.tool_calls
				) {
					out.push(assistantMessage);
				}
			}

			// process tool result messages
			for (const tr of toolResults) {
				out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
			}

			// process user messages
			if (role === "user") {
				if (imageParts.length > 0) {
					// multi-modal message
					const contentArray: ChatMessageContent[] = [];

					if (joinedText) {
						contentArray.push({
							type: "text",
							text: joinedText,
						});
					}

					for (const imagePart of imageParts) {
						const dataUrl = createDataUrl(imagePart);
						contentArray.push({
							type: "image_url",
							image_url: {
								url: dataUrl,
							},
						});
					}
					out.push({ role, content: contentArray });
				} else {
					// text-only message
					if (joinedText) {
						out.push({ role, content: joinedText });
					}
				}
			}

			// process system messages
			if (role === "system" && joinedText) {
				out.push({ role, content: joinedText });
			}
		}
		return out;
	}

	prepareRequestBody(
		rb: Record<string, unknown>,
		um: HFModelItem | undefined,
		options: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> {
		// temperature
		const oTemperature = options.modelOptions?.temperature ?? 0;
		const temperature = um?.temperature ?? oTemperature;
		rb.temperature = temperature;
		if (um && um.temperature === null) {
			delete rb.temperature;
		}

		// top_p
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// max_tokens
		if (um?.max_tokens !== undefined) {
			rb.max_tokens = um.max_tokens;
		}

		// max_completion_tokens (OpenAI new standard parameter)
		if (um?.max_completion_tokens !== undefined) {
			rb.max_completion_tokens = um.max_completion_tokens;
		}

		// OpenAI reasoning configuration
		if (um?.reasoning_effort !== undefined) {
			rb.reasoning_effort = um.reasoning_effort;
		}

		// enable_thinking (non-OpenRouter only)
		const enableThinking = um?.enable_thinking;
		if (enableThinking !== undefined) {
			rb.enable_thinking = enableThinking;

			if (um?.thinking_budget !== undefined) {
				rb.thinking_budget = um.thinking_budget;
			}
		}

		// thinking (Zai provider)
		if (um?.thinking?.type !== undefined) {
			rb.thinking = {
				type: um.thinking.type,
			};
		}

		// OpenRouter reasoning configuration
		if (um?.reasoning !== undefined) {
			const reasoningConfig: ReasoningConfig = um.reasoning as ReasoningConfig;
			if (reasoningConfig.enabled !== false) {
				const reasoningObj: Record<string, unknown> = {};
				const effort = reasoningConfig.effort;
				const maxTokensReasoning = reasoningConfig.max_tokens || 2000; // Default 2000 as per docs
				if (effort && effort !== "auto") {
					reasoningObj.effort = effort;
				} else {
					// If auto or unspecified, use max_tokens (Anthropic-style fallback)
					reasoningObj.max_tokens = maxTokensReasoning;
				}
				if (reasoningConfig.exclude !== undefined) {
					reasoningObj.exclude = reasoningConfig.exclude;
				}
				rb.reasoning = reasoningObj;
			}
		}

		// stop
		if (options.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		// tools
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			rb.tool_choice = toolConfig.tool_choice;
		}

		// Configure user-defined additional parameters
		if (um?.top_k !== undefined) {
			rb.top_k = um.top_k;
		}
		if (um?.min_p !== undefined) {
			rb.min_p = um.min_p;
		}
		if (um?.frequency_penalty !== undefined) {
			rb.frequency_penalty = um.frequency_penalty;
		}
		if (um?.presence_penalty !== undefined) {
			rb.presence_penalty = um.presence_penalty;
		}
		if (um?.repetition_penalty !== undefined) {
			rb.repetition_penalty = um.repetition_penalty;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			// Add all extra parameters directly to the request body
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					rb[key] = value;
				}
			}
		}

		return rb;
	}

	/**
	 * Read and parse the HF Router streaming (SSE-like) response and report parts.
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

		// Reset capture state
		this._capturedReasoning = "";
		this._capturedToolCallIds.clear();

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
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						// console.debug("[OAI Compatible Model Provider] data:", JSON.stringify(parsed));

						await this.processDelta(parsed, progress);
					} catch {
						// Silently ignore malformed SSE lines temporarily
					}
				}
			}
		} finally {
			reader.releaseLock();
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			// Cache the captured reasoning content for the tool calls in this response
			if (this._capturedReasoning && this._capturedToolCallIds.size > 0) {
				const cache = ReasoningCache.getInstance();
				cache.add(Array.from(this._capturedToolCallIds), this._capturedReasoning);
			}
		}
	}

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param delta Parsed SSE chunk from the Router.
	 * @param progress Progress reporter for parts.
	 */
	private async processDelta(
		delta: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<boolean> {
		let emitted = false;
		const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) {
			return false;
		}

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		// Process thinking content first (before regular text content)
		try {
			let maybeThinking =
				(choice as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.reasoning_content;

			// OpenRouter/Claude reasoning_details array handling (new)
			const maybeReasoningDetails =
				(deltaObj as Record<string, unknown>)?.reasoning_details ??
				(choice as Record<string, unknown>)?.reasoning_details;
			if (maybeReasoningDetails && Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
				// Prioritize details array over simple reasoning
				const details: Array<ReasoningDetail> = maybeReasoningDetails as Array<ReasoningDetail>;
				// Sort by index to preserve order (in case out-of-order chunks)
				const sortedDetails = details.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

				for (const detail of sortedDetails) {
					let extractedText = "";
					if (detail.type === "reasoning.summary") {
						extractedText = (detail as ReasoningSummaryDetail).summary;
					} else if (detail.type === "reasoning.text") {
						extractedText = (detail as ReasoningTextDetail).text;
					} else if (detail.type === "reasoning.encrypted") {
						extractedText = "[REDACTED]"; // As per docs
					} else {
						extractedText = JSON.stringify(detail); // Fallback for unknown
					}

					if (extractedText) {
						this.bufferThinkingContent(extractedText, progress);
						this._capturedReasoning += extractedText;
						emitted = true;
					}
				}
				maybeThinking = null; // Skip simple thinking if details present
			}

			// Fallback to simple thinking if no details
			if (maybeThinking !== undefined && maybeThinking !== null) {
				let text = "";
				// let metadata: Record<string, unknown> | undefined;
				if (maybeThinking && typeof maybeThinking === "object") {
					const mt = maybeThinking as Record<string, unknown>;
					text = typeof mt["text"] === "string" ? (mt["text"] as string) : JSON.stringify(mt);
					// metadata = mt["metadata"] ? (mt["metadata"] as Record<string, unknown>) : undefined;
				} else if (typeof maybeThinking === "string") {
					text = maybeThinking;
				}
				if (text) {
					this.bufferThinkingContent(text, progress);
					this._capturedReasoning += text;
					emitted = true;
				}
			}
		} catch (e) {
			console.error("[OAI Compatible Model Provider] Failed to process thinking/reasoning_details:", e);
		}

		if (deltaObj?.content) {
			const content = String(deltaObj.content);

			// Process XML think blocks or text content (mutually exclusive)
			// Pass capturedReasoning reference or capture inside the method
			// Since processXmlThinkBlocks is private and we need to capture inside it,
			// we will modify processXmlThinkBlocks to take a callback or return captured content.
			// Ideally, we can just perform side-effects in the method or pass a mutable object.
			// However, given the structure, I will inline capture in the processXmlThinkBlocks replacement above.
			const xmlRes = this.processXmlThinkBlocks(content, progress);
			if (xmlRes.emittedAny) {
				emitted = true;
			} else {
				// If there's an active thinking sequence, end it first
				this.reportEndThinking(progress);

				// Only process text content if no XML think blocks were emitted
				const res = this.processTextContent(content, progress);
				if (res.emittedText) {
					this._hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
		}

		if (deltaObj?.tool_calls) {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

			// SSEProcessor-like: if first tool call appears after text, emit a whitespace
			// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
			if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				const idx = (tc.index as number) ?? 0;
				// Ignore any further deltas for an index we've already completed
				if (this._completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (tc.id && typeof tc.id === "string") {
					buf.id = tc.id as string;
					this._capturedToolCallIds.add(tc.id);
				}
				const func = tc.function as Record<string, unknown> | undefined;
				if (func?.name && typeof func.name === "string") {
					buf.name = func.name as string;
				}
				if (typeof func?.arguments === "string") {
					buf.args += func.arguments as string;
				}
				this._toolCallBuffers.set(idx, buf);

				// Emit immediately once arguments become valid JSON to avoid perceived hanging
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = (choice.finish_reason as string | undefined) ?? undefined;
		if (finish === "tool_calls" || finish === "stop") {
			// On both 'tool_calls' and 'stop', emit any buffered calls and throw on invalid JSON
			await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ true);
		}
		return emitted;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	private processTextContent(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedText: boolean; emittedAny: boolean } {
		let emittedText = false;
		let emittedAny = false;

		// Emit any visible text
		const textToEmit = input;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedText = true;
			emittedAny = true;
		}

		return { emittedText, emittedAny };
	}

	/**
	 * Process streamed text content for XML think blocks and emit thinking parts.
	 * Returns whether any thinking content was emitted.
	 */
	private processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		// If we've already attempted detection and found no THINK_START, skip processing
		if (this._xmlThinkDetectionAttempted && !this._xmlThinkActive) {
			return { emittedAny: false };
		}

		const THINK_START = "<think>";
		const THINK_END = "</think>";

		let data = input;
		let emittedAny = false;

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				// Look for think start tag
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					// No think start found, mark detection as attempted and skip future processing
					this._xmlThinkDetectionAttempted = true;
					data = "";
					break;
				}

				// Found think start tag
				this._xmlThinkActive = true;
				// Generate a new thinking ID for this XML think block
				this._currentThinkingId = this.generateThinkingId();

				// Skip the start tag and continue processing
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			// We are inside a think block, look for end tag
			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
				// No end tag found, emit current chunk content as thinking part
				const thinkContent = data.trim();
				if (thinkContent) {
					progress.report(new vscode.LanguageModelThinkingPart(thinkContent, this._currentThinkingId || undefined));
					this._capturedReasoning += thinkContent;
					emittedAny = true;
				}
				data = "";
				break;
			}

			// Found end tag, emit final thinking part
			const thinkContent = data.slice(0, endIdx);
			if (thinkContent) {
				progress.report(new vscode.LanguageModelThinkingPart(thinkContent, this._currentThinkingId || undefined));
				this._capturedReasoning += thinkContent;
				emittedAny = true;
			}

			// Reset state and continue with remaining data
			this._xmlThinkActive = false;
			this._currentThinkingId = null;
			data = data.slice(endIdx + THINK_END.length);
		}

		return { emittedAny };
	}
}
