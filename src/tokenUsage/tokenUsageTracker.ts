import * as vscode from "vscode";
import {
	TokenUsageStorage,
	DailyStats,
	TotalStats,
	createEmptyStorage,
	createEmptyProviderStats,
	createEmptyDailyStats,
} from "./tokenUsageTypes";
import { logger } from "../logger";

/** 保留每日明细的天数 */
const RETAIN_DAILY_DAYS = 30;

/** 清理间隔：24 小时 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 存储键 */
const STORAGE_KEY = "oaicopilot.tokenUsage";

/**
 * Token 消耗统计追踪器
 *
 * 采用预聚合方案：每次请求完成时直接累加到对应桶中，
 * 不存储单条请求记录，确保存储大小可控。
 */
export class TokenUsageTracker {
	private _storage: TokenUsageStorage;

	constructor(private readonly globalState: vscode.Memento) {
		this._storage = this.load();
	}

	/**
	 * 从 globalState 加载存储数据
	 */
	private load(): TokenUsageStorage {
		try {
			const raw = this.globalState.get<TokenUsageStorage>(STORAGE_KEY);
			if (raw && raw.version === 1 && raw.providers) {
				return raw;
			}
		} catch (e) {
			logger.warn("tokenUsage.load.error", { error: String(e) });
		}
		return createEmptyStorage();
	}

	/**
	 * 保存数据到 globalState
	 */
	private save(): void {
		try {
			this.globalState.update(STORAGE_KEY, this._storage);
		} catch (e) {
			logger.error("tokenUsage.save.error", { error: String(e) });
		}
	}

	/**
	 * 获取当前日期字符串 (YYYY-MM-DD)，使用本地时区
	 */
	private getTodayKey(): string {
		return this.getDateKeyDaysAgo(0);
	}

