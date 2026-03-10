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

import type { FallbackModelRef, HFModelItem, RetryConfig } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { buildResolvedModelKey, parseModelId, executeWithRetry, normalizeUserModels } from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { prepareTokenCount } from "./provideToken";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi } from "./commonApi";
import { ChatRequestContext, FallbackExecutor, ResolvedChatModelTarget } from "./fallbackExecutor";

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly fallbackExecutor = new FallbackExecutor();

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();
	private readonly _openaiResponsesPreviousResponseIdUnsupportedBaseUrls = new Set<string>();

	static readonly OPENAI_RESPONSES_STATEFUL_MARKER_MIME = "application/vnd.oaicopilot.stateful-marker";

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(private readonly secrets: vscode.SecretStorage) {}

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
		return prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token, this.secrets);
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

			const primaryModel: HFModelItem = um ?? {
				id: parsedModelId.baseId,
				configId: parsedModelId.configId,
				owned_by: "",
			};
			const primaryTarget = await this.resolveChatModelTarget(primaryModel, model.id, config);
			const requestContext: ChatRequestContext = {
				messages,
				options,
				progress: trackingProgress,
				token,
			};

			await this.fallbackExecutor.executeWithFallback(
				primaryTarget,
				um?.fallbacks,
				async (fallback) => await this.resolveFallbackTarget(fallback, userModels, config),
				this.executeChatRequest.bind(this),
				requestContext
			);
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

	private findConfiguredModel(
		userModels: readonly HFModelItem[],
		modelId: string,
		configId?: string,
		provider?: string
	): HFModelItem | undefined {
		const normalizedProvider = provider?.trim().toLowerCase();
		const candidates = userModels.filter((userModel) => {
			if (userModel.id !== modelId) {
				return false;
			}
			if (!normalizedProvider) {
				return true;
			}
			return userModel.owned_by?.trim().toLowerCase() === normalizedProvider;
		});

		if (candidates.length === 0) {
			return undefined;
		}

		if (configId) {
			const configCandidates = candidates.filter((candidate) => candidate.configId === configId);
			if (configCandidates.length <= 1) {
				return configCandidates[0] ?? candidates[0];
			}

			console.warn(
				`[OAI Compatible Model Provider] Ambiguous model '${modelId}::${configId}' across multiple providers. Specify fallback provider explicitly.`
			);
			return undefined;
		}

		const defaultCandidates = candidates.filter((candidate) => !candidate.configId);
		if (defaultCandidates.length === 1) {
			return defaultCandidates[0];
		}

		if (defaultCandidates.length > 1 || candidates.length > 1) {
			console.warn(
				`[OAI Compatible Model Provider] Ambiguous model '${modelId}' across multiple providers. Specify fallback provider explicitly.`
			);
			return undefined;
		}

		return candidates[0];
	}

	private async resolveFallbackTarget(
		fallback: FallbackModelRef,
		userModels: readonly HFModelItem[],
		config: vscode.WorkspaceConfiguration
	): Promise<ResolvedChatModelTarget | undefined> {
		const rawModelId = fallback.modelId ?? fallback.id;
		if (!rawModelId) {
			return undefined;
		}

		const resolvedModel = this.findConfiguredModel(userModels, rawModelId, fallback.configId, fallback.owned_by);
		if (!resolvedModel) {
			console.warn(
				`[OAI Compatible Model Provider] Could not resolve fallback model '${rawModelId}'. If multiple providers expose this model ID, specify 'owned_by' or use 'provider|modelId'.`
			);
			return undefined;
		}

		return await this.resolveChatModelTarget(
			resolvedModel,
			buildResolvedModelKey(resolvedModel.owned_by, resolvedModel.id, resolvedModel.configId),
			config
		);
	}

	private async resolveChatModelTarget(
		userModel: HFModelItem,
		resolvedModelId: string,
		config: vscode.WorkspaceConfiguration
	): Promise<ResolvedChatModelTarget> {
		const baseUrl = userModel.baseUrl || config.get<string>("oaicopilot.baseUrl", "");
		if (!baseUrl || !baseUrl.startsWith("http")) {
			throw new Error("Invalid base URL configuration.");
		}

		const provider = userModel.owned_by?.trim() || undefined;
		const useGenericKey = !userModel.baseUrl;
		const apiKey = await this.ensureApiKey(useGenericKey, provider);
		if (!apiKey) {
			throw new Error("OAI Compatible API key not found");
		}

		return {
			resolvedModelId,
			requestModelId: userModel.id,
			userModel,
			baseUrl,
			apiKey,
			apiMode: userModel.apiMode ?? "openai",
			selectedModelId: userModel.id,
			selectedProvider: userModel.owned_by,
		};
	}

	private getRoutingInstruction(target: ResolvedChatModelTarget): string | undefined {
		const actualProvider = target.userModel.owned_by?.trim() || undefined;
		const selectedProvider = target.selectedProvider?.trim() || undefined;
		const modelChanged = target.selectedModelId !== target.requestModelId;
		const providerChanged = selectedProvider !== actualProvider;

		if (!modelChanged && !providerChanged) {
			return undefined;
		}

		const selectedLabel = selectedProvider
			? `${target.selectedModelId} via provider ${selectedProvider}`
			: target.selectedModelId;
		const actualLabel = actualProvider ? `${target.requestModelId} via provider ${actualProvider}` : target.requestModelId;
		const failoverReason = target.failoverReason ? target.failoverReason.split("\n")[0].trim() : undefined;

		return [
			`Routing notice: the user selected ${selectedLabel}, but this request was automatically routed to ${actualLabel} because the original route failed.`,
			failoverReason ? `The previous route failed with: ${failoverReason}.` : "",
			`If asked which model you are, identify yourself as ${actualLabel}.`,
			`Do not claim to be ${selectedLabel} for this response.`,
			`If you provide a direct user-facing answer in this turn, end with one brief sentence noting that the response was automatically rerouted after an upstream model failure.`
		].join(" ");
	}

	private async executeChatRequest(
		target: ResolvedChatModelTarget,
		ctx: ChatRequestContext,
		retryConfig: RetryConfig
	): Promise<void> {
		const { messages, options, progress, token } = ctx;
		const { apiKey, apiMode, baseUrl, requestModelId, userModel } = target;
		const modelConfig = {
			includeReasoningInRequest: userModel.include_reasoning_in_request ?? false,
		};
		const routingInstruction = this.getRoutingInstruction(target);
		const requestHeaders = CommonApi.prepareHeaders(apiKey, apiMode, userModel.headers);

		if (apiMode === "ollama") {
			const ollamaApi = new OllamaApi();
			const ollamaMessages = ollamaApi.convertMessages(messages, modelConfig);
			if (routingInstruction) {
				ollamaMessages.unshift({
					role: "system",
					content: routingInstruction,
				});
			}

			let ollamaRequestBody: OllamaRequestBody = {
				model: requestModelId,
				messages: ollamaMessages,
				stream: true,
			};
			ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, userModel, options);

			const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
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
			await ollamaApi.processStreamingResponse(response.body, progress, token);
			return;
		}

		if (apiMode === "anthropic") {
			const anthropicApi = new AnthropicApi();
			const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

			let requestBody: AnthropicRequestBody = {
				model: requestModelId,
				messages: anthropicMessages,
				stream: true,
			};
			requestBody = anthropicApi.prepareRequestBody(requestBody, userModel, options);
			if (routingInstruction) {
				requestBody.system = requestBody.system
					? `${requestBody.system}\n\n${routingInstruction}`
					: routingInstruction;
			}

			const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
			const url = normalizedBaseUrl.endsWith("/v1")
				? `${normalizedBaseUrl}/messages`
				: `${normalizedBaseUrl}/v1/messages`;
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
			await anthropicApi.processStreamingResponse(response.body, progress, token);
			return;
		}

		if (apiMode === "openai-responses") {
			const openaiResponsesApi = new OpenaiResponsesApi();
			const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
			const statefulModelId = requestModelId;
			const fullInput = openaiResponsesApi.convertMessages(messages, modelConfig);

			const marker = findLastOpenAIResponsesStatefulMarker(statefulModelId, messages);
			let deltaInput: unknown[] | null = null;
			if (marker && marker.index >= 0 && marker.index < messages.length - 1) {
				const deltaMessages = messages.slice(marker.index + 1);
				const converted = openaiResponsesApi.convertMessages(deltaMessages, modelConfig);
				if (converted.length > 0) {
					deltaInput = converted;
				}
			}

			const canUsePreviousResponseId =
				!!marker?.marker &&
				!this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.has(normalizedBaseUrl) &&
				Array.isArray(deltaInput) &&
				deltaInput.length > 0;

			const input = canUsePreviousResponseId ? deltaInput : fullInput;
			let requestBody: Record<string, unknown> = {
				model: requestModelId,
				input,
				stream: true,
			};
			requestBody = openaiResponsesApi.prepareRequestBody(requestBody, userModel, options);
			if (routingInstruction) {
				requestBody.instructions =
					typeof requestBody.instructions === "string" && requestBody.instructions.trim()
						? `${String(requestBody.instructions)}\n\n${routingInstruction}`
						: routingInstruction;
			}
			const url = `${normalizedBaseUrl}/responses`;

			let addedPreviousResponseId = false;
			if (requestBody.previous_response_id !== undefined) {
				requestBody.input = fullInput;
			} else if (canUsePreviousResponseId && marker) {
				requestBody.previous_response_id = marker.marker;
				addedPreviousResponseId = true;
			}

			const sendRequest = async (body: Record<string, unknown>) =>
				await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(body),
					});

					if (!res.ok) {
						const errorText = await res.text();
						const error = new Error(
							`Responses API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
						(error as { status?: number; errorText?: string }).status = res.status;
						(error as { status?: number; errorText?: string }).errorText = errorText;
						throw error;
					}

					return res;
				}, retryConfig);

			let response: Response;
			try {
				response = await sendRequest(requestBody);
			} catch (err) {
				const status = (err as { status?: unknown })?.status;
				const shouldFallback =
					addedPreviousResponseId && typeof status === "number" && status >= 400 && status < 500 && status !== 429;
				if (!shouldFallback) {
					throw err;
				}

				this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.add(normalizedBaseUrl);

				let fallbackBody: Record<string, unknown> = {
					model: requestModelId,
					input: fullInput,
					stream: true,
				};
				fallbackBody = openaiResponsesApi.prepareRequestBody(fallbackBody, userModel, options);
				if (routingInstruction) {
					fallbackBody.instructions =
						typeof fallbackBody.instructions === "string" && fallbackBody.instructions.trim()
							? `${String(fallbackBody.instructions)}\n\n${routingInstruction}`
							: routingInstruction;
				}
				delete fallbackBody.previous_response_id;
				response = await sendRequest(fallbackBody);
			}

			if (!response.body) {
				throw new Error("No response body from Responses API");
			}
			await openaiResponsesApi.processStreamingResponse(response.body, progress, token);

			const responseId = openaiResponsesApi.responseId;
			if (responseId) {
				progress.report(createOpenAIResponsesStatefulMarkerPart(statefulModelId, responseId));
			}
			return;
		}

		if (apiMode === "gemini") {
			const geminiApi = new GeminiApi(this._geminiToolCallMetaByCallId);
			const geminiMessages = geminiApi.convertMessages(messages, modelConfig);

			const systemParts: string[] = [];
			const contents: GeminiGenerateContentRequest["contents"] = [];
			for (const msg of geminiMessages) {
				if (msg.role === "system") {
					const text = msg.parts
						.map((part) =>
							part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
								? String((part as { text: string }).text)
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
			if (routingInstruction) {
				systemParts.push(routingInstruction);
			}

			let requestBody: GeminiGenerateContentRequest = {
				contents,
			};
			if (systemParts.length > 0) {
				requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
			}
			requestBody = geminiApi.prepareRequestBody(requestBody, userModel, options);

			const url = buildGeminiGenerateContentUrl(baseUrl, requestModelId, true);
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
			await geminiApi.processStreamingResponse(response.body, progress, token);
			return;
		}

		const openaiApi = new OpenaiApi();
		const openaiMessages = openaiApi.convertMessages(messages, modelConfig);
		if (routingInstruction) {
			openaiMessages.unshift({
				role: "system",
				content: routingInstruction,
			});
		}

		let requestBody: Record<string, unknown> = {
			model: requestModelId,
			messages: openaiMessages,
			stream: true,
			stream_options: { include_usage: true },
		};
		requestBody = openaiApi.prepareRequestBody(requestBody, userModel, options);

		const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
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
		await openaiApi.processStreamingResponse(response.body, progress, token);
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

interface OpenAIResponsesStatefulMarkerLocation {
	marker: string;
	index: number;
}

function createOpenAIResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME);
}

function parseOpenAIResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== "object") {
		return null;
	}
	if (typeof maybe.mimeType !== "string") {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const sep = decoded.indexOf("\\");
		if (sep <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, sep).trim();
		const marker = decoded.slice(sep + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastOpenAIResponsesStatefulMarker(
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[]
): OpenAIResponsesStatefulMarkerLocation | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[i].content ?? []) {
			const parsed = parseOpenAIResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index: i };
			}
		}
	}
	return null;
}
