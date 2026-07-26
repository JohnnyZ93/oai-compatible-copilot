import * as path from "path";
import * as vscode from "vscode";
import { getGitDiff } from "./gitUtils";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { OllamaApi } from "../ollama/ollamaApi";
import { normalizeUserModels } from "../utils";
import { logger } from "../logger";
import type { HFModelItem } from "../types";
import { I18N } from "../i18n";

/**
 * Git commit message generator module
 */

let commitGenerationAbortController: AbortController | undefined;

const DEFAULT_PROMPT: { system: () => string; user: () => string } = {
	system: () =>
		I18N.defaultCommitSystemPrompt(),
	user: () => I18N.defaultCommitUserPrompt(),
};

export async function generateCommitMsg(secrets: vscode.SecretStorage, scm?: vscode.SourceControl) {
	try {
		const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
		if (!gitExtension) {
			throw new Error(I18N.gitExtensionNotFound());
		}

		const git = gitExtension.getAPI(1);
		if (git.repositories.length === 0) {
			throw new Error(I18N.noGitRepos());
		}

		// If scm is provided, then the user specified one repository by clicking the "Source Control" menu button
		if (scm) {
			const repository = git.getRepository(scm.rootUri);

			if (!repository) {
				throw new Error(I18N.repoNotFoundForScm());
			}

			await generateCommitMsgForRepository(secrets, repository);
			return;
		}

		await orchestrateWorkspaceCommitMsgGeneration(secrets, git.repositories);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(I18N.commitGenFailed(errorMessage));
	}
}

async function orchestrateWorkspaceCommitMsgGeneration(secrets: vscode.SecretStorage, repos: any[]) {
	const reposWithChanges = await filterForReposWithChanges(repos);

	if (reposWithChanges.length === 0) {
		vscode.window.showInformationMessage(I18N.noChangesFound());
		return;
	}

	if (reposWithChanges.length === 1) {
		// Only one repo with changes, generate for it
		const repo = reposWithChanges[0];
		await generateCommitMsgForRepository(secrets, repo);
		return;
	}

	const selection = await promptRepoSelection(reposWithChanges);

	if (!selection) {
		// User cancelled
		return;
	}

	if (selection.repo === null) {
		// Generate for all repositories with changes
		for (const repo of reposWithChanges) {
			try {
				await generateCommitMsgForRepository(secrets, repo);
			} catch (error) {
				console.error(`Failed to generate commit message for ${repo.rootUri.fsPath}:`, error);
			}
		}
	} else {
		// Generate for selected repository
		await generateCommitMsgForRepository(secrets, selection.repo);
	}
}

async function filterForReposWithChanges(repos: any[]) {
	const reposWithChanges = [];

	// Check which repositories have changes
	for (const repo of repos) {
		try {
			const gitDiff = await getGitDiff(repo.rootUri.fsPath);
			if (gitDiff) {
				reposWithChanges.push(repo);
			}
		} catch (error) {
			// Skip repositories with errors (no changes, etc.)
		}
	}
	return reposWithChanges;
}

async function promptRepoSelection(repos: any[]) {
	// Multiple repos with changes - ask user to choose
	const repoItems = repos.map((repo) => ({
		label: repo.rootUri.fsPath.split(path.sep).pop() || repo.rootUri.fsPath,
		description: repo.rootUri.fsPath,
		repo: repo,
	}));

	repoItems.unshift({
		label: "$(git-commit) Generate for all repositories with changes",
		description: `Generate commit messages for ${repos.length} repositories`,
		repo: null as any,
	});

	return await vscode.window.showQuickPick(repoItems, {
		placeHolder: I18N.selectRepository(),
	});
}

async function generateCommitMsgForRepository(secrets: vscode.SecretStorage, repository: any) {
	const inputBox = repository.inputBox;
	const repoPath = repository.rootUri.fsPath;
	const gitDiff = await getGitDiff(repoPath);

	if (!gitDiff) {
		const repoName = repoPath.split(path.sep).pop() || "repository";
		throw new Error(I18N.noChangesInRepo(repoName));
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
				title: I18N.generatingCommitMsg(repoPath.split(path.sep).pop() || "repository"),
			cancellable: true,
		},
		() => performCommitMsgGeneration(secrets, gitDiff, inputBox)
	);
}