	/**
	 * 获取 N 天前的日期字符串 (YYYY-MM-DD)，使用本地时区
	 * @param daysAgo 几天前（0 表示今天）
	 */
	private getDateKeyDaysAgo(daysAgo: number): string {
		const d = new Date();
		d.setDate(d.getDate() - daysAgo);
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	/**
	 * 记录一次请求的 token 消耗
	 * @param provider 供应商名称 (如 "openai", "anthropic")
	 * @param promptTokens 输入 token 数
	 * @param completionTokens 输出 token 数
	 * @param totalTokens 总 token 数
	 */
	recordUsage(provider: string, promptTokens: number, completionTokens: number, totalTokens: number): void {
		const date = this.getTodayKey();
		const normalizedProvider = (provider || "unknown").toLowerCase().trim();

		// 确保供应商存在
		if (!this._storage.providers[normalizedProvider]) {
			this._storage.providers[normalizedProvider] = createEmptyProviderStats();
		}

		const ps = this._storage.providers[normalizedProvider];

		// 累加到每日统计
		if (!ps.daily[date]) {
			ps.daily[date] = createEmptyDailyStats();
		}
		const daily = ps.daily[date];
		daily.promptTokens += promptTokens;
		daily.completionTokens += completionTokens;
		daily.totalTokens += totalTokens;
		daily.requestCount += 1;

		// 累加到累计统计
		ps.total.promptTokens += promptTokens;
		ps.total.completionTokens += completionTokens;
		ps.total.totalTokens += totalTokens;
		ps.total.requestCount += 1;

		this.save();

		// 定期清理过期数据
		this.cleanupIfNeeded();

		logger.debug("tokenUsage.recorded", {
			provider: normalizedProvider,
			date,
			promptTokens,
			completionTokens,
			totalTokens,
		});
	}

	/**
	 * 获取今日各供应商的统计数据
	 */
	getTodayStats(): Map<string, DailyStats> {
		const date = this.getTodayKey();
		const result = new Map<string, DailyStats>();

		for (const [provider, ps] of Object.entries(this._storage.providers)) {
			if (ps.daily[date]) {
				result.set(provider, ps.daily[date]);
			}
		}

		return result;
	}

	/**
	 * 获取各供应商的累计统计数据
	 */
	getTotalStats(): Map<string, TotalStats> {
		const result = new Map<string, TotalStats>();

		for (const [provider, ps] of Object.entries(this._storage.providers)) {
			if (ps.total.totalTokens > 0) {
				result.set(provider, { ...ps.total });
			}
		}

		return result;
	}

	/**
	 * 获取指定供应商的累计统计
	 */
	getProviderTotal(provider: string): TotalStats | undefined {
		const ps = this._storage.providers[provider.toLowerCase().trim()];
		return ps ? { ...ps.total } : undefined;
	}

	/**
	 * 获取指定供应商今日的统计
	 */
	getProviderToday(provider: string): DailyStats | undefined {
		const date = this.getTodayKey();
		const ps = this._storage.providers[provider.toLowerCase().trim()];
		return ps?.daily[date] ? { ...ps.daily[date] } : undefined;
	}

	/**
	 * 获取所有供应商名称
	 */
	getProviders(): string[] {
		return Object.keys(this._storage.providers).sort();
	}

	/**
	 * 获取指定日期范围的每日统计
	 */
	getDateRangeStats(startDate: string, endDate: string): Map<string, DailyStats[]> {
		const result = new Map<string, DailyStats[]>();

		for (const [provider, ps] of Object.entries(this._storage.providers)) {
			const stats: DailyStats[] = [];
			for (const [date, daily] of Object.entries(ps.daily)) {
				if (date >= startDate && date <= endDate) {
					stats.push({ ...daily });
				}
			}
			if (stats.length > 0) {
				result.set(provider, stats);
			}
		}

		return result;
	}

	/**
	 * 获取最近 N 天的每日统计（按供应商分组）
	 */
	getRecentDaysStats(days: number): Map<string, { date: string; stats: DailyStats }[]> {
		const result = new Map<string, { date: string; stats: DailyStats }[]>();

		for (const [provider, ps] of Object.entries(this._storage.providers)) {
			const stats: { date: string; stats: DailyStats }[] = [];
			for (let i = 0; i < days; i++) {
				const dateKey = this.getDateKeyDaysAgo(i);
				if (ps.daily[dateKey]) {
					stats.push({ date: dateKey, stats: { ...ps.daily[dateKey] } });
				}
			}
			if (stats.length > 0) {
				result.set(provider, stats);
			}
		}

		return result;
	}

	/**
	 * 重置所有统计数据
	 */
	reset(): void {
		this._storage = createEmptyStorage();
		this.save();
		logger.info("tokenUsage.reset", {});
	}

	/**
	 * 导出数据为 JSON 字符串
	 */
	exportData(): string {
		return JSON.stringify(this._storage, null, 2);
	}

	/**
	 * 获取今日总 token 消耗（所有供应商合计）
	 */
	getTodayTotalTokens(): number {
		const today = this.getTodayKey();
		let total = 0;
		for (const ps of Object.values(this._storage.providers)) {
			if (ps.daily[today]) {
				total += ps.daily[today].totalTokens;
			}
		}
		return total;
	}

	/**
	 * 获取累计总 token 消耗（所有供应商合计）
	 */
	getAllTimeTotalTokens(): number {
		let total = 0;
		for (const ps of Object.values(this._storage.providers)) {
			total += ps.total.totalTokens;
		}
		return total;
	}

	/**
	 * 定期清理过期的每日明细数据
	 * 只保留最近 RETAIN_DAILY_DAYS 天的数据
	 */
	private cleanupIfNeeded(): void {
		const now = Date.now();
		if (now - this._storage.lastCleanup < CLEANUP_INTERVAL_MS) {
			return;
		}

		this._storage.lastCleanup = now;
		const cutoffDate = this.getDateKeyDaysAgo(RETAIN_DAILY_DAYS);

		for (const ps of Object.values(this._storage.providers)) {
			for (const date of Object.keys(ps.daily)) {
				if (date < cutoffDate) {
					delete ps.daily[date];
				}
			}
		}

		this.save();
		logger.debug("tokenUsage.cleanup", { cutoffDate });
	}
}
