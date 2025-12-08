import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, CancellationTokenSource } from "vscode";
import { prepareTokenCount } from "./provideToken";

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Token Count";
	tokenCountStatusBarItem.text = "$(symbol-numeric) Ready";
	tokenCountStatusBarItem.tooltip = "Current model token usage - Click to Manage ApiKeys";
	tokenCountStatusBarItem.command = "oaicopilot.setProviderApikey";
	context.subscriptions.push(tokenCountStatusBarItem);
	// Show the status bar item initially
	tokenCountStatusBarItem.show();
	return tokenCountStatusBarItem;
}

/**
 * Format number to thousands (K, M, B) format
 * @param value The number to format
 * @returns Formatted string (e.g., "2.3K", "168.0K")
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage
 * @param usedTokens Tokens used
 * @param maxTokens Maximum tokens available
 * @returns Progress bar string (e.g., "▆ 75%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

	return `${blocks[blockIndex]} ${Math.round(usagePercentage)}%`;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param provideTokenCount Callback function to count tokens for a message
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem
): Promise<void> {
	// Create a single CancellationTokenSource for all token count operations
	const cancellationTokenSource = new CancellationTokenSource();

	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) =>
		prepareTokenCount(model, message, cancellationTokenSource.token)
	);

	const tokenCounts = await Promise.all(tokenCountPromises);
	const totalTokenCount = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Update status bar with token count and model context window
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	// Create visual progress bar with single progressive block
	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	const displayText = `$(symbol-parameter) ${progressBar}`;
	statusBarItem.text = displayText;
	statusBarItem.tooltip = `Token Usage: ${formatTokenCount(totalTokenCount)} / ${formatTokenCount(maxTokens)}\n\n${progressBar}\n\nClick to Manage ApiKeys`;

	// Add color coding based on token usage
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	if (usagePercentage >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		statusBarItem.backgroundColor = undefined;
	}

	statusBarItem.show();
}
