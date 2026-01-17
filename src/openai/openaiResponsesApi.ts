import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";
import type { OpenAIToolCall } from "./openaiTypes";

import {
	isImageMimeType,
	createDataUrl,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAIResponses,
	mapRole,
} from "../utils";

import { CommonApi } from "../commonApi";

export interface ResponsesInputMessage {
	role: "user" | "assistant" | "system";
	content: ResponsesContentPart[];
	type?: "message";
	id?: string;
	status?: "completed" | "incomplete";
}

export interface ResponsesContentPart {
	type: "input_text" | "input_image" | "output_text" | "summary_text";
	text?: string;
	image_url?: string;
	detail?: "auto";
}

export interface ResponsesFunctionCall {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
}

export interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
	id: string;
	status: "completed";
}

export interface ResponsesReasoning {
	type: "reasoning";
	summary: ResponsesContentPart[];
	id: string;
	status: "completed";
}

export type ResponsesInputItem =
	| ResponsesInputMessage
	| ResponsesFunctionCall
	| ResponsesFunctionCallOutput
	| ResponsesReasoning;

export class OpenaiResponsesApi extends CommonApi<ResponsesInputItem, Record<string, unknown>> {
	private _responseId: string | null = null;

	constructor() {
		super();
	}

	get responseId(): string | null {
		return this._responseId;
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ResponsesInputItem[] {
		const out: ResponsesInputItem[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const thinkingParts: string[] = [];

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
				} else if (part instanceof vscode.LanguageModelThinkingPart && modelConfig.includeReasoningInRequest) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			// assistant message (optional)
			if (role === "assistant") {
				if (joinedText) {
					out.push({
						role: "assistant",
						content: [{ type: "output_text", text: joinedText }],
						type: "message",
						id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}

				if (joinedThinking) {
					out.push({
						summary: [{ type: "summary_text", text: joinedThinking }],
						type: "reasoning",
						id: `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}

				for (const tc of toolCalls) {
					out.push({
						type: "function_call",
						id: `fc_${tc.id}`,
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
						status: "completed",
					});
				}
			}

			// tool outputs
			for (const tr of toolResults) {
				if (!tr.callId) {
					continue;
				}
				out.push({
					type: "function_call_output",
					call_id: tr.callId,
					output: tr.content || "",
					id: `fco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					status: "completed",
				});
			}

			// user message
			if (role === "user") {
				const contentArray: ResponsesContentPart[] = [];
				if (joinedText) {
					contentArray.push({ type: "input_text", text: joinedText });
				}
				for (const imagePart of imageParts) {
					const dataUrl = createDataUrl(imagePart);
					contentArray.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
				}
				if (contentArray.length > 0) {
					out.push({
						role: "user",
						content: contentArray,
						type: "message",
						status: "completed",
					});
				}
			}

			// system message (used to build `instructions` in request body)
			if (role === "system" && joinedText) {
				this._systemContent = joinedText;
			}
		}

		// the last user message may be incomplete
		if (out.length > 0) {
			const lastItem = out[out.length - 1];
			if (lastItem && typeof lastItem === "object" && "type" in lastItem) {
				const item = lastItem as unknown as Record<string, unknown>;
				if (item.type === "message" && item.role === "user") {
					item.status = "incomplete";
				}
			}
		}
		return out;
	}

	prepareRequestBody(
		rb: Record<string, unknown>,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> {
		const isPlainObject = (v: unknown): v is Record<string, unknown> =>
			!!v && typeof v === "object" && !Array.isArray(v);

		// Add system content if we extracted it
		if (this._systemContent) {
			rb.instructions = this._systemContent;
		}

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// top_p
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// max_output_tokens
		if (um?.max_completion_tokens !== undefined) {
			rb.max_output_tokens = um.max_completion_tokens;
		} else if (um?.max_tokens !== undefined) {
			rb.max_output_tokens = um.max_tokens;
		}

		// OpenAI reasoning configuration
		if (um?.reasoning_effort !== undefined) {
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort: um.reasoning_effort,
			};
		}

		// thinking (Volcengine provider)
		if (um?.thinking?.type !== undefined) {
			rb.thinking = {
				type: um.thinking.type,
			};
		}

		// stop
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		// tools
		const toolConfig = convertToolsToOpenAIResponses(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			rb.tool_choice = toolConfig.tool_choice;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					// Deep-merge reasoning config so `extra.reasoning` doesn't clobber `reasoning.effort`.
					if (key === "reasoning" && isPlainObject(value) && isPlainObject(rb.reasoning)) {
						rb.reasoning = { ...(rb.reasoning as Record<string, unknown>), ...(value as Record<string, unknown>) };
						continue;
					}
					rb[key] = value;
				}
			}
		}

		return rb;
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this._responseId = null;
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
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						await this.flushToolCallBuffers(progress, false);
						continue;
					}

					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						await this.processEvent(parsed, progress);
					} catch {
						// Silently ignore malformed SSE lines
					}
				}
			}
		} finally {
			reader.releaseLock();
			this.reportEndThinking(progress);
		}
	}

	private coerceText(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			if (typeof obj.text === "string") {
				return obj.text;
			}
			if (typeof obj.thinking === "string") {
				return obj.thinking;
			}
			if (typeof obj.reasoning === "string") {
				return obj.reasoning;
			}
			if (typeof obj.summary === "string") {
				return obj.summary;
			}
			if (typeof obj.value === "string") {
				return obj.value;
			}
		}
		return "";
	}

	private looksLikeReasoningConfigValue(value: string): boolean {
		const v = (value || "").trim().toLowerCase();
		return (
			v === "high" ||
			v === "medium" ||
			v === "low" ||
			v === "minimal" ||
			v === "auto" ||
			v === "none" ||
			v === "detailed" ||
			v === "concise"
		);
	}

	private processOutputTextChunk(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		if (!text) {
			return;
		}
		// Process XML think blocks or text content (mutually exclusive)
		const xmlRes = this.processXmlThinkBlocks(text, progress);
		if (!xmlRes.emittedAny) {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			// Only process text content if no XML think blocks were emitted
			const res = this.processTextContent(text, progress);
			if (res.emittedAny) {
				this._hasEmittedAssistantText = true;
				this._hasEmittedText = true;
			}
		}
	}

	private async processEvent(
		event: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const eventType = typeof event.type === "string" ? event.type : "";
		if (!eventType) {
			return;
		}

		this.captureResponseIdFromEvent(event);

		switch (eventType) {
			case "error": {
				const errorText = JSON.stringify(event);
				console.error("[OAI Compatible Model Provider] Responses API streaming process error:", errorText);
				return;
			}

			// Output text delta events
			case "response.output_text.delta":
			case "response.refusal.delta": {
				this._hasEmittedText = false;
				const delta = this.coerceText(event.delta);
				this.processOutputTextChunk(delta, progress);
				return;
			}

			// Output text done events
			case "response.output_text.done": {
				// Some gateways only emit a final "done" payload (no deltas).
				if (this._hasEmittedText) {
					this._hasEmittedText = false;
					return;
				}
				const text = this.coerceText(event.text);
				this.processOutputTextChunk(text, progress);
				return;
			}
			case "response.refusal.done": {
				return;
			}

			// Reasoning delta events
			case "response.reasoning.delta":
			case "response.reasoning_text.delta":
			case "response.reasoning_summary.delta":
			case "response.reasoning_summary_text.delta":
			case "response.thinking.delta":
			case "response.thinking_summary.delta":
			case "response.thought.delta":
			case "response.thought_summary.delta": {
				this._hasEmittedThinking = false;
				this.processReasoningText(event, progress);
				return;
			}

			// Reasoning done events
			case "response.reasoning.done":
			case "response.reasoning_text.done":
			case "response.reasoning_summary.done":
			case "response.reasoning_summary_text.done":
			case "response.thinking.done":
			case "response.thinking_summary.done":
			case "response.thought.done":
			case "response.thought_summary.done": {
				if (this._hasEmittedThinking) {
					this.reportEndThinking(progress);
					this._hasEmittedThinking = false;
					return;
				}

				this.processReasoningText(event, progress);
				this.reportEndThinking(progress);
				return;
			}

			// Tool call events
			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done": {
				this.reportEndThinking(progress);

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const callId = this.getCallIdFromEvent(event);
				const name = typeof event.name === "string" ? event.name : "";
				const chunk =
					eventType === "response.function_call_arguments.delta"
						? typeof event.delta === "string"
							? event.delta
							: ""
						: typeof event.arguments === "string"
							? event.arguments
							: "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) {
					buf.id = callId;
				}
				if (!buf.name && name) {
					buf.name = name;
				}

				if (eventType === "response.function_call_arguments.delta") {
					if (chunk) buf.args += chunk;
				} else {
					// "done" events typically provide the full argument string.
					buf.args = chunk;
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType === "response.function_call_arguments.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.output_item.added":
			case "response.output_item.done": {
				const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
				if (!item || item.type !== "function_call") {
					return;
				}

				this.reportEndThinking(progress);

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const callId = this.getCallIdFromEvent(item);
				const name =
					typeof item.name === "string"
						? item.name
						: item.function &&
							  typeof item.function === "object" &&
							  typeof (item.function as Record<string, unknown>).name === "string"
							? String((item.function as Record<string, unknown>).name)
							: "";
				const args =
					typeof item.arguments === "string"
						? item.arguments
						: item.function &&
							  typeof item.function === "object" &&
							  typeof (item.function as Record<string, unknown>).arguments === "string"
							? String((item.function as Record<string, unknown>).arguments)
							: "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) {
					buf.id = callId;
				}
				if (!buf.name && name) {
					buf.name = name;
				}
				if (args) {
					buf.args = args;
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType == "response.output_item.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.completed":
			case "response.done": {
				// End of message - ensure thinking is ended and flush all tool calls
				await this.flushToolCallBuffers(progress, false);
				this.reportEndThinking(progress);
				return;
			}
		}
	}

	private captureResponseIdFromEvent(event: Record<string, unknown>): void {
		if (this._responseId) {
			return;
		}

		const responseId = event.response_id;
		if (typeof responseId === "string" && responseId.trim()) {
			this._responseId = responseId;
			return;
		}

		const response = event.response;
		if (response && typeof response === "object" && !Array.isArray(response)) {
			const id = (response as Record<string, unknown>).id;
			if (typeof id === "string" && id.trim()) {
				this._responseId = id;
			}
		}
	}

	private processReasoningText(
		event: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>
	) {
		const candidates = [
			this.coerceText(event.delta),
			this.coerceText(event.text),
			this.coerceText((event as Record<string, unknown>).reasoning),
			this.coerceText((event as Record<string, unknown>).summary),
		].filter(Boolean);

		for (const chunk of candidates) {
			if (this.looksLikeReasoningConfigValue(chunk)) {
				continue;
			}
			this.bufferThinkingContent(chunk, progress);
			break;
		}
	}

	private getCallIdFromEvent(event: Record<string, unknown>): string {
		const callIdRaw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
		return typeof callIdRaw === "string" ? callIdRaw : "";
	}

	async *createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }> {
		throw new Error("Method not implemented.");
	}
}
