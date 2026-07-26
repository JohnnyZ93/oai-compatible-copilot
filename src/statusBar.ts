import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import { TokenUsageTracker } from "./tokenUsage/tokenUsageTracker";
import { I18N } from "./i18n";

/** 当前状态栏显示模式 */
type StatusBarMode = "context" | "usage";

let _statusBarMode: StatusBarMode = "context";
let _tokenUsageTracker: TokenUsageTracker | undefined;
let _statusBarItem: vscode.StatusBarItem | undefined;

export function initStatusBar(context: vscode.ExtensionContext, tokenUsageTracker?: TokenUsageTracker): vscode.StatusBarItem {
	_tokenUsageTracker = tokenUsageTracker;

	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Token Count";
	tokenCountStatusBarItem.text = `$(symbol-numeric) ${I18N.ready()}`;
	tokenCountStatusBarItem.tooltip = I18N.tokenUsageShowDetails();
	tokenCountStatusBarItem.command = "oaicopilot.openConfig";
	context.subscriptions.push(tokenCountStatusBarItem);
	// Show the status bar item initially
	tokenCountStatusBarItem.show();

	_statusBarItem = tokenCountStatusBarItem;
	return tokenCountStatusBarItem;
}

/**
 * 切换状态栏显示模式（上下文窗口 / Token 消耗统计）
 */
export function toggleStatusBarMode(): void {
	if (!_statusBarItem) {
		return;
	}

	if (_statusBarMode === "context") {
		_statusBarMode = "usage";
		updateUsageStatusBar();
	} else {
		_statusBarMode = "context";
		_statusBarItem.text = `$(symbol-numeric) ${I18N.ready()}`;
		_statusBarItem.tooltip = I18N.tokenUsageShowDetails();
		_statusBarItem.command = "oaicopilot.openConfig";
	}
}

/**
 * 更新状态栏显示 Token 消耗统计
 */
export function updateUsageStatusBar(): void {
	if (!_statusBarItem || !_tokenUsageTracker) {
		return;
	}

	const todayTotal = _tokenUsageTracker.getTodayTotalTokens();
	const allTimeTotal = _tokenUsageTracker.getAllTimeTotalTokens();
	const todayStats = _tokenUsageTracker.getTodayStats();

	// Build provider summary
	const providerSummaries: string[] = [];
	for (const [provider, stats] of todayStats) {
		providerSummaries.push(`${provider}: ${formatTokenCount(stats.totalTokens)}`);
	}

	const todayStr = providerSummaries.length > 0 ? providerSummaries.join(" | ") : I18N.noData();

	_statusBarItem.text = `$(graph) ${formatTokenCount(todayTotal)}`;
	_statusBarItem.tooltip = [
		`${I18N.tokenUsageToday()}: ${formatTokenCount(todayTotal)} (${todayStats.size} ${I18N.provider()})`,
		`${I18N.tokenUsageAllTime()}: ${formatTokenCount(allTimeTotal)}`,
		"",
		todayStr,
		"",
		I18N.tokenUsageShowDetails(),
	].join("\n");
	_statusBarItem.command = "oaicopilot.showTokenUsage";
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
 * @returns Progress bar string (e.g., "▆ 75.2%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

	return `${blocks[blockIndex]} ${usagePercentage.toFixed(1)}%`;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<void> {
	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) => countMessageTokens(message, modelConfig));

	const tokenCounts = await Promise.all(tokenCountPromises);
	const messagesTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Calculate tool definition tokens
	let toolTokens = 0;
	if (tools && tools.length > 0) {
		toolTokens = await countToolTokens(tools);
	}

	// Total tokens: messages + tool definitions + reserved output
	const totalTokenCount = messagesTokens + toolTokens;
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	// Create visual progress bar with single progressive block
	const progressBar = createProgressBar(totalTokenCount, maxTokens);

	// Append today's usage summary if tracker is available
	let suffix = "";
	if (_tokenUsageTracker) {
		const todayTotal = _tokenUsageTracker.getTodayTotalTokens();
		if (todayTotal > 0) {
			suffix = ` | ${formatTokenCount(todayTotal)}`;
		}
	}

	const displayText = `$(symbol-parameter) ${progressBar}${suffix}`;
	statusBarItem.text = displayText;
	statusBarItem.tooltip = `${I18N.tokenUsageContext()}: ${formatTokenCount(totalTokenCount)} / ${formatTokenCount(maxTokens)}\n
${progressBar}\n
  - ${I18N.tokenUsageMessages()}: ${formatTokenCount(messagesTokens)}  (${Math.min((messagesTokens / maxTokens) * 100, 100).toFixed(1)}%)
  - ${I18N.tokenUsageTools()}: ${formatTokenCount(toolTokens)}  (${Math.min((toolTokens / maxTokens) * 100, 100).toFixed(1)}%) \n
${I18N.tokenUsageClickConfig()}`;

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
