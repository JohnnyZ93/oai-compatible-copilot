import * as vscode from "vscode";
import type { HFApiMode, HFModelItem } from "../types";
import { normalizeUserModels, parseModelId } from "../utils";
import { fetchModels } from "../provideModel";

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
	commitModel: string;
	commitLanguage: string;
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
			commitModel: string;
			commitLanguage: string;
	  }
	| { type: "fetchModels"; baseUrl: string; apiKey: string }
	| { type: "addProvider"; provider: string; baseUrl?: string; apiKey?: string; apiMode?: string }
	| { type: "updateProvider"; provider: string; baseUrl?: string; apiKey?: string; apiMode?: string }
	| { type: "deleteProvider"; provider: string }
	| { type: "addModel"; model: HFModelItem }
	| { type: "updateModel"; model: HFModelItem; originalModelId?: string; originalConfigId?: string }
	| { type: "deleteModel"; modelId: string }
	| { type: "requestConfirm"; id: string; message: string; action: string };

type OutgoingMessage =
	| { type: "init"; payload: InitPayload }
	| { type: "modelsFetched"; models: HFModelItem[] }
	| { type: "confirmResponse"; id: string; confirmed: boolean };

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
			"OAICopilot Configuration",
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

		this.update();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (message) => {
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
				await this.saveGlobalConfig(message.baseUrl, message.apiKey, message.delay, message.retry, message.commitModel, message.commitLanguage);
				break;
			case "fetchModels": {
				const { models } = await fetchModels(message.baseUrl, message.apiKey);
				this.panel.webview.postMessage({ type: "modelsFetched", models });
				break;
			}
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
				await this.updateModel(message.model, message.originalModelId, message.originalConfigId);
				break;
			case "requestConfirm":
				await this.handleConfirmRequest(message.id, message.message, message.action);
				break;
			case "deleteModel":
				await this.deleteModel(message.modelId);
				break;
			default:
				break;
		}
	}

	private async handleConfirmRequest(id: string, message: string, action: string) {
		let confirmed: boolean | string | undefined;

		if (action === "showInfo") {
			// For informational messages, just show the message without confirmation
			await vscode.window.showInformationMessage(message);
			confirmed = true;
		} else {
			// For confirmation requests, show Yes/No dialog
			confirmed = await vscode.window.showInformationMessage(message, { modal: true }, "Yes", "No");
		}

		// Send response back to webview
		this.panel.webview.postMessage({
			type: "confirmResponse",
			id: id,
			confirmed: action === "showInfo" ? true : confirmed === "Yes",
		} as OutgoingMessage);
	}

	private async sendInit() {
		const config = vscode.workspace.getConfiguration();
		const baseUrl = config.get<string>("oaicopilot.baseUrl", "https://api.openai.com/v1");
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		const apiKey = (await this.secrets.get("oaicopilot.apiKey")) ?? "";
		const providerKeys: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const normalized = provider.toLowerCase();
			let key = await this.secrets.get(`oaicopilot.apiKey.${normalized}`);
			if (!key && normalized !== provider) {
				// Backward compat: previous versions stored provider keys with original casing.
				const legacy = await this.secrets.get(`oaicopilot.apiKey.${provider}`);
				if (legacy) {
					key = legacy;
					await this.secrets.store(`oaicopilot.apiKey.${normalized}`, legacy);
					await this.secrets.delete(`oaicopilot.apiKey.${provider}`);
				}
			}
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

		const foundModel = models.find((model) => model.useForCommitGeneration === true);
		const commitModel = foundModel ? `${foundModel.id}${foundModel.configId ? "::" + foundModel.configId : ""}` : "";
		const commitLanguage = config.get<string>("oaicopilot.commitLanguage", "English");
		const payload: InitPayload = { baseUrl, apiKey, delay, retry, commitModel, commitLanguage, models, providerKeys };
		this.panel.webview.postMessage({ type: "init", payload });
	}

	private async saveGlobalConfig(
		rawBaseUrl: string,
		rawApiKey: string,
		delay: number,
		retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] },
		commitModel: string,
		commitLanguage: string
	) {
		const baseUrl = rawBaseUrl.trim();
		const apiKey = rawApiKey.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.delay", delay, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.retry", retry, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.commitLanguage", commitLanguage, vscode.ConfigurationTarget.Global);
		if (apiKey) {
			await this.secrets.store("oaicopilot.apiKey", apiKey);
		} else {
			await this.secrets.delete("oaicopilot.apiKey");
		}

		// Update models to set useForCommitGeneration based on selected commitModel
		if (commitModel) {
			const models = config.get<HFModelItem[]>("oaicopilot.models", []);
			const updatedModels = models.map((model) => {
				const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
				if (fullModelId === commitModel) {
					return { ...model, useForCommitGeneration: true };
				} else {
					const { useForCommitGeneration: _useForCommitGeneration, ...rest } = model;
					return rest;
				}
			});
			await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		}

		vscode.window.showInformationMessage(
			"OAI Compatible base URL, Delay, Retry and API Key have been saved to global settings."
		);
		// Send refresh signal to frontend
		await this.sendInit();
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
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Save API key for the provider
		if (apiKey) {
			await this.secrets.store(`oaicopilot.apiKey.${normalizedProvider}`, apiKey);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
			}
		}

		// Save provider configuration to the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		// If the provider doesn't have models yet, add a default model
		const hasProviderModels = models.some((model) => model.owned_by === trimmedProvider);
		if (!hasProviderModels) {
			const defaultModel: HFModelItem = {
				id: `__provider__${trimmedProvider}`,
				owned_by: trimmedProvider,
				baseUrl: baseUrl,
				apiMode: (apiMode as HFApiMode) || "openai",
			};
			models.push(defaultModel);
		}

		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been added.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async updateProvider(provider: string, baseUrl?: string, apiKey?: string, apiMode?: string) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Update provider API key
		if (apiKey) {
			await this.secrets.store(`oaicopilot.apiKey.${normalizedProvider}`, apiKey);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
			}
		} else {
			await this.secrets.delete(`oaicopilot.apiKey.${normalizedProvider}`);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
			}
		}

		// Update the provider's configuration in the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		const updatedModels = models.map((model) => {
			if (model.owned_by === trimmedProvider) {
				return {
					...model,
					baseUrl: baseUrl || model.baseUrl,
					apiMode: (apiMode as HFApiMode) || model.apiMode,
				};
			}
			return model;
		});

		await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been updated.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async deleteProvider(provider: string) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Delete provider API key
		await this.secrets.delete(`oaicopilot.apiKey.${normalizedProvider}`);
		if (trimmedProvider !== normalizedProvider) {
			await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
		}

		// Remove all models of this provider from the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));
		const filteredModels = models.filter((model) => model.owned_by !== trimmedProvider);

		await config.update("oaicopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} and all its models have been deleted.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async addModel(model: HFModelItem) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		// Check if model with same id and configId already exists
		const existingIndex = models.findIndex(
			(m) =>
				m.id === model.id && ((model.configId && m.configId === model.configId) || (!model.configId && !m.configId))
		);
		if (existingIndex !== -1) {
			vscode.window.showErrorMessage(`Model ${model.id}${model.configId ? "::" + model.configId : ""} already exists.`);
			return;
		}

		models.push(model);
		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Model ${model.id}${model.configId ? "::" + model.configId : ""} has been added.`
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async updateModel(model: HFModelItem, originalModelId?: string, originalConfigId?: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		// Find the model to update based on original id and configId
		const updatedModels = models.map((m) => {
			// Check if this is the model we want to update
			// If originalConfigId is undefined (meaning it was originally null/undefined),
			// then look for a model with no configId
			const isTargetModel =
				m.id === originalModelId &&
				((originalConfigId && m.configId === originalConfigId) || (!originalConfigId && !m.configId));

			if (isTargetModel) {
				// Update with new values
				return model;
			}
			return m;
		});

		await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Model ${model.id}${model.configId ? "::" + model.configId : ""} has been updated.`
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async deleteModel(modelId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);
		const parsedModelId = parseModelId(modelId);

		const filteredModels = models.filter((model) => {
			return !(
				model.id === parsedModelId.baseId &&
				((parsedModelId.configId && model.configId === parsedModelId.configId) ||
					(!parsedModelId.configId && !model.configId))
			);
		});

		await config.update("oaicopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model ${modelId} has been deleted.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}
}
