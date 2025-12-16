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

import { parseModelId, createRetryConfig, executeWithRetry } from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { prepareTokenCount } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

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
		return prepareTokenCount(model, text, _token);
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
		// Update Token Usage
		updateContextStatusBar(messages, model, this.statusBarItem);

		// Apply delay between consecutive requests
		const config = vscode.workspace.getConfiguration();
		const delayMs = config.get<number>("oaicopilot.delay", 0);

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
			const userModels = config.get<HFModelItem[]>("oaicopilot.models", []);

			// 解析模型ID以处理配置ID
			const parsedModelId = parseModelId(model.id);

			// 查找匹配的用户模型配置
			// 优先匹配同时具有相同基础ID和配置ID的模型
			// 如果没有配置ID，则匹配基础ID相同的模型
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// 如果仍然没有找到模型，尝试查找任何匹配基础ID的模型（最宽松的匹配，用于向后兼容）
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			// Prepare model configuration for message conversion
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
			};

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
				const response = await executeWithRetry(async () => {
					const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/api/chat`, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(ollamaRequestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Ollama Provider] Ollama API error response", errorText);
						throw new Error(`Ollama API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`);
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
				const response = await executeWithRetry(async () => {
					const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/v1/messages`, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Anthropic Provider] Anthropic API error response", errorText);
						throw new Error(
							`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
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
				const response = await executeWithRetry(async () => {
					const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[OAI Compatible Model Provider] OAI Compatible API error response", errorText);
						throw new Error(
							`OAI Compatible API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`
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
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
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
			const normalizedProvider = provider.toLowerCase();
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
