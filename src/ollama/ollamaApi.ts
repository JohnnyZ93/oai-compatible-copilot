import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";

import type { OllamaMessage, OllamaRequestBody, OllamaStreamChunk, OllamaToolCall } from "./ollamaTypes";

import { isToolResultPart, collectToolResultText, convertToolsToOpenAI, mapRole } from "../utils";

import { CommonApi } from "../commonApi";

export class OllamaApi extends CommonApi<OllamaMessage, OllamaRequestBody> {
	constructor() {
		super();
	}

	/**
	 * Convert VS Code chat messages to Ollama native message format.
	 * @param messages The VS Code chat messages to convert.
	 * @returns Ollama-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): OllamaMessage[] {
		const out: OllamaMessage[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: string[] = [];
			let thinkingContent = "";
			const toolCalls: OllamaToolCall[] = [];
			const toolResults: { toolName: string; content: string }[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					// Convert image data to base64 for Ollama
					if (part.mimeType.startsWith("image/")) {
						const base64Data = Buffer.from(part.data).toString("base64");
						imageParts.push(base64Data);
					}
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					// Capture thinking content
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingContent += content;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					// Capture tool calls from assistant
					toolCalls.push({
						function: {
							name: part.name,
							arguments: (part.input as Record<string, unknown>) ?? {},
						},
					});
				} else if (isToolResultPart(part)) {
					// Capture tool results
					const content = collectToolResultText(part);
					const toolName = (part as { toolName?: string }).toolName ?? "unknown";
					toolResults.push({ toolName, content });
				}
			}

			// Handle tool results as separate "tool" role messages
			for (const tr of toolResults) {
				out.push({
					role: "tool",
					content: tr.content,
					tool_name: tr.toolName,
				});
			}

			// Handle regular messages
			if (textParts.length > 0 || imageParts.length > 0 || toolCalls.length > 0) {
				const content = textParts.join("").trim();

				const ollamaMessage: OllamaMessage = {
					role,
					content,
				};

				if (imageParts.length > 0) {
					ollamaMessage.images = imageParts;
				}

				if (thinkingContent.trim() && role === "assistant") {
					ollamaMessage.thinking = thinkingContent;
				}

				if (toolCalls.length > 0 && role === "assistant") {
					ollamaMessage.tool_calls = toolCalls;
				}

				out.push(ollamaMessage);
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: OllamaRequestBody,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): OllamaRequestBody {
		// Add model options if configured
		if (
			um?.temperature !== undefined ||
			um?.top_p !== undefined ||
			um?.top_k !== undefined ||
			um?.max_tokens !== undefined
		) {
			rb.options = {};
			if (um.temperature !== undefined && um.temperature !== null) {
				rb.options.temperature = um.temperature;
			}
			if (um.top_p !== undefined && um.top_p !== null) {
				rb.options.top_p = um.top_p;
			}
			if (um.top_k !== undefined) {
				rb.options.top_k = um.top_k;
			}
			if (um.max_tokens !== undefined) {
				rb.options.num_predict = um.max_tokens;
			}
		}

		// Add tools if provided
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
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
	 * Process Ollama native API streaming response (JSON lines format).
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
					if (!line.trim()) {
						continue;
					}

					try {
						const chunk: OllamaStreamChunk = JSON.parse(line);
						// console.debug("[OAI Compatible Model Provider] data:", JSON.stringify(chunk));

						await this.processOllamaDelta(chunk, progress);

						// Check if this is the final chunk
						if (chunk.done) {
							// End any active thinking sequence
							this.reportEndThinking(progress);
						}
					} catch {
						// Silently ignore malformed JSON lines
					}
				}
			}
		} finally {
			reader.releaseLock();
			// End any active thinking sequence
			this.reportEndThinking(progress);
		}
	}

	/**
	 * Process a single Ollama streaming chunk.
	 * @param chunk Parsed Ollama stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processOllamaDelta(
		chunk: OllamaStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const message = chunk.message;
		if (!message) {
			return;
		}

		// Process thinking content first
		if (message.thinking) {
			// Buffer and emit thinking content
			this.bufferThinkingContent(message.thinking, progress);
		}

		// Process tool calls
		if (message.tool_calls && message.tool_calls.length > 0) {
			// End thinking if active
			this.reportEndThinking(progress);

			for (const tc of message.tool_calls) {
				const id = `ollama_tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				progress.report(new vscode.LanguageModelToolCallPart(id, tc.function.name, tc.function.arguments));
			}
		}

		// Process regular content
		if (message.content) {
			// If we have thinking content and now receiving regular content, end thinking first
			this.reportEndThinking(progress);

			// Emit text content
			progress.report(new vscode.LanguageModelTextPart(message.content));
		}
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

/**
 * Fetch available models from Ollama API endpoint.
 * Uses /api/tags endpoint to list local models.
 * @param baseUrl The Ollama API base URL.
 * @param _apiKey Ollama doesn't require authentication (ignored).
 * @returns A promise that resolves to an array of model items.
 */
export async function fetchOllamaModels(baseUrl: string, _apiKey: string): Promise<HFModelItem[]> {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const url = `${trimmed}/api/tags`;

	const resp = await fetch(url, {
		method: "GET",
		headers: { Accept: "application/json" },
	});

	if (!resp.ok) {
		let errorText = "";
		try {
			errorText = await resp.text();
		} catch (error) {
			console.error("[OAI Compatible Model Provider] Failed to read response text", error);
		}
		throw new Error(
			`Ollama API error: [${resp.status}] ${resp.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
		);
	}

	const parsed = (await resp.json()) as import("./ollamaTypes").OllamaTagsResponse;
	const entries = parsed.models ?? [];

	const models: HFModelItem[] = [];
	for (const entry of entries) {
		models.push({
			id: entry.model,
			displayName: entry.name,
			owned_by: "ollama",
			apiMode: "ollama",
		} as HFModelItem);
	}

	return models;
}
