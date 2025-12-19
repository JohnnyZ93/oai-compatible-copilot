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
			temperature: temperature === "" ? null : Number(temperature),
			top_p: topP === "" ? null : Number(topP),
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
			return `
			<div class="model-card" data-model-row data-id="${model.id}">
				<div class="card-top">
					<input type="checkbox" class="checkbox" data-select />
					<div class="model-id">${model.id}</div>
					<div class="pill">
						<span>Provider</span>
						<input data-owned type="text" value="${model.owned_by || ""}" />
					</div>
				</div>
				<div class="card-inputs">
					<div class="field">
						<label>Context Length</label>
						<input data-context type="number" min="1" placeholder="可选" value="${model.context_length ?? ""}" />
					</div>
					<div class="field">
						<label>Max Tokens</label>
						<input data-max type="number" min="1" placeholder="可选" value="${model.max_tokens ?? ""}" />
					</div>
					<div class="field">
						<label>Temperature</label>
						<input data-temp type="number" step="0.01" min="0" max="2" placeholder="留空沿用默认" value="${model.temperature ?? ""}" />
					</div>
					<div class="field">
						<label>Top P</label>
						<input data-top-p type="number" step="0.01" min="0" max="1" placeholder="留空沿用默认" value="${model.top_p ?? ""}" />
					</div>
				</div>
			</div>`;
		})
		.join("");

	modelsContainer.innerHTML = `<div class="model-list">${rows}</div>`;
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
			return `
				<div class="provider-row" data-provider="${p}">
					<label style="width: 110px; font-weight: 600;">${p}</label>
					<input type="password" data-provider-key value="${val}" placeholder="可选：为该提供商单独配置 Key" />
					<button data-save-provider class="secondary" style="min-width:72px;">保存</button>
					<button data-clear-provider class="secondary" style="min-width:72px;">清除</button>
				</div>
			`;
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
