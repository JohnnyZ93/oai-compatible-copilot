import * as path from "path";
import * as vscode from "vscode";
import { getGitDiff } from "./gitUtils";
import { OpenaiApi } from "../openai/openaiApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { normalizeUserModels } from "../utils";
import type { HFModelItem } from "../types";

/**
 * Git commit message generator module
 */

let commitGenerationAbortController: AbortController | undefined;

const PROMPT = {
	system:
		"You are a helpful assistant that generates informative git commit messages based on git diffs output. Skip preamble and remove all backticks surrounding the commit message.",
	user: "Notes from developer (ignore if not relevant): {{USER_CURRENT_INPUT}}",
	instruction: `Based on the provided git diff, generate a concise and descriptive commit message.

The commit message should:
1. Has a short title (50-72 characters)
2. The commit message should adhere to the conventional commit format
3. Describe what was changed and why
4. Be clear and informative`,
};

export async function generateCommitMsg(secrets: vscode.SecretStorage, scm?: vscode.SourceControl) {
	try {
		const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
		if (!gitExtension) {
			throw new Error("Git extension not found");
		}

		const git = gitExtension.getAPI(1);
		if (git.repositories.length === 0) {
			throw new Error("No Git repositories available");
		}

		// If scm is provided, then the user specified one repository by clicking the "Source Control" menu button
		if (scm) {
			const repository = git.getRepository(scm.rootUri);

			if (!repository) {
				throw new Error("Repository not found for provided SCM");
			}

			await generateCommitMsgForRepository(secrets, repository);
			return;
		}

		await orchestrateWorkspaceCommitMsgGeneration(secrets, git.repositories);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`[Commit Generation Failed] ${errorMessage}`);
	}
}

async function orchestrateWorkspaceCommitMsgGeneration(secrets: vscode.SecretStorage, repos: any[]) {
	const reposWithChanges = await filterForReposWithChanges(repos);

	if (reposWithChanges.length === 0) {
		vscode.window.showInformationMessage(`No changes found in any workspace repositories.`);
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
		placeHolder: "Select repository for commit message generation",
	});
}

async function generateCommitMsgForRepository(secrets: vscode.SecretStorage, repository: any) {
	const inputBox = repository.inputBox;
	const repoPath = repository.rootUri.fsPath;
	const gitDiff = await getGitDiff(repoPath);

	if (!gitDiff) {
		throw new Error(`No changes in repository ${repoPath.split(path.sep).pop() || "repository"} for commit message`);
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
			title: `Generating commit message for ${repoPath.split(path.sep).pop() || "repository"}...`,
			cancellable: true,
		},
		() => performCommitMsgGeneration(secrets, gitDiff, inputBox)
	);
}

async function performCommitMsgGeneration(secrets: vscode.SecretStorage, gitDiff: string, inputBox: any) {
	try {
		vscode.commands.executeCommand("setContext", "oaicopilot.isGeneratingCommit", true);

		const prompts = [PROMPT.instruction];

		const currentInput = inputBox.value?.trim() || "";
		if (currentInput) {
			prompts.push(PROMPT.user.replace("{{USER_CURRENT_INPUT}}", currentInput));
		}

		const truncatedDiff =
			gitDiff.length > 5000 ? gitDiff.substring(0, 5000) + "\n\n[Diff truncated due to size]" : gitDiff;
		prompts.push(truncatedDiff);
		const prompt = prompts.join("\n\n");

		// Get user models from configuration
		const config = vscode.workspace.getConfiguration();
		const userModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		// Filter models that are marked for commit generation
		const commitModels = userModels.filter((model: HFModelItem) => model.useForCommitGeneration === true);

		if (commitModels.length === 0) {
			throw new Error(
				"No models configured for commit message generation. Please set 'useForCommitGeneration' to true for at least one model in your configuration."
			);
		}

		// Use the first model marked for commit generation
		const selectedModel = commitModels[0];

		// Get API key for the model's provider
		const apiKey = await ensureApiKey(secrets, selectedModel.owned_by);
		if (!apiKey) {
			throw new Error("OAI Compatible API key not found");
		}

		// Get base URL for the model
		const baseUrl = selectedModel.baseUrl || config.get<string>("oaicopilot.baseUrl", "");
		if (!baseUrl || !baseUrl.startsWith("http")) {
			throw new Error(`Invalid base URL configuration.`);
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
			apiInstance = new AnthropicApi();
		} else {
			// Default to OpenAI-compatible API
			apiInstance = new OpenaiApi();
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

		if (!inputBox.value) {
			throw new Error("empty API response");
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`);
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

	return apiKey;
}
