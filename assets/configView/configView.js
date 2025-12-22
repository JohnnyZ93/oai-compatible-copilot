const vscode = acquireVsCodeApi();
const state = {
	baseUrl: "",
	apiKey: "",
	delay: 0,
	retry: { enabled: true, max_attempts: 3, interval_ms: 1000, status_codes: [429, 500, 502, 503, 504] },
	models: [],
	providerKeys: {},
};

// Store the action to be performed after confirmation
const pendingConfirmations = new Map();

// Global Configuration elements
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const delayInput = document.getElementById("delay");
const retryEnabledInput = document.getElementById("retryEnabled");
const maxAttemptsInput = document.getElementById("maxAttempts");
const intervalMsInput = document.getElementById("intervalMs");
const statusCodesInput = document.getElementById("statusCodes");

// Provider management elements
const providerTableBody = document.getElementById("providerTableBody");

// Model management elements
const modelTableBody = document.getElementById("modelTableBody");

// Global Configuration save button event listener
document.getElementById("saveBase").addEventListener("click", () => {
	const retry = {
		enabled: retryEnabledInput.checked,
		max_attempts: parseInt(maxAttemptsInput.value) || 3,
		interval_ms: parseInt(intervalMsInput.value) || 1000,
		status_codes: statusCodesInput.value
			? statusCodesInput.value
					.split(",")
					.map((s) => parseInt(s.trim()))
					.filter((n) => !isNaN(n))
			: [429, 500, 502, 503, 504],
	};

	vscode.postMessage({
		type: "saveGlobalConfig",
		baseUrl: baseUrlInput.value,
		apiKey: apiKeyInput.value,
		delay: parseInt(delayInput.value) || 0,
		retry: retry,
	});
});

// Refresh buttons event listeners
document.getElementById("refreshGlobalConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "requestInit" });
});

document.getElementById("refreshProviders").addEventListener("click", () => {
	vscode.postMessage({ type: "requestInit" });
});

document.getElementById("refreshModels").addEventListener("click", () => {
	vscode.postMessage({ type: "requestInit" });
});

// Add Provider button event listener
document.getElementById("addProvider").addEventListener("click", () => {
	// Add new provider row to the table
	const newRow = document.createElement("tr");
	newRow.innerHTML = `
		<td><input type="text" class="provider-input" data-field="provider" placeholder="Provider ID" /></td>
		<td><input type="text" class="provider-input" data-field="baseUrl" placeholder="Base URL" /></td>
		<td><input type="password" class="provider-input" data-field="apiKey" placeholder="API Key" /></td>
		<td>
			<select class="provider-input" data-field="apiMode">
				<option value="openai">OpenAI</option>
				<option value="ollama">Ollama</option>
				<option value="anthropic">Anthropic</option>
			</select>
		</td>
		<td>
			<button class="save-provider-btn secondary">Save</button>
			<button class="cancel-provider-btn secondary">Cancel</button>
		</td>
	`;
	providerTableBody.appendChild(newRow);

	// Add event listeners for the new row
	const saveBtn = newRow.querySelector(".save-provider-btn");
	const cancelBtn = newRow.querySelector(".cancel-provider-btn");

	saveBtn.addEventListener("click", () => {
		const inputs = newRow.querySelectorAll(".provider-input");
		const providerData = {};
		inputs.forEach((input) => {
			const field = input.getAttribute("data-field");
			providerData[field] = input.value;
		});

		vscode.postMessage({
			type: "addProvider",
			provider: providerData.provider,
			baseUrl: providerData.baseUrl || undefined,
			apiKey: providerData.apiKey || undefined,
			apiMode: providerData.apiMode || undefined,
		});

		newRow.remove();
	});

	cancelBtn.addEventListener("click", () => {
		newRow.remove();
	});
});

// Add Model button event listeners
document.getElementById("addModel").addEventListener("click", () => {
	// Navigate to the new model page, temporarily show a prompt
	alert("Navigate to new model page");
});

window.addEventListener("message", (event) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			const { baseUrl, apiKey, delay, retry, models, providerKeys } = message.payload;
			state.baseUrl = baseUrl;
			state.apiKey = apiKey;
			state.delay = delay || 0;
			state.retry = retry || {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
				status_codes: [429, 500, 502, 503, 504],
			};
			state.models = models || [];
			state.providerKeys = providerKeys || {};

			// Update base configuration
			baseUrlInput.value = baseUrl || "";
			apiKeyInput.value = apiKey || "";
			delayInput.value = state.delay;
			retryEnabledInput.checked = state.retry.enabled !== false;
			maxAttemptsInput.value = state.retry.max_attempts || 3;
			intervalMsInput.value = state.retry.interval_ms || 1000;
			statusCodesInput.value = state.retry.status_codes ? state.retry.status_codes.join(",") : "429,500,502,503,504";

			// Render provider and model management
			renderProviders();
			renderModels();
			break;
		case "modelsFetched":
			state.models = message.models || [];
			renderProviders();
			renderModels();
			break;
		case "confirmResponse":
			// Handle confirmation responses
			const pendingAction = pendingConfirmations.get(message.id);
			if (pendingAction && message.confirmed) {
				if (pendingAction.action) {
					pendingAction.action();
				}
				// Clean up the pending confirmation
				pendingConfirmations.delete(message.id);
			} else if (pendingAction) {
				// Clean up the pending confirmation even if not confirmed
				pendingConfirmations.delete(message.id);
			}
			break;
	}
});

