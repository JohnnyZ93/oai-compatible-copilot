import * as vscode from "vscode";
import type { HFModelItem, HFModelsResponse } from "./types";

const VIEW_ID = "oaicopilot.configView";

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

export class ConfigViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly userAgent: string
	) {}

	register() {
		return vscode.window.registerWebviewViewProvider(VIEW_ID, this, {
			webviewOptions: { retainContextWhenHidden: true },
		});
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage((msg: IncomingMessage) => {
			this.handleMessage(msg).catch((err) => {
				console.error("[oaicopilot] handleMessage failed", err);
				vscode.window.showErrorMessage(
					err instanceof Error ? err.message : "Unexpected error while handling configuration message."
				);
			});
		});
		void this.sendInit();
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

	private async sendInit() {
		const config = vscode.workspace.getConfiguration();
		const baseUrl = config.get<string>("oaicopilot.baseUrl", "https://api.openai.com/v1");
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		const apiKey = (await this.context.secrets.get("oaicopilot.apiKey")) ?? "";
		const providerKeys: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const key = await this.context.secrets.get(`oaicopilot.apiKey.${provider}`);
			if (key) {
				providerKeys[provider] = key;
			}
		}

		const payload: InitPayload = { baseUrl, apiKey, models, providerKeys };
		this.postMessage({ type: "init", payload });
	}

	private async saveBaseConfig(rawBaseUrl: string, rawApiKey: string) {
		const baseUrl = rawBaseUrl.trim();
		const apiKey = rawApiKey.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
		if (apiKey) {
			await this.context.secrets.store("oaicopilot.apiKey", apiKey);
		} else {
			await this.context.secrets.delete("oaicopilot.apiKey");
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
			await this.context.secrets.store(keyId, apiKey.trim());
			vscode.window.showInformationMessage(`已保存 ${provider} 的 API Key。`);
		} else {
			await this.context.secrets.delete(keyId);
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
			"User-Agent": this.userAgent,
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

	private postMessage(message: unknown) {
		if (this.view?.webview) {
			this.view.webview.postMessage(message);
		}
	}

	private getHtml(webview: vscode.Webview) {
		const nonce = this.getNonce();
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");

		return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>OAICopilot 配置</title>
	<style>
		body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(0,0,0,0.04) 100%); }
		h2 { margin-top: 12px; margin-bottom: 8px; }
		section { border: 1px solid var(--vscode-editorWidget-border); padding: 12px; border-radius: 12px; margin-bottom: 16px; background: var(--vscode-sideBar-background); box-shadow: 0 8px 18px rgba(0,0,0,0.08); }
		label { display: block; font-weight: 600; margin-bottom: 6px; letter-spacing: 0.1px; }
		input[type="text"], input[type="password"], input[type="number"] {
			width: 100%;
			padding: 10px 12px;
			box-sizing: border-box;
			margin-bottom: 10px;
			border-radius: 8px;
			border: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
		}
		input:focus { outline: 2px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
		button {
			margin-right: 8px;
			padding: 8px 12px;
			border-radius: 8px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
			transition: transform 0.05s ease, box-shadow 0.05s ease;
		}
		button.secondary { background: transparent; border-color: var(--vscode-editorWidget-border); color: var(--vscode-foreground); }
		button.danger { background: #b91c1c; color: #fff; border: none; }
		button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
		button:active { transform: translateY(0); box-shadow: none; }
		.muted { color: var(--vscode-descriptionForeground); }
		.row { display: flex; gap: 10px; align-items: center; }
		.row input { flex: 1; margin-bottom: 0; }
		.checkbox { width: 16px; height: 16px; accent-color: var(--vscode-button-background); }
		.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
		.block-gap { margin-top: 10px; }
		.provider-row { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
		.provider-row label { margin: 0; }
		.model-list { display: flex; flex-direction: column; gap: 10px; }
		.model-card {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-editorWidget-border);
			border-radius: 12px;
			padding: 10px;
			box-shadow: 0 6px 14px rgba(0,0,0,0.08);
		}
		.card-top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
		.model-id { font-weight: 700; line-height: 1.3; }
		.pill {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 2px 10px;
			border-radius: 10px;
			border: 1px solid var(--vscode-editorWidget-border);
			background: rgba(255,255,255,0.03);
		}
		.pill label { margin: 0; font-weight: 600; color: var(--vscode-descriptionForeground); }
		.pill input {
			width: 130px;
			margin: 0;
			padding: 4px 8px;
			border-radius: 6px;
			border: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-editor-background);
		}
		.card-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
		.card-inputs label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
		.card-inputs .field { display: flex; flex-direction: column; gap: 4px; }
		.models-container { margin-top: 12px; }
	</style>
</head>
<body>
	<section>
		<h2>基础配置</h2>
		<label for="baseUrl">Base URL</label>
		<input id="baseUrl" type="text" placeholder="https://api.openai.com/v1" />
		<label for="apiKey">主 API Key</label>
		<div class="row">
			<input id="apiKey" type="password" placeholder="sk-..." />
			<button id="toggleMainKey" class="secondary">显示</button>
		</div>
		<div class="block-gap">
			<button id="saveBase">保存基础配置</button>
		</div>
	</section>

	<section>
		<h2>模型管理</h2>
		<p class="muted">点击“拉取模型”将调用 Base URL 的 /models 接口，可批量选择后删除。</p>
		<div class="actions">
			<button id="fetchModels">拉取模型</button>
			<button id="saveModels" class="secondary">保存模型</button>
			<button id="deleteModels" class="danger">删除选中模型</button>
			<button id="selectAllModels" class="secondary">全选/全不选</button>
		</div>
		<div id="modelsContainer" class="models-container"></div>
	</section>

	<section>
		<h2>按提供商配置 API Key</h2>
		<div id="providerKeys"></div>
	</section>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = { baseUrl: "", apiKey: "", models: [], providerKeys: {} };

		const baseUrlInput = document.getElementById("baseUrl");
		const apiKeyInput = document.getElementById("apiKey");
		const toggleMainKeyBtn = document.getElementById("toggleMainKey");
		const modelsContainer = document.getElementById("modelsContainer");
		const providerKeysContainer = document.getElementById("providerKeys");
		const deleteModelsBtn = document.getElementById("deleteModels");
		const selectAllModelsBtn = document.getElementById("selectAllModels");

		document.getElementById("saveBase").addEventListener("click", () => {
			vscode.postMessage({ type: "saveBaseConfig", baseUrl: baseUrlInput.value, apiKey: apiKeyInput.value });
		});

		document.getElementById("fetchModels").addEventListener("click", () => {
			vscode.postMessage({ type: "fetchModels", baseUrl: baseUrlInput.value, apiKey: apiKeyInput.value });
		});

		document.getElementById("saveModels").addEventListener("click", () => {
			const rows = Array.from(document.querySelectorAll("[data-model-row]"));
			const models = rows.map((row) => {
				const id = row.getAttribute("data-id");
				const ownedBy = row.querySelector("[data-owned]").value;
				const ctx = row.querySelector("[data-context]").value;
				const maxTokens = row.querySelector("[data-max]").value;
				const temperature = row.querySelector("[data-temp]").value;
				const topP = row.querySelector("[data-top-p]").value;
				return {
					id,
					owned_by: ownedBy,
					context_length: ctx ? Number(ctx) : undefined,
					max_tokens: maxTokens ? Number(maxTokens) : undefined,
					temperature: temperature === \"\" ? null : Number(temperature),
					top_p: topP === \"\" ? null : Number(topP),
				};
			});
			vscode.postMessage({ type: "saveModels", models });
		});

		deleteModelsBtn?.addEventListener("click", () => {
			const rows = Array.from(document.querySelectorAll("[data-model-row]"));
			if (!rows.length) {
				return;
			}
			const remaining = rows
				.filter((row) => {
					const checked = row.querySelector("[data-select]")?.checked;
					return !checked;
				})
				.map((row) => {
					const id = row.getAttribute("data-id");
					const ownedBy = row.querySelector("[data-owned]").value;
					const ctx = row.querySelector("[data-context]").value;
					const maxTokens = row.querySelector("[data-max]").value;
					const temperature = row.querySelector("[data-temp]").value;
					const topP = row.querySelector("[data-top-p]").value;
					return {
						id,
						owned_by: ownedBy,
						context_length: ctx ? Number(ctx) : 256000,
						max_tokens: maxTokens ? Number(maxTokens) : 8192,
						temperature: temperature === "" ? 0 : Number(temperature),
						top_p: topP === "" ? 1 : Number(topP),
					};
				});
			state.models = remaining;
			renderModels();
			renderProviderKeys();
		});

		selectAllModelsBtn?.addEventListener("click", () => {
			const boxes = Array.from(document.querySelectorAll("[data-select]"));
			if (!boxes.length) {
				return;
			}
			const allChecked = boxes.every((b) => b.checked);
			boxes.forEach((b) => (b.checked = !allChecked));
		});

		toggleMainKeyBtn.addEventListener("click", () => {
			const type = apiKeyInput.getAttribute("type") === "password" ? "text" : "password";
			apiKeyInput.setAttribute("type", type);
			toggleMainKeyBtn.textContent = type === "password" ? "显示" : "隐藏";
		});

		window.addEventListener("message", (event) => {
			const message = event.data;
			if (message.type === "init") {
				const { baseUrl, apiKey, models, providerKeys } = message.payload;
				state.baseUrl = baseUrl;
				state.apiKey = apiKey;
				state.models = models || [];
				state.providerKeys = providerKeys || {};
				baseUrlInput.value = baseUrl || "";
				apiKeyInput.value = apiKey || "";
				renderModels();
				renderProviderKeys();
			}
			if (message.type === "modelsFetched") {
				state.models = message.models || [];
				renderModels();
				renderProviderKeys();
			}
		});

		function renderModels() {
			if (!state.models.length) {
				modelsContainer.innerHTML = '<p class="muted">暂无模型。点击“拉取模型”获取。</p>';
				return;
			}
			const rows = state.models
				.map((model) => {
					return \`
					<div class="model-card" data-model-row data-id=\"\${model.id}\">
						<div class="card-top">
							<input type=\"checkbox\" class=\"checkbox\" data-select />
							<div class=\"model-id\">\${model.id}</div>
							<div class=\"pill\">
								<span>Provider</span>
								<input data-owned type=\"text\" value=\"\${model.owned_by || \"\"}\" />
							</div>
						</div>
						<div class="card-inputs">
							<div class="field">
								<label>Context Length</label>
								<input data-context type=\"number\" min=\"1\" placeholder=\"可选\" value=\"\${model.context_length ?? \"\"}\" />
							</div>
							<div class="field">
								<label>Max Tokens</label>
								<input data-max type=\"number\" min=\"1\" placeholder=\"可选\" value=\"\${model.max_tokens ?? \"\"}\" />
							</div>
							<div class="field">
								<label>Temperature</label>
								<input data-temp type=\"number\" step=\"0.01\" min=\"0\" max=\"2\" placeholder=\"留空沿用默认\" value=\"\${model.temperature ?? \"\"}\" />
							</div>
							<div class="field">
								<label>Top P</label>
								<input data-top-p type=\"number\" step=\"0.01\" min=\"0\" max=\"1\" placeholder=\"留空沿用默认\" value=\"\${model.top_p ?? \"\"}\" />
							</div>
						</div>
					</div>\`;
				})
				.join("");

			modelsContainer.innerHTML = \`<div class="model-list">\${rows}</div>\`;
		}

		function renderProviderKeys() {
			const providers = Array.from(new Set(state.models.map((m) => m.owned_by).filter(Boolean)));
			if (!providers.length) {
				providerKeysContainer.innerHTML = '<p class="muted">暂无可配置的提供商。保存模型后会显示。</p>';
				return;
			}
			providerKeysContainer.innerHTML = providers
				.map((p) => {
					const val = state.providerKeys[p] || "";
					return \`
						<div class="provider-row" data-provider="\${p}">
							<label style="width: 110px; font-weight: 600;">\${p}</label>
							<input type="password" data-provider-key value="\${val}" placeholder="可选：为该提供商单独配置 Key" />
							<button data-save-provider class="secondary" style="min-width:72px;">保存</button>
							<button data-clear-provider class="secondary" style="min-width:72px;">清除</button>
						</div>
					\`;
				})
				.join("");

			providerKeysContainer.querySelectorAll("[data-save-provider]").forEach((btn) => {
				btn.addEventListener("click", (event) => {
					const row = event.target.closest("[data-provider]");
					const provider = row.getAttribute("data-provider");
					const val = row.querySelector("[data-provider-key]").value;
					vscode.postMessage({ type: "saveProviderKey", provider, apiKey: val });
					state.providerKeys[provider] = val;
				});
			});
			providerKeysContainer.querySelectorAll("[data-clear-provider]").forEach((btn) => {
				btn.addEventListener("click", (event) => {
					const row = event.target.closest("[data-provider]");
					const provider = row.getAttribute("data-provider");
					row.querySelector("[data-provider-key]").value = "";
					vscode.postMessage({ type: "saveProviderKey", provider, apiKey: null });
					state.providerKeys[provider] = "";
				});
			});
		}

		vscode.postMessage({ type: "requestInit" });
	</script>
</body>
</html>`;
	}

	private getNonce() {
		return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
	}
}
