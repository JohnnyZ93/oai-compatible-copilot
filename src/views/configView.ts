import * as vscode from "vscode";
import type { HFModelItem, HFModelsResponse } from "../types";

interface InitPayload {
	baseUrl: string;
	apiKey: string;
	delay: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	models: HFModelItem[];
	providerKeys: Record<string, string>;
}

type IncomingMessage =
	| { type: "requestInit" }
	| {
			type: "saveGlobalConfig";
			baseUrl: string;
			apiKey: string;
			delay: number;
			retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] };
	  }
	| { type: "fetchModels"; baseUrl: string; apiKey: string }
	| { type: "saveModels"; models: HFModelItem[] }
	| { type: "saveProviderKey"; provider: string; apiKey: string | null }
	| { type: "addProvider"; provider: string; baseUrl?: string; apiKey?: string; apiMode?: string }
	| { type: "updateProvider"; provider: string; baseUrl?: string; apiKey?: string; apiMode?: string }
	| { type: "deleteProvider"; provider: string }
	| { type: "addModel"; model: HFModelItem }
	| { type: "updateModel"; model: HFModelItem }
	| { type: "deleteModel"; modelId: string };

export class ConfigViewPanel {
	public static currentPanel: ConfigViewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly secrets: vscode.SecretStorage;
	private disposables: vscode.Disposable[] = [];

	public static openPanel(extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (ConfigViewPanel.currentPanel) {
			ConfigViewPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"oaicopilot.config",
			"OAI Copilot Configuration",
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out"), vscode.Uri.joinPath(extensionUri, "assets")],
			}
		);

		ConfigViewPanel.currentPanel = new ConfigViewPanel(panel, extensionUri, secrets);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.secrets = secrets;