function renderProviders() {
	// Get all unique providers
	const providers = Array.from(new Set(state.models.map((m) => m.owned_by).filter(Boolean)));

	if (!providers.length) {
		providerTableBody.innerHTML = '<tr><td colspan="5" class="no-data">No providers</td></tr>';
		return;
	}

	const rows = providers
		.map((provider) => {
			// Get the provider's configuration information
			const providerModels = state.models.filter((m) => m.owned_by === provider);
			const firstModel = providerModels[0];

			return `
			<tr data-provider="${provider}">
				<td>${provider}</td>
				<td><input type="text" class="provider-input" data-field="baseUrl" value="${firstModel.baseUrl || ""}" placeholder="Base URL" /></td>
				<td><input type="password" class="provider-input" data-field="apiKey" value="${state.providerKeys[provider] || ""}" placeholder="API Key" /></td>
				<td>
					<select class="provider-input" data-field="apiMode">
						<option value="openai" ${firstModel.apiMode === "openai" ? "selected" : ""}>OpenAI</option>
						<option value="ollama" ${firstModel.apiMode === "ollama" ? "selected" : ""}>Ollama</option>
						<option value="anthropic" ${firstModel.apiMode === "anthropic" ? "selected" : ""}>Anthropic</option>
					</select>
				</td>
				<td>
					<button class="update-provider-btn" data-provider="${provider}">Save</button>
					<button class="delete-provider-btn danger" data-provider="${provider}">Delete</button>
				</td>
			</tr>`;
		})
		.join("");

	providerTableBody.innerHTML = rows;

	// Add event listeners for provider rows
	document.querySelectorAll(".update-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const provider = event.target.getAttribute("data-provider");
			const row = event.target.closest("tr");
			const inputs = row.querySelectorAll(".provider-input");
			const providerData = {};
			inputs.forEach((input) => {
				const field = input.getAttribute("data-field");
				providerData[field] = input.value;
			});

			vscode.postMessage({
				type: "updateProvider",
				provider: provider,
				baseUrl: providerData.baseUrl || undefined,
				apiKey: providerData.apiKey || undefined,
				apiMode: providerData.apiMode || undefined,
			});
		});
	});

	document.querySelectorAll(".delete-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			console.log("Delete provider clicked", event);
			const provider = event.target.getAttribute("data-provider");
			const confirmId = "deleteProvider_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteProvider", provider: provider }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Are you sure you want to delete provider ${provider} and all its models?`,
				action: "deleteProvider",
			});
		});
	});
}

function renderModels() {
	if (!state.models.length) {
		modelTableBody.innerHTML = '<tr><td colspan="11" class="no-data">No models</td></tr>';
		return;
	}

	const rows = state.models
		.map((model) => {
			return `
			<tr data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">
				<td>${model.id}</td>
				<td>${model.owned_by}</td>
				<td>${model.displayName || ""}</td>
				<td>${model.configId || ""}</td>
				<td>${model.context_length || ""}</td>
				<td>${model.max_tokens || model.max_completion_tokens || ""}</td>
				<td>${model.vision ? "True" : ""}</td>
				<td>${model.temperature !== undefined && model.temperature !== null ? model.temperature : ""}</td>
				<td>${model.top_p !== undefined && model.top_p !== null ? model.top_p : ""}</td>
				<td>${model.delay || ""}</td>
				<td class="action-buttons">
					<button class="update-model-btn" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">Edit</button>
					<button class="delete-model-btn danger" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">Delete</button>
				</td>
			</tr>`;
		})
		.join("");

	modelTableBody.innerHTML = rows;

	// Add event listeners for model rows
	document.querySelectorAll(".update-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			// Navigate to the edit model page
			alert(`Navigate to edit model page: ${modelId}`);
		});
	});

	document.querySelectorAll(".delete-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const confirmId = "deleteModel_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteModel", modelId: modelId }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Are you sure you want to delete model ${modelId}?`,
				action: "deleteModel",
			});
		});
	});
}

vscode.postMessage({ type: "requestInit" });
