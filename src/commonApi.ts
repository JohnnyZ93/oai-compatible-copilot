import {
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatRequestMessage,
	LanguageModelToolCallPart,
	LanguageModelResponsePart2,
	LanguageModelThinkingPart,
	Progress,
	CancellationToken,
} from "vscode";

import type { OllamaMessage, OllamaRequestBody } from "./ollama/ollamaTypes";

import type { OpenAIChatMessage } from "./openai/openaiTypes";
import type { AnthropicMessage, AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { HFModelItem } from "./types";
import { tryParseJSONObject } from "./utils";

export abstract class CommonApi {
	/** Buffer for assembling streamed tool calls by index. */
	protected _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	protected _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	protected _hasEmittedAssistantText = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	protected _emittedBeginToolCallsHint = false;

	// XML think block parsing state
	protected _xmlThinkActive = false;
	protected _xmlThinkDetectionAttempted = false;

	// Thinking content state management
	protected _currentThinkingId: string | null = null;

	/** Buffer for accumulating thinking content before emitting. */
	protected _thinkingBuffer = "";

	/** Timer for delayed flushing of thinking buffer. */
	protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

	constructor() {}

	/**
	 * Convert VS Code chat messages to specific api message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig Config for special model.
	 * @returns Specific api messages array.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): Array<OpenAIChatMessage | OllamaMessage | AnthropicMessage>;

	/**
	 * Construct request body for Specific api
	 * @param rb Specific api Request body
	 * @param um Current Model Info
	 * @param options From VS Code
	 */
	abstract prepareRequestBody(
		rb: Record<string, unknown> | OllamaRequestBody | AnthropicRequestBody,
		um: HFModelItem | undefined,
		options: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> | OllamaRequestBody | AnthropicRequestBody;

	/**
	 * Process specific api streaming response (JSON lines format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	abstract processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void>;

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const parameters = canParse.value;
		progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			progress.report(new LanguageModelToolCallPart(id, name, parsed.value));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	/**
	 * Report to VS Code for ending thinking
	 * @param progress Progress reporter for parts
	 */
	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>) {
		if (this._currentThinkingId) {
			try {
				this.flushThinkingBuffer(progress);
				// End the current thinking sequence with empty content and same ID
				progress.report(new LanguageModelThinkingPart("", this._currentThinkingId));
			} catch (e) {
				console.error("[OAI Compatible Model Provider] Failed to end thinking sequence:", e);
			}
		}
		// Always clean up state after attempting to end the thinking sequence
		this._currentThinkingId = null;
		// Clear thinking buffer and timer since sequence ended
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
	}

	/**
	 * Generate a unique thinking ID based on request start time and random suffix
	 */
	protected generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Buffer and schedule a flush for thinking content.
	 * @param text The thinking text to buffer
	 * @param progress Progress reporter for parts
	 */
	protected bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		// Generate thinking ID if not provided by the model
		if (!this._currentThinkingId) {
			this._currentThinkingId = this.generateThinkingId();
		}

		// Append to thinking buffer
		this._thinkingBuffer += text;

		// Schedule flush with 100ms delay
		if (!this._thinkingFlushTimer) {
			this._thinkingFlushTimer = setTimeout(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	/**
	 * Flush the thinking buffer to the progress reporter.
	 * @param progress Progress reporter for parts.
	 */
	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		// Always clear existing timer first
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}

		// Flush current buffer if we have content
		if (this._thinkingBuffer && this._currentThinkingId) {
			const text = this._thinkingBuffer;
			this._thinkingBuffer = "";
			progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId));
		}
	}
}
