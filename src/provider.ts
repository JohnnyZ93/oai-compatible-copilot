import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { parseModelId, createRetryConfig, executeWithRetry, normalizeUserModels } from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { prepareTokenCount } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string,
		private readonly statusBarItem: vscode.StatusBarItem
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation(
			{ silent: options.silent ?? false },
			_token,
			this.secrets,
			this.userAgent
		);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return prepareTokenCount(model, text, _token, { includeReasoningInRequest: false });
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[OAI Compatible Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		try {
			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

			// Parse model ID to handle config ID
			const parsedModelId = parseModelId(model.id);

			// Find matching user model configuration
			// Prioritize matching models with same base ID and config ID
			// If no config ID, match models with same base ID
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// If still no model found, try to find any model matching the base ID (most lenient match, for backward compatibility)
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			// Prepare model configuration
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
			};

			// Update Token Usage
			updateContextStatusBar(messages, model, this.statusBarItem, modelConfig);

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("oaicopilot.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key for the model's provider
			const provider = um?.owned_by;
			const useGenericKey = !um?.baseUrl;
			const modelApiKey = await this.ensureApiKey(useGenericKey, provider);
			if (!modelApiKey) {
				throw new Error("OAI Compatible API key not found");
			}

			// send chat request
			const BASE_URL = um?.baseUrl || config.get<string>("oaicopilot.baseUrl", "");
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			// get retry config
			const retryConfig = createRetryConfig();

			// Check if using Ollama native API mode
			const apiMode = um?.apiMode ?? "openai";

			// prepare headers with custom headers if specified
			const requestHeaders = this.prepareHeaders(modelApiKey, apiMode, um?.headers);

			// console.debug("[OAI Compatible Model Provider] messages:", JSON.stringify(messages));
			if (apiMode === "ollama") {
				// Ollama native API mode
				const ollamaApi = new OllamaApi();
				const ollamaMessages = ollamaApi.convertMessages(messages, modelConfig);

				let ollamaRequestBody: OllamaRequestBody = {
					model: parsedModelId.baseId,
					messages: ollamaMessages,
					stream: true,
				};
				ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, um, options);
				// console.debug("[OAI Compatible Model Provider] RequestBody:", JSON.stringify(ollamaRequestBody));

				// send Ollama chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/api/chat`;
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(ollamaRequestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Ollama Provider] Ollama API error response", errorText);
						throw new Error(
							`Ollama API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Ollama API");
				}
				await ollamaApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "anthropic") {
				// Anthropic API mode
				const anthropicApi = new AnthropicApi();
				const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: AnthropicRequestBody = {
					model: parsedModelId.baseId,
					messages: anthropicMessages,
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);
				// console.debug("[OAI Compatible Model Provider] RequestBody:", JSON.stringify(requestBody));

				// send Anthropic chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/v1/messages`;
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Anthropic Provider] Anthropic API error response", errorText);
						throw new Error(
							`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "openai-responses") {
				// OpenAI Responses API mode
				const openaiResponsesApi = new OpenaiResponsesApi();
				const rawInput = openaiResponsesApi.convertMessages(messages, modelConfig);

				const instructionsParts: string[] = [];
				const input: unknown[] = [];
				for (const item of rawInput) {
					if (
						item &&
						typeof item === "object" &&
						"role" in item &&
						(item as { role?: unknown }).role === "system" &&
						Array.isArray((item as { content?: unknown }).content)
					) {
						for (const part of (item as { content: unknown[] }).content) {
							if (
								part &&
								typeof part === "object" &&
								(part as { type?: unknown }).type === "input_text" &&
								typeof (part as { text?: unknown }).text === "string" &&
								(part as { text: string }).text.trim()
							) {
								instructionsParts.push((part as { text: string }).text);
							}
						}
						continue;
					}
					input.push(item);
				}

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					input,
					stream: true,
				};
				if (instructionsParts.length > 0) {
					requestBody.instructions = instructionsParts.join("\n");
				}
				requestBody = openaiResponsesApi.prepareRequestBody(requestBody, um, options);

				// send Responses API request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/responses`;
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[OAI Compatible Model Provider] Responses API error response", errorText);
						throw new Error(
							`Responses API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Responses API");
				}
				await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "gemini") {
				// Gemini native API mode
				const geminiApi = new GeminiApi(this._geminiToolCallMetaByCallId);
				const geminiMessages = geminiApi.convertMessages(messages, modelConfig);

				const systemParts: string[] = [];
				const contents: GeminiGenerateContentRequest["contents"] = [];
				for (const msg of geminiMessages) {
					if (msg.role === "system") {
						const text = msg.parts
							.map((p) =>
								p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
									? String((p as { text: string }).text)
									: ""
							)
							.join("")
							.trim();
						if (text) {
							systemParts.push(text);
						}
						continue;
					}
					contents.push({ role: msg.role, parts: msg.parts });
				}

				let requestBody: GeminiGenerateContentRequest = {
					contents,
				};
				if (systemParts.length > 0) {
					requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
				}
				requestBody = geminiApi.prepareRequestBody(requestBody, um, options);

				const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
				if (!url) {
					throw new Error("Invalid Gemini base URL configuration.");
				}

				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Gemini Provider] Gemini API error response", errorText);
						throw new Error(
							`Gemini API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Gemini API");
				}
				await geminiApi.processStreamingResponse(response.body, trackingProgress, token);
			} else {
				// OpenAI compatible API mode (default)
				const openaiApi = new OpenaiApi();
				const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					messages: openaiMessages,
					stream: true,
					stream_options: { include_usage: true },
				};
				requestBody = openaiApi.prepareRequestBody(requestBody, um, options);
				// console.debug("[OAI Compatible Model Provider] RequestBody:", JSON.stringify(requestBody));

				// send chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[OAI Compatible Model Provider] OAI Compatible API error response", errorText);
						throw new Error(
							`OAI Compatible API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from OAI Compatible API");
				}
				await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
			}
		} catch (err) {
			console.error("[OAI Compatible Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			throw err;
		} finally {
			// Update last request time after successful completion
			this._lastRequestTime = Date.now();
		}
	}

	/**
	 * Prepare headers for API request.
	 * @param apiKey The API key to use.
	 * @param apiMode The apiMode (affects header format).
	 * @param customHeaders Optional custom headers from model config.
	 * @returns Headers object.
	 */
	private prepareHeaders(
		apiKey: string,
		apiMode: string,
		customHeaders?: Record<string, string>
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": this.userAgent,
		};

		// Provider-specific header formats
		if (apiMode === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
		} else if (apiMode === "gemini") {
			headers["x-goog-api-key"] = apiKey;
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		// Merge custom headers
		if (customHeaders) {
			return { ...headers, ...customHeaders };
		}

		return headers;
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param useGenericKey If true, use generic API key.
	 * @param provider Optional provider name to get provider-specific API key.
	 */
	private async ensureApiKey(useGenericKey: boolean, provider?: string): Promise<string | undefined> {
		// Try to get provider-specific API key first
		let apiKey: string | undefined;
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.trim().toLowerCase();
			const providerKey = `oaicopilot.apiKey.${normalizedProvider}`;
			apiKey = await this.secrets.get(providerKey);

			if (!apiKey && !useGenericKey) {
				const entered = await vscode.window.showInputBox({
					title: `OAI Compatible API Key for ${normalizedProvider}`,
					prompt: `Enter your OAI Compatible API key for ${normalizedProvider}`,
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store(providerKey, apiKey);
				}
			}
		}

		// Fall back to generic API key
		if (!apiKey) {
			apiKey = await this.secrets.get("oaicopilot.apiKey");
		}

		if (!apiKey && useGenericKey) {
			const entered = await vscode.window.showInputBox({
				title: "OAI Compatible API Key",
				prompt: "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("oaicopilot.apiKey", apiKey);
			}
		}
		return apiKey;
	}
}
