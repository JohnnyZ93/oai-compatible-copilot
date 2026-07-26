import * as vscode from "vscode";
import { TokenUsageTracker } from "./tokenUsageTracker";
import { I18N } from "../i18n";

const VIEW_ID = "oaicopilot.tokenUsage";

/**
 * Token 消耗统计 WebView 面板
 */
export class TokenUsageView {
	private static _panel: vscode.WebviewPanel | undefined;
	private static _tracker: TokenUsageTracker | undefined;

	/**
	 * 打开 Token 消耗统计面板
	 */
	static openPanel(extensionUri: vscode.Uri, tracker: TokenUsageTracker): void {
		if (TokenUsageView._panel) {
			TokenUsageView._panel.reveal();
			return;
		}

		TokenUsageView._tracker = tracker;

		const panel = vscode.window.createWebviewPanel(VIEW_ID, I18N.tokenUsage(), vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});

		panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, "assets", "logo.png"),
			dark: vscode.Uri.joinPath(extensionUri, "assets", "logo.png"),
		};

		panel.webview.html = TokenUsageView._getHtml(panel.webview, extensionUri, tracker);

		// Handle messages from the webview
		panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.type) {
					case "export":
						vscode.commands.executeCommand("oaicopilot.exportTokenUsage");
						break;
					case "refresh":
					if (TokenUsageView._panel && TokenUsageView._tracker) {
						TokenUsageView._panel.webview.html = TokenUsageView._getHtml(
							TokenUsageView._panel.webview,
							extensionUri,
							TokenUsageView._tracker
						);
					}
					break;
				case "reset":
					vscode.commands.executeCommand("oaicopilot.resetTokenUsage");
					// Refresh the panel after reset
					setTimeout(() => {
						if (TokenUsageView._panel && TokenUsageView._tracker) {
							TokenUsageView._panel.webview.html = TokenUsageView._getHtml(
								TokenUsageView._panel.webview,
								extensionUri,
								TokenUsageView._tracker
							);
						}
					}, 500);
					break;
			}
			},
			undefined
		);

		panel.onDidDispose(() => {
			TokenUsageView._panel = undefined;
		});

		TokenUsageView._panel = panel;
	}

	/**
	 * 生成 WebView HTML 内容
	 */
	private static _getHtml(
		webview: vscode.Webview,
		extensionUri: vscode.Uri,
		tracker: TokenUsageTracker
	): string {
		const todayStats = tracker.getTodayStats();
		const totalStats = tracker.getTotalStats();
		const recentStats = tracker.getRecentDaysStats(30);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${I18N.tokenUsage()}</title>
	<style>
		:root {
			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--border: var(--vscode-panel-border);
			--accent: var(--vscode-textLink-foreground);
			--card-bg: var(--vscode-editor-inactiveSelectionBackground);
			--success: var(--vscode-terminal-ansiGreen);
			--warning: var(--vscode-terminal-ansiYellow);
			--error: var(--vscode-terminal-ansiRed);
		}
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--fg);
			background: var(--bg);
			padding: 16px;
		}
		h1 { font-size: 1.4em; margin-bottom: 16px; }
		h2 { font-size: 1.1em; margin: 20px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
		.summary-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			gap: 12px;
			margin-bottom: 20px;
		}
		.card {
			background: var(--card-bg);
			border-radius: 8px;
			padding: 16px;
		}
		.card-label { font-size: 0.85em; opacity: 0.7; margin-bottom: 4px; }
		.card-value { font-size: 1.5em; font-weight: 600; }
		.card-sub { font-size: 0.8em; opacity: 0.6; margin-top: 4px; }
		table {
			width: 100%;
			border-collapse: collapse;
			margin-top: 8px;
		}
		th, td {
			text-align: left;
			padding: 8px 12px;
			border-bottom: 1px solid var(--border);
		}
		th { font-weight: 600; opacity: 0.8; font-size: 0.85em; }
		td { font-size: 0.9em; }
		tr:hover { background: var(--card-bg); }
		.bar-container {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.bar {
			height: 8px;
			border-radius: 4px;
			background: var(--accent);
			min-width: 2px;
		}
		.empty-state {
			text-align: center;
			padding: 40px;
			opacity: 0.6;
		}
		.btn {
			background: var(--accent);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 6px 12px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 0.85em;
			margin-right: 8px;
		}
		.btn:hover { opacity: 0.9; }
		.btn-danger { background: var(--error); }
		.actions { margin-top: 20px; }
	</style>
</head>
<body>
	<h1>${I18N.tokenUsage()}</h1>

	<!-- Summary Cards -->
	<div class="summary-grid">
		<div class="card">
			<div class="card-label">${I18N.tokenUsageToday()}</div>
			<div class="card-value">${TokenUsageView._formatNumber(TokenUsageView._sumTokens(todayStats))}</div>
			<div class="card-sub">${todayStats.size} ${I18N.tokenUsageProvider().toLowerCase()}</div>
		</div>
		<div class="card">
			<div class="card-label">${I18N.tokenUsageAllTime()}</div>
			<div class="card-value">${TokenUsageView._formatNumber(TokenUsageView._sumTokens(totalStats))}</div>
			<div class="card-sub">${totalStats.size} ${I18N.tokenUsageProvider().toLowerCase()}</div>
		</div>
	</div>

	<!-- Today's Usage by Provider -->
	<h2>${I18N.tokenUsageToday()} ${I18N.tokenUsagePerProvider()}</h2>
	${TokenUsageView._renderProviderTable(todayStats)}

	<!-- All-time Usage by Provider -->
	<h2>${I18N.tokenUsageAllTime()} ${I18N.tokenUsagePerProvider()}</h2>
	${TokenUsageView._renderProviderTable(totalStats)}

	<!-- Recent 30 Days Trend -->
	<h2>${I18N.tokenUsageRecentDays(30)}</h2>
	${TokenUsageView._renderRecentTrend(recentStats)}

	<!-- Actions -->
	<div class="actions">
		<button class="btn" onclick="refresh()">${I18N.refresh()}</button>
		<button class="btn" onclick="exportData()">${I18N.tokenUsageExport()}</button>
		<button class="btn btn-danger" onclick="resetData()">${I18N.tokenUsageReset()}</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		function refresh() {
			vscode.postMessage({ type: 'refresh' });
		}

		function exportData() {
			vscode.postMessage({ type: 'export' });
		}

		function resetData() {
			vscode.postMessage({ type: 'reset' });
		}
	</script>
</body>
</html>`;
	}

	/**
	 * 渲染供应商表格
	 */
	private static _renderProviderTable(stats: Map<string, { promptTokens: number; completionTokens: number; totalTokens: number; requestCount: number }>): string {
		if (stats.size === 0) {
			return `<div class="empty-state">${I18N.tokenUsageNoData()}</div>`;
		}

		const rows: string[] = [];
		let maxTokens = 1;
		for (const [, s] of stats) {
			if (s.totalTokens > maxTokens) {
				maxTokens = s.totalTokens;
			}
		}

		// Sort by promptTokens descending
		const sortedEntries = [...stats.entries()].sort((a, b) => b[1].promptTokens - a[1].promptTokens);

		for (const [provider, s] of sortedEntries) {
			const barWidth = Math.max((s.totalTokens / maxTokens) * 100, 2);
			rows.push(`
				<tr>
					<td><strong>${provider}</strong></td>
					<td>${TokenUsageView._formatNumber(s.promptTokens)}</td>
					<td>${TokenUsageView._formatNumber(s.completionTokens)}</td>
					<td>
						<div class="bar-container">
							<div class="bar" style="width: ${barWidth}%"></div>
							<span>${TokenUsageView._formatNumber(s.totalTokens)}</span>
						</div>
					</td>
					<td>${s.requestCount.toLocaleString()}</td>
				</tr>
			`);
		}

		return `
			<table>
				<thead>
					<tr>
						<th>${I18N.tokenUsageProvider()}</th>
						<th>${I18N.tokenUsagePromptTokens()}</th>
						<th>${I18N.tokenUsageCompletionTokens()}</th>
						<th>${I18N.tokenUsageTotalTokens()}</th>
						<th>${I18N.tokenUsageRequests()}</th>
					</tr>
				</thead>
				<tbody>
					${rows.join("")}
				</tbody>
			</table>
		`;
	}

	/**
	 * 渲染最近30天趋势折线图（每个供应商一条线）
	 */
	private static _renderRecentTrend(
		recentStats: Map<string, { date: string; stats: { promptTokens: number; completionTokens: number; totalTokens: number; requestCount: number } }[]>,
	): string {
		if (recentStats.size === 0) {
			return `<div class="empty-state">${I18N.tokenUsageNoData()}</div>`;
		}

		// Collect all unique dates across all providers
		const dateSet = new Set<string>();
		for (const [, days] of recentStats) {
			for (const d of days) {
				dateSet.add(d.date);
			}
		}
		const dates = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
		if (dates.length === 0) {
			return `<div class="empty-state">${I18N.tokenUsageNoData()}</div>`;
		}

		// Build per-provider data map: provider -> date -> totalTokens
		const providerData = new Map<string, Map<string, number>>();
		for (const [provider, days] of recentStats) {
			const map = new Map<string, number>();
			for (const d of days) {
				map.set(d.date, d.stats.totalTokens);
			}
			providerData.set(provider, map);
		}

		// Find max token value for Y axis
		let maxTokens = 1;
		for (const [, dateMap] of providerData) {
			for (const [, tokens] of dateMap) {
				if (tokens > maxTokens) {
					maxTokens = tokens;
				}
			}
		}

		// SVG chart dimensions
		const svgWidth = 950;
		const svgHeight = 300;
		const padding = { top: 30, right: 20, bottom: 60, left: 70 };
		const chartWidth = svgWidth - padding.left - padding.right;
		const chartHeight = svgHeight - padding.top - padding.bottom;

		// Color palette for providers
		const colors = [
			"#4fc3f7", "#81c784", "#ffb74d", "#e57373", "#ba68c8",
			"#4dd0e1", "#aed581", "#ff8a65", "#f06292", "#7986cb",
			"#dce775", "#4db6ac", "#ffab91", "#ce93d8", "#90a4ae",
		];

		// Build X axis labels (show every few days to avoid overlap)
		const xLabels: { x: number; label: string }[] = [];
		const labelInterval = dates.length <= 10 ? 1 : dates.length <= 20 ? 2 : 3;
		dates.forEach((date, i) => {
			if (i % labelInterval === 0 || i === dates.length - 1) {
				const x = padding.left + (dates.length > 1 ? (i / (dates.length - 1)) * chartWidth : chartWidth / 2);
				// Show MM-DD format
				const label = date.slice(5);
				xLabels.push({ x, label });
			}
		});

		// Build Y axis labels
		const yTickCount = 5;
		const yLabels: { y: number; label: string }[] = [];
		for (let i = 0; i <= yTickCount; i++) {
			const y = padding.top + chartHeight - (i / yTickCount) * chartHeight;
			const value = (i / yTickCount) * maxTokens;
			yLabels.push({ y, label: TokenUsageView._formatNumber(value) });
		}

		// Build polyline points for each provider
		const providerLines: { provider: string; color: string; points: string; dataPoints: { x: number; y: number; tokens: number }[] }[] = [];
		let colorIdx = 0;
		for (const [provider, dateMap] of providerData) {
			const color = colors[colorIdx % colors.length];
			colorIdx++;
			const dataPoints: { x: number; y: number; tokens: number }[] = [];
			const pointStrArr: string[] = [];

			for (let i = 0; i < dates.length; i++) {
				const tokens = dateMap.get(dates[i]) ?? 0;
				const x = padding.left + (dates.length > 1 ? (i / (dates.length - 1)) * chartWidth : chartWidth / 2);
				const y = padding.top + chartHeight - (tokens / maxTokens) * chartHeight;
				dataPoints.push({ x, y, tokens });
				pointStrArr.push(`${x},${y}`);
			}

			providerLines.push({
				provider,
				color,
				points: pointStrArr.join(" "),
				dataPoints,
			});
		}

		// Build SVG elements using string concatenation to avoid template literal issues
		const gridLines = yLabels.map(
			({ y }) => '<line x1="' + padding.left + '" y1="' + y + '" x2="' + (padding.left + chartWidth) + '" y2="' + y + '" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,4" />'
		);

		const xAxisLabels = xLabels.map(
			({ x, label }) => '<text x="' + x + '" y="' + (padding.top + chartHeight + 20) + '" text-anchor="middle" fill="var(--fg)" font-size="11" opacity="0.7">' + label + '</text>'
		);

		const yAxisLabels = yLabels.map(
			({ y, label }) => '<text x="' + (padding.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--fg)" font-size="11" opacity="0.7">' + label + '</text>'
		);

		const lines = providerLines.map(({ provider, color, points, dataPoints }) => {
			const circles = dataPoints
				.filter((dp) => dp.tokens > 0)
				.map(
					(dp) => '<circle cx="' + dp.x + '" cy="' + dp.y + '" r="3" fill="' + color + '" stroke="var(--bg)" stroke-width="1.5"><title>' + provider + ': ' + TokenUsageView._formatNumber(dp.tokens) + ' tokens</title></circle>'
				)
				.join("\n");
			return '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />\n' + circles;
		});

		// Legend
		const legendRows = Math.ceil(providerLines.length / 4);
		const legendItems = providerLines.map(({ provider, color }, i) => {
			const col = i % 4;
			const row = Math.floor(i / 4);
			const lx = padding.left + col * 180;
			const ly = svgHeight - 10 + row * 20;
			return '<rect x="' + lx + '" y="' + (ly - 10) + '" width="12" height="12" rx="2" fill="' + color + '" /><text x="' + (lx + 16) + '" y="' + ly + '" fill="var(--fg)" font-size="12">' + provider + '</text>';
		});

		// Adjust SVG height for legend
		const totalSvgHeight = svgHeight + legendRows * 20;

		const svgParts: string[] = [];
		svgParts.push('<svg viewBox="0 0 ' + svgWidth + ' ' + totalSvgHeight + '" width="' + svgWidth + '" style="height: auto;">');
		svgParts.push('<!-- Grid -->');
		svgParts.push(...gridLines);
		svgParts.push('<!-- Axes -->');
		svgParts.push('<line x1="' + padding.left + '" y1="' + padding.top + '" x2="' + padding.left + '" y2="' + (padding.top + chartHeight) + '" stroke="var(--fg)" stroke-width="1" opacity="0.3" />');
		svgParts.push('<line x1="' + padding.left + '" y1="' + (padding.top + chartHeight) + '" x2="' + (padding.left + chartWidth) + '" y2="' + (padding.top + chartHeight) + '" stroke="var(--fg)" stroke-width="1" opacity="0.3" />');
		svgParts.push('<!-- X axis labels -->');
		svgParts.push(...xAxisLabels);
		svgParts.push('<!-- Y axis labels -->');
		svgParts.push(...yAxisLabels);
		svgParts.push('<!-- Data lines -->');
		svgParts.push(...lines);
		svgParts.push('<!-- Legend -->');
		svgParts.push(...legendItems);
		svgParts.push('</svg>');

		return svgParts.join("\n");
	}

	/**
	 * 计算总 token 数
	 */
	private static _sumTokens(
		stats: Map<string, { totalTokens: number }>
	): number {
		let sum = 0;
		for (const [, s] of stats) {
			sum += s.totalTokens;
		}
		return sum;
	}

	/**
	 * 格式化数字
	 */
	private static _formatNumber(value: number): string {
		if (value >= 1_000_000_000) {
			return (value / 1_000_000_000).toFixed(1) + "B";
		}
		if (value >= 1_000_000) {
			return (value / 1_000_000).toFixed(1) + "M";
		}
		if (value >= 1_000) {
			return (value / 1_000).toFixed(1) + "K";
		}
		return value.toLocaleString();
	}
}
