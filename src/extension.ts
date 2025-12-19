import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";

export function activate(context: vscode.ExtensionContext) {
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension("johnny-zhao.oai-compatible-copilot");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `oai-compatible-copilot/${extVersion} VSCode/${vscodeVersion}`;

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	const provider = new HuggingFaceChatModelProvider(context.secrets, ua, tokenCountStatusBarItem);
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OAI Compatible Provider API Key",
				prompt: existing ? "Update your OAI Compatible API key" : "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage("OAI Compatible API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("OAI Compatible API key saved.");
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = config.get<HFModelItem[]>("oaicopilot.models", []);

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in oaicopilot.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `OAI Compatible API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);
}

export function deactivate() {}