async function performCommitMsgGeneration(secrets: vscode.SecretStorage, gitDiff: string, inputBox: any) {
	const startTime = Date.now();
	let modelId: string | undefined;
	try {
		vscode.commands.executeCommand("setContext", "oaicopilot.isGeneratingCommit", true);
		const config = vscode.workspace.getConfiguration();

		// Get custom prompts or use defaults
		const customSystemPrompt = config.get<string>("oaicopilot.commitMessagePrompt", "");
		const PROMPT = {
			system: customSystemPrompt || DEFAULT_PROMPT.system(),
			user: DEFAULT_PROMPT.user(),
		};

		const prompts: string[] = [];

		const currentInput = inputBox.value?.trim() || "";
		if (currentInput) {
			prompts.push(PROMPT.user.replace("{{USER_CURRENT_INPUT}}", currentInput));
		}

		const truncatedDiff =
			gitDiff.length > 5000 ? gitDiff.substring(0, 5000) + I18N.diffTruncated() : gitDiff;
		prompts.push(truncatedDiff);
		const prompt = prompts.join("\n\n");

		// Get user models from configuration
		const userModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		// Filter models that are marked for commit generation
		const commitModels = userModels.filter((model: HFModelItem) => model.useForCommitGeneration === true);

		if (commitModels.length === 0) {
			throw new Error(I18N.noCommitModels());
		}

		// Use the first model marked for commit generation
		const selectedModel = commitModels[0];
		modelId = selectedModel.id;
		logger.info("commit.start", { modelId });

		// Get API key for the model's provider
		const apiKey = await ensureApiKey(secrets, selectedModel.owned_by);
		if (!apiKey) {
			throw new Error(I18N.apiKeyNotFound());
		}

		// Get base URL for the model
		const baseUrl = selectedModel.baseUrl || config.get<string>("oaicopilot.baseUrl", "");
		if (!baseUrl || !baseUrl.startsWith("http")) {
			throw new Error(I18N.invalidBaseUrl());
		}

		// Get commit language configuration
		const commitLanguage = config.get<string>("oaicopilot.commitLanguage", "English");

		// Create a system prompt with language instruction
		const systemPrompt = PROMPT.system + ` Generate commit message in ${commitLanguage}.`;

		// Create a message for the API
		const messages = [{ role: "user", content: prompt }];

		// Create API instance based on model's API mode
		let apiInstance;
		const apiMode = selectedModel.apiMode ?? "openai";

		if (apiMode === "anthropic") {
			apiInstance = new AnthropicApi(modelId);
		} else if (apiMode === "ollama") {
			apiInstance = new OllamaApi(modelId);
		} else if (apiMode === "openai-responses") {
			apiInstance = new OpenaiResponsesApi(modelId);
		} else {
			// Default to OpenAI-compatible API
			apiInstance = new OpenaiApi(modelId);
		}

		commitGenerationAbortController = new AbortController();
		const stream = apiInstance.createMessage(selectedModel, systemPrompt, messages, baseUrl, apiKey);

		let response = "";
		for await (const chunk of stream) {
			commitGenerationAbortController.signal.throwIfAborted();
			if (chunk.type === "text") {
				response += chunk.text;
				inputBox.value = extractCommitMessage(response);
			}
		}

		inputBox.value = removeThinkTags(inputBox.value);

		if (!inputBox.value) {
			throw new Error(I18N.emptyApiResponse());
		}

		logger.info("commit.end", { modelId, durationMs: Date.now() - startTime });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("commit.error", { modelId: modelId ?? "unknown", error: errorMessage });
		vscode.window.showErrorMessage(I18N.commitGenFailed(errorMessage));
	} finally {
		vscode.commands.executeCommand("setContext", "oaicopilot.isGeneratingCommit", false);
	}
}

export function abortCommitGeneration() {
	commitGenerationAbortController?.abort();
	vscode.commands.executeCommand("setContext", "oaicopilot.isGeneratingCommit", false);
}

/**
 * Extracts the commit message from the AI response
 * @param str String containing the AI response
 * @returns The extracted commit message
 */
function extractCommitMessage(str: string): string {
	// Remove any markdown formatting or extra text
	return str
		.trim()
		.replace(/^```[^\n]*\n?|```$/g, "")
		.trim();
}

function removeThinkTags(text: string): string {
	const regex = /<think>.*?<\/think>/gs;
	return text.replace(regex, "").trim();
}

/**
 * Ensure an API key exists in SecretStorage
 * @param provider provider name to get provider-specific API key.
 */
async function ensureApiKey(secrets: vscode.SecretStorage, provider: string): Promise<string | undefined> {
	let apiKey: string | undefined;
	if (provider && provider.trim() !== "") {
		const normalizedProvider = provider.trim().toLowerCase();
		const providerKey = `oaicopilot.apiKey.${normalizedProvider}`;
		apiKey = await secrets.get(providerKey);
	}

	// Fall back to generic API key
	if (!apiKey) {
		apiKey = await secrets.get("oaicopilot.apiKey");
	}

	return apiKey;
}
