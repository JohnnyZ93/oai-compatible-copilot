import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { I18N, t } from "./i18n";
import { TokenUsageTracker } from "./tokenUsage/tokenUsageTracker";
import { TokenUsageView } from "./tokenUsage/tokenUsageView";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	// Initialize token usage tracker
	const tokenUsageTracker = new TokenUsageTracker(context.globalState);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context, tokenUsageTracker);
	const provider = new HuggingFaceChatModelProvider(context.secrets, tokenCountStatusBarItem, tokenUsageTracker);
	context.subscriptions.push(provider);
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: t("OAI Compatible Provider API Key", "OAI Compatible 提供商 API 密钥"),
				prompt: existing ? I18N.updateApiKey() : I18N.enterApiKey(),
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage(I18N.apiKeyCleared());
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage(I18N.apiKeySaved());
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(I18N.noProvidersFound());
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: I18N.selectProvider(),
				placeHolder: I18N.selectProviderPlaceholder(),
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: t(`OAI Compatible API Key for ${selectedProvider}`, `${selectedProvider} 的 OAI Compatible API 密钥`),
				prompt: existing ? I18N.updateApiKey(selectedProvider) : I18N.enterApiKey(selectedProvider),
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(I18N.apiKeyForProviderCleared(selectedProvider));
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(I18N.apiKeyForProvider(selectedProvider));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.generateGitCommitMessage", async (scm) => {
			await generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("oaicopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("oaicopilot.logLevel")) {
				logger.reloadConfig();
			}
		})
	);

	// Token usage statistics commands
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.showTokenUsage", async () => {
			TokenUsageView.openPanel(context.extensionUri, tokenUsageTracker);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.resetTokenUsage", async () => {
			const answer = await vscode.window.showWarningMessage(
				I18N.tokenUsageResetConfirm(),
				I18N.yes(),
				I18N.no()
			);
			if (answer === I18N.yes()) {
				tokenUsageTracker.reset();
				vscode.window.showInformationMessage(I18N.tokenUsageResetDone());
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.exportTokenUsage", async () => {
			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file("oaicopilot-token-usage.json"),
				filters: { JSON: ["json"] },
			});
			if (uri) {
				const data = tokenUsageTracker.exportData();
				await vscode.workspace.fs.writeFile(uri, Buffer.from(data, "utf-8"));
				vscode.window.showInformationMessage(I18N.tokenUsageExported(uri.fsPath));
			}
		})
	);
}

export function deactivate() {}
