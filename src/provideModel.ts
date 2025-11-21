import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation } from "vscode";

import type { HFModelItem, HFModelsResponse } from "./types";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Get the list of available language models contributed by this provider
 * @param options Options which specify the calling context of this function
 * @param token A cancellation token which signals if the user cancelled the request or not
 * @returns A promise that resolves to the list of available language models
 */
export async function prepareLanguageModelChatInformation(
	options: { silent: boolean },
	_token: CancellationToken,
	secrets: vscode.SecretStorage,
	userAgent: string
): Promise<LanguageModelChatInformation[]> {
	// Check for user-configured models first
	const config = vscode.workspace.getConfiguration();
	const userModels = config.get<HFModelItem[]>("oaicopilot.models", []);

	let infos: LanguageModelChatInformation[];
	if (userModels && userModels.length > 0) {
		// Return user-provided models directly
		infos = userModels.map((m) => {
			const contextLen = m?.context_length ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = m?.max_completion_tokens ?? m?.max_tokens ?? DEFAULT_MAX_TOKENS;
			const maxInput = Math.max(1, contextLen - maxOutput);

			// 使用配置ID（如果存在）来生成唯一的模型ID
			const modelId = m.configId ? `${m.id}::${m.configId}` : m.id;
			const modelName =
				m.displayName || (m.configId ? `${m.id}::${m.configId} via ${m.owned_by}` : `${m.id} via ${m.owned_by}`);

			return {
				id: modelId,
				name: modelName,
				tooltip: m.configId
					? `OAI Compatible ${m.id} (config: ${m.configId}) via ${m.owned_by}`
					: `OAI Compatible via ${m.owned_by}`,
				family: m.family ?? "oai-compatible",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: {
					toolCalling: true,
					imageInput: m?.vision ?? false,
				},
			} satisfies LanguageModelChatInformation;
		});
	} else {
		// Fallback: Fetch models from API
		const apiKey = await ensureApiKey(options.silent, secrets);
		if (!apiKey) {
			if (options.silent) {
				return [];
			} else {
				throw new Error("OAI Compatible API key not found");
			}
		}
		const { models } = await fetchModels(apiKey, userAgent);

		infos = models.flatMap((m) => {
			const providers = m?.providers ?? [];
			const modalities = m.architecture?.input_modalities ?? [];
			const vision = Array.isArray(modalities) && modalities.includes("image");

			// Build entries for all providers that support tool calling
			const toolProviders = providers.filter((p) => p.supports_tools === true);
			const entries: LanguageModelChatInformation[] = [];

			for (const p of toolProviders) {
				const contextLen = p?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				entries.push({
					id: `${m.id}:${p.provider}`,
					name: `${m.id} via ${p.provider}`,
					tooltip: `OAI Compatible via ${p.provider}`,
					family: m.family ?? "oai-compatible",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation);
			}

			if (entries.length === 0) {
				const base = providers.length > 0 ? providers[0] : null;
				const contextLen = base?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				entries.push({
					id: `${m.id}`,
					name: `${m.id} via OAI Compatible`,
					tooltip: "OAI Compatible",
					family: m.family ?? "oai-compatible",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: true,
					},
				} satisfies LanguageModelChatInformation);
			}

			return entries;
		});
	}

	// debug log
	// console.log("[OAI Compatible Model Provider] Loaded models:", infos);
	return infos;
}

/**
 * Fetch the list of models and supplementary metadata from Hugging Face.
 * @param apiKey The HF API key used to authenticate.
 */
async function fetchModels(apiKey: string, userAgent: string): Promise<{ models: HFModelItem[] }> {
	const config = vscode.workspace.getConfiguration();
	const BASE_URL = config.get<string>("oaicopilot.baseUrl", "");
	if (!BASE_URL || !BASE_URL.startsWith("http")) {
		throw new Error(`Invalid base URL configuration.`);
	}
	const modelsList = (async () => {
		const resp = await fetch(`${BASE_URL.replace(/\/+$/, "")}/models`, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": userAgent },
		});
		if (!resp.ok) {
			let text = "";
			try {
				text = await resp.text();
			} catch (error) {
				console.error("[OAI Compatible Model Provider] Failed to read response text", error);
			}
			const err = new Error(
				`Failed to fetch OAI Compatible models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
			);
			console.error("[OAI Compatible Model Provider] Failed to fetch OAI Compatible models", err);
			throw err;
		}
		const parsed = (await resp.json()) as HFModelsResponse;
		return parsed.data ?? [];
	})();

	try {
		const models = await modelsList;
		return { models };
	} catch (err) {
		console.error("[OAI Compatible Model Provider] Failed to fetch OAI Compatible models", err);
		throw err;
	}
}

/**
 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
 * @param silent If true, do not prompt the user.
 * @param secrets vscode.SecretStorage
 */
async function ensureApiKey(silent: boolean, secrets: vscode.SecretStorage): Promise<string | undefined> {
	// Fall back to generic API key
	let apiKey = await secrets.get("oaicopilot.apiKey");

	if (!apiKey && !silent) {
		const entered = await vscode.window.showInputBox({
			title: "OAI Compatible API Key",
			prompt: "Enter your OAI Compatible API key",
			ignoreFocusOut: true,
			password: true,
		});
		if (entered && entered.trim()) {
			apiKey = entered.trim();
			await secrets.store("oaicopilot.apiKey", apiKey);
		}
	}
	return apiKey;
}
