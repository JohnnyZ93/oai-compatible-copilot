import * as vscode from "vscode";
import type { HFModelItem, HFModelsResponse } from "../types";

interface InitPayload {
	baseUrl: string;
	apiKey: string;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
}

type IncomingMessage =
	| { type: "requestInit" }
	| { type: "saveBaseConfig"; baseUrl: string; apiKey: string }
	| { type: "fetchModels"; baseUrl: string; apiKey: string }
	| { type: "saveModels"; models: HFModelItem[] }
	| { type: "saveProviderKey"; provider: string; apiKey: string | null };

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
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, "out"),
					vscode.Uri.joinPath(extensionUri, "assets")
				],
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
					err instanceof Error ? err.message : `Unexpected error while handling configuration message[${message.type}].`
				);
			});
			},
			null,
			this.disposables
		);

		// 发送初始化数据
		this.sendInit(panel.webview);
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
			case "saveBaseConfig":
				await this.saveBaseConfig(message.baseUrl, message.apiKey);
				break;
			case "fetchModels": {
				const models = await this.fetchModelsFromApi(message.baseUrl, message.apiKey);
				this.postMessage({ type: "modelsFetched", models });
				break;
			}
			case "saveModels":
				await this.saveModels(message.models);
				break;
			case "saveProviderKey":
				await this.saveProviderKey(message.provider, message.apiKey);
				break;
			default:
				break;
		}
	}

	private async sendInit(webview?: vscode.Webview) {
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

		const payload: InitPayload = { baseUrl, apiKey, models, providerKeys };
		this.postMessage({ type: "init", payload }, webview);
	}

	private async saveBaseConfig(rawBaseUrl: string, rawApiKey: string) {
		const baseUrl = rawBaseUrl.trim();
		const apiKey = rawApiKey.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
		if (apiKey) {
			await this.secrets.store("oaicopilot.apiKey", apiKey);
		} else {
			await this.secrets.delete("oaicopilot.apiKey");
		}
		vscode.window.showInformationMessage("OAI Compatible base URL 和主 API Key 已保存到全局设置。");
	}

	private async saveModels(models: HFModelItem[]) {
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage("模型配置已保存到全局设置。");
	}

	private async saveProviderKey(provider: string, apiKey: string | null) {
		const keyId = `oaicopilot.apiKey.${provider}`;
		if (apiKey && apiKey.trim()) {
			await this.secrets.store(keyId, apiKey.trim());
			vscode.window.showInformationMessage(`已保存 ${provider} 的 API Key。`);
		} else {
			await this.secrets.delete(keyId);
			vscode.window.showInformationMessage(`已清除 ${provider} 的 API Key。`);
		}
	}

	private async fetchModelsFromApi(rawBaseUrl: string, apiKey: string): Promise<HFModelItem[]> {
		const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
		if (!baseUrl) {
			throw new Error("请先填写 Base URL。");
		}
		if (!apiKey.trim()) {
			throw new Error("请先填写 API Key。");
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
			throw new Error(`获取模型列表失败（${res.status}）：${text || "未知错误"}`);
		}

		const json = (await res.json()) as HFModelsResponse | { data?: unknown };
		if (!json || !Array.isArray((json as HFModelsResponse).data)) {
			throw new Error("模型列表响应格式不符合 OpenAI /models 规范。");
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

	private postMessage(message: unknown, webview?: vscode.Webview) {
		const targetWebview = webview || this.panel?.webview;
		if (targetWebview) {
			targetWebview.postMessage(message);
		}
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
}
