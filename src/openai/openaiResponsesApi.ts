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
}

export interface ResponsesContentPart {
	type: "input_text" | "input_image" | "output_text";
	text?: string;
	image_url?: string;
}

export interface ResponsesFunctionCall {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
}

export interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
}

export type ResponsesInputItem = ResponsesInputMessage | ResponsesFunctionCall | ResponsesFunctionCallOutput;

export class OpenaiResponsesApi extends CommonApi<ResponsesInputItem, Record<string, unknown>> {
	constructor() {
		super();
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
				const assistantText = joinedText || joinedThinking;
				if (assistantText) {
					out.push({
						role: "assistant",
						content: [{ type: "output_text", text: assistantText }],
					});
				}

				for (const tc of toolCalls) {
					out.push({
						type: "function_call",
						id: `fc_${tc.id}`,
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
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
					contentArray.push({ type: "input_image", image_url: dataUrl });
				}
				if (contentArray.length > 0) {
					out.push({ role: "user", content: contentArray });
				}
			}

			// system message (used to build `instructions` in request body)
			if (role === "system" && joinedText) {
				out.push({ role: "system", content: [{ type: "input_text", text: joinedText }] });
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

		// max_output_tokens
		if (um?.max_completion_tokens !== undefined) {
			rb.max_output_tokens = um.max_completion_tokens;
		} else if (um?.max_tokens !== undefined) {
			rb.max_output_tokens = um.max_tokens;
		}

		// OpenAI reasoning configuration
		if (um?.reasoning_effort !== undefined) {
			rb.reasoning = {
				effort: um.reasoning_effort,
			};
		}

		// stop
		if (options.modelOptions) {
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

	private async processEvent(event: Record<string, unknown>, progress: Progress<LanguageModelResponsePart2>): Promise<void> {
		const eventType = typeof event.type === "string" ? event.type : "";
		if (!eventType) {
			return;
		}

		switch (eventType) {
			case "response.output_text.delta":
			case "response.refusal.delta": {
				const delta = typeof event.delta === "string" ? event.delta : "";
				if (!delta) {
					return;
				}
				this.reportEndThinking(progress);
				progress.report(new vscode.LanguageModelTextPart(delta));
				this._hasEmittedAssistantText = true;
				return;
			}

			case "response.output_text.done":
			case "response.refusal.done": {
				// Some gateways only emit a final "done" payload (no deltas).
				const text = typeof event.text === "string" ? event.text : "";
				if (!text || this._hasEmittedAssistantText) {
					return;
				}
				this.reportEndThinking(progress);
				progress.report(new vscode.LanguageModelTextPart(text));
				this._hasEmittedAssistantText = true;
				return;
			}

			case "response.reasoning.delta":
			case "response.reasoning_summary.delta": {
				const delta = typeof event.delta === "string" ? event.delta : "";
				if (delta) {
					this.bufferThinkingContent(delta, progress);
				}
				return;
			}

			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done":
			case "response.function_call.done": {
				this.reportEndThinking(progress);

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

				if (!callId) {
					return;
				}

				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = this.getToolCallIndex(callId);
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				buf.id = callId;
				if (name) {
					buf.name = name;
				}

				if (eventType === "response.function_call_arguments.delta" && chunk) {
					buf.args += chunk;
				} else if (chunk) {
					// "done" events typically provide the full argument string.
					buf.args = chunk;
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);

				if (eventType !== "response.function_call_arguments.delta") {
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

				const callId = this.getCallIdFromEvent(item);
				const name =
					typeof item.name === "string"
						? item.name
						: item.function && typeof item.function === "object" && typeof (item.function as Record<string, unknown>).name === "string"
							? String((item.function as Record<string, unknown>).name)
							: "";
				const args =
					typeof item.arguments === "string"
						? item.arguments
						: item.function && typeof item.function === "object" && typeof (item.function as Record<string, unknown>).arguments === "string"
							? String((item.function as Record<string, unknown>).arguments)
							: "";

				if (!callId) {
					return;
				}

				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = this.getToolCallIndex(callId);
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				buf.id = callId;
				if (name) {
					buf.name = name;
				}
				if (args) {
					buf.args = args;
				}
				this._toolCallBuffers.set(idx, buf);
				await this.tryEmitBufferedToolCall(idx, progress);
				return;
			}

			case "response.completed":
			case "response.done": {
				// Response complete (some gateways use `response.done`).
				const responseObj =
					event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : null;

				if (responseObj) {
					if (!this._hasEmittedAssistantText) {
						const text = this.extractOutputText(responseObj);
						if (text) {
							this.reportEndThinking(progress);
							progress.report(new vscode.LanguageModelTextPart(text));
							this._hasEmittedAssistantText = true;
						}
					}

					for (const call of this.extractToolCalls(responseObj)) {
						const idx = this.getToolCallIndex(call.callId);
						if (this._completedToolCallIndices.has(idx)) {
							continue;
						}
						const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
						buf.id = call.callId;
						buf.name = call.name;
						buf.args = call.args;
						this._toolCallBuffers.set(idx, buf);
						await this.tryEmitBufferedToolCall(idx, progress);
					}
				}

				await this.flushToolCallBuffers(progress, true);
				return;
			}
		}
	}

	private getCallIdFromEvent(event: Record<string, unknown>): string {
		const callIdRaw = event.call_id ?? event.callId ?? event.id;
		return typeof callIdRaw === "string" ? callIdRaw : "";
	}

	private extractOutputText(response: Record<string, unknown>): string {
		const outputText = response.output_text;
		if (typeof outputText === "string" && outputText.trim()) {
			return outputText;
		}

		const output = Array.isArray(response.output) ? response.output : [];
		const parts: string[] = [];
		for (const item of output) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const itemObj = item as Record<string, unknown>;
			const content = Array.isArray(itemObj.content) ? itemObj.content : [];
			for (const c of content) {
				if (!c || typeof c !== "object") {
					continue;
				}
				const cObj = c as Record<string, unknown>;
				if (cObj.type !== "output_text") {
					continue;
				}
				if (typeof cObj.text === "string" && cObj.text) {
					parts.push(cObj.text);
				}
			}
		}
		return parts.join("");
	}

	private extractToolCalls(response: Record<string, unknown>): Array<{ callId: string; name: string; args: string }> {
		const output = Array.isArray(response.output) ? response.output : [];
		const out: Array<{ callId: string; name: string; args: string }> = [];

		for (const item of output) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const itemObj = item as Record<string, unknown>;
			if (itemObj.type !== "function_call") {
				continue;
			}

			const callId = this.getCallIdFromEvent(itemObj);
			if (!callId) {
				continue;
			}

			const name = typeof itemObj.name === "string" ? itemObj.name : "";
			const args = typeof itemObj.arguments === "string" ? itemObj.arguments : "";
			if (!name || !args) {
				continue;
			}
			out.push({ callId, name, args });
		}

		return out;
	}

	private _toolCallIdToIndex = new Map<string, number>();
	private _nextToolCallIndex = 0;

	private getToolCallIndex(callId: string): number {
		if (!this._toolCallIdToIndex.has(callId)) {
			this._toolCallIdToIndex.set(callId, this._nextToolCallIndex++);
		}
		return this._toolCallIdToIndex.get(callId)!;
	}
}