		console.log("[ConfigurationPanel] Initializing configuration panel");
		this.update();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				console.log("[ConfigurationPanel] Received message from webview:", message);
				this.handleMessage(message).catch((err) => {
					console.error("[oaicopilot] handleMessage failed", err);
					vscode.window.showErrorMessage(
						err instanceof Error
							? err.message
							: `Unexpected error while handling configuration message[${message.type}].`
					);
				});
			},
			null,
			this.disposables
		);

		// Send initialization data
		this.sendInit();
	}

	private async update() {
		const webview = this.panel.webview;
		this.panel.webview.html = await this.getHtml(webview);
	}

	public dispose() {
		ConfigViewPanel.currentPanel = undefined;

		this.panel.dispose();

		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	async handleMessage(message: IncomingMessage) {
		switch (message.type) {
			case "requestInit":
				await this.sendInit();
				break;
			case "saveGlobalConfig":
				await this.saveGlobalConfig(message.baseUrl, message.apiKey, message.delay, message.retry);
				break;
			case "fetchModels": {
				const models = await this.fetchModelsFromApi(message.baseUrl, message.apiKey);
				this.panel.webview.postMessage({ type: "modelsFetched", models });
				break;
			}
			case "saveModels":
				await this.saveModels(message.models);
				break;
			case "saveProviderKey":
				await this.saveProviderKey(message.provider, message.apiKey);
				break;
			case "addProvider":
				await this.addProvider(message.provider, message.baseUrl, message.apiKey, message.apiMode);
				break;
			case "updateProvider":
				await this.updateProvider(message.provider, message.baseUrl, message.apiKey, message.apiMode);
				break;
			case "deleteProvider":
				await this.deleteProvider(message.provider);
				break;
			case "addModel":
				await this.addModel(message.model);
				break;
			case "updateModel":
				await this.updateModel(message.model);
				break;
			case "deleteModel":
				await this.deleteModel(message.modelId);
				break;
			default:
				break;
		}
	}

	private async sendInit() {
		const config = vscode.workspace.getConfiguration();
		const baseUrl = config.get<string>("oaicopilot.baseUrl", "https://api.openai.com/v1");
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		const apiKey = (await this.secrets.get("oaicopilot.apiKey")) ?? "";
		const providerKeys: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const key = await this.secrets.get(`oaicopilot.apiKey.${provider}`);
			if (key) {
				providerKeys[provider] = key;
			}
		}

		const delay = config.get<number>("oaicopilot.delay", 0);
		const retry = config.get<{
			enabled?: boolean;
			max_attempts?: number;
			interval_ms?: number;
			status_codes?: number[];
		}>("oaicopilot.retry", {
			enabled: true,
			max_attempts: 3,
			interval_ms: 1000,
		});

		const payload: InitPayload = { baseUrl, apiKey, delay, retry, models, providerKeys };
		this.panel.webview.postMessage({ type: "init", payload });
	}

	private async saveGlobalConfig(
		rawBaseUrl: string,
		rawApiKey: string,
		delay: number,
		retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] }
	) {
		const baseUrl = rawBaseUrl.trim();
		const apiKey = rawApiKey.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.delay", delay, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.retry", retry, vscode.ConfigurationTarget.Global);
		if (apiKey) {
			await this.secrets.store("oaicopilot.apiKey", apiKey);
		} else {
			await this.secrets.delete("oaicopilot.apiKey");
		}
		vscode.window.showInformationMessage("OAI Compatible base URL, Delay, Retry and API Key have been saved to global settings.");
	}

	private async saveModels(models: HFModelItem[]) {
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage("Model configurations have been saved to global settings.");
	}

	private async saveProviderKey(provider: string, apiKey: string | null) {
		const keyId = `oaicopilot.apiKey.${provider}`;
		if (apiKey && apiKey.trim()) {
			await this.secrets.store(keyId, apiKey.trim());
			vscode.window.showInformationMessage(`API Key for ${provider} has been saved.`);
		} else {
			await this.secrets.delete(keyId);
			vscode.window.showInformationMessage(`API Key for ${provider} has been cleared.`);
		}
	}

	private async fetchModelsFromApi(rawBaseUrl: string, apiKey: string): Promise<HFModelItem[]> {
		const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
		if (!baseUrl) {
			throw new Error("Please fill in Base URL first.");
		}
		if (!apiKey.trim()) {
			throw new Error("Please fill in API Key first.");
		}

		const modelsUrl = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
		const headers: Record<string, string> = {
			// "User-Agent": this.userAgent,
		};
		if (apiKey.trim()) {
			headers.Authorization = `Bearer ${apiKey.trim()}`;
		}

		const res = await fetch(modelsUrl, { headers });
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Failed to fetch model list (${res.status}): ${text || "Unknown error"}`);
		}

		const json = (await res.json()) as HFModelsResponse | { data?: unknown };
		if (!json || !Array.isArray((json as HFModelsResponse).data)) {
			throw new Error("Model list response format does not comply with OpenAI /models specification.");
		}

		const data = (json as HFModelsResponse).data;
		return data
			.map((item) => ({
				id: item.id,
				owned_by: item.owned_by ?? "openai",
				object: item.object,
				created: item.created,
				context_length: item.context_length ?? 256000,
				max_tokens: item.max_tokens ?? 8192,
				temperature: item.temperature ?? 0,
				top_p: item.top_p ?? 1,
			}))
			.filter((m) => m.id && m.owned_by);
	}

	private async getHtml(webview: vscode.Webview) {
		const nonce = this.getNonce();
		const assetsRoot = vscode.Uri.joinPath(this.extensionUri, "assets", "configView");
		const templatePath = vscode.Uri.joinPath(assetsRoot, "configView.html");
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configView.css"));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configView.js"));
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'nonce-${nonce}'`,
		].join("; ");

		const raw = await vscode.workspace.fs.readFile(templatePath);
		let html = new TextDecoder("utf-8").decode(raw);
		html = html
			.replaceAll("%CSP_SOURCE%", csp)
			.replaceAll("%NONCE%", nonce)
			.replace("%CSS_URI%", cssUri.toString())
			.replace("%SCRIPT_URI%", jsUri.toString());
		return html;
	}

	private getNonce() {
		return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
	}

	private async addProvider(provider: string, baseUrl?: string, apiKey?: string, apiMode?: string) {
		// Save API key for the provider
		if (apiKey) {
			await this.secrets.store(`oaicopilot.apiKey.${provider}`, apiKey);
		}

		// Save provider configuration to the model list
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		// If the provider doesn't have models yet, add a default model
		const hasProviderModels = models.some((model) => model.owned_by === provider);
		if (!hasProviderModels) {
			const defaultModel: HFModelItem = {
				id: `default-${provider}`,
				owned_by: provider,
				baseUrl: baseUrl,
				apiMode: (apiMode as "openai" | "ollama" | "anthropic") || "openai",
			};
			models.push(defaultModel);
		}

		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been added.`);
	}

	private async updateProvider(provider: string, baseUrl?: string, apiKey?: string, apiMode?: string) {
		// Update provider API key
		if (apiKey) {
			await this.secrets.store(`oaicopilot.apiKey.${provider}`, apiKey);
		} else {
			await this.secrets.delete(`oaicopilot.apiKey.${provider}`);
		}

		// Update the provider's configuration in the model list
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		const updatedModels = models.map((model) => {
			if (model.owned_by === provider) {
				return {
					...model,
					baseUrl: baseUrl || model.baseUrl,
					apiMode: (apiMode as "openai" | "ollama" | "anthropic") || model.apiMode,
				};
			}
			return model;
		});

		await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been updated.`);
	}

	private async deleteProvider(provider: string) {
		// Delete provider API key
		await this.secrets.delete(`oaicopilot.apiKey.${provider}`);

		// Remove all models of this provider from the model list
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);
		const filteredModels = models.filter((model) => model.owned_by !== provider);

		await config.update("oaicopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} and all its models have been deleted.`);
	}

	private async addModel(model: HFModelItem) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		// Check if model ID already exists
		const existingIndex = models.findIndex((m) => m.id === model.id);
		if (existingIndex !== -1) {
			vscode.window.showErrorMessage(`Model ${model.id} already exists.`);
			return;
		}

		models.push(model);
		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model ${model.id} has been added.`);
	}

	private async updateModel(model: HFModelItem) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		const updatedModels = models.map((m) => {
			if (m.id === model.id) {
				return model;
			}
			return m;
		});

		await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model ${model.id} has been updated.`);
	}

	private async deleteModel(modelId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);
		const filteredModels = models.filter((model) => model.id !== modelId);

		await config.update("oaicopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model ${modelId} has been deleted.`);
	}
}
