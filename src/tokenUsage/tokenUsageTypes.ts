/**
 * Token Usage Tracking Types
 *
 * 预聚合存储结构：不存单条请求记录，直接累加到对应桶中。
 * 存储大小只与 (供应商数 × 保留天数) 成正比，与请求次数无关。
 */

/** 每日统计数据 */
export interface DailyStats {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	requestCount: number;
}

/** 累计统计数据 */
export interface TotalStats {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	requestCount: number;
}

/** 单个供应商的统计数据 */
export interface ProviderStats {
	/** 按日期聚合的每日统计，key 格式: "YYYY-MM-DD" */
	daily: Record<string, DailyStats>;
	/** 全部时间的累计统计 */
	total: TotalStats;
}

/** 持久化存储结构 */
export interface TokenUsageStorage {
	/** 数据格式版本，用于未来迁移 */
	version: number;
	/** 按供应商分组的统计数据 */
	providers: Record<string, ProviderStats>;
	/** 上次清理过期数据的时间戳 */
	lastCleanup: number;
}

/** 创建空的 DailyStats */
export function createEmptyDailyStats(): DailyStats {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		requestCount: 0,
	};
}

/** 创建空的 TotalStats */
export function createEmptyTotalStats(): TotalStats {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		requestCount: 0,
	};
}

/** 创建空的 ProviderStats */
export function createEmptyProviderStats(): ProviderStats {
	return {
		daily: {},
		total: createEmptyTotalStats(),
	};
}

/** 创建空的 TokenUsageStorage */
export function createEmptyStorage(): TokenUsageStorage {
	return {
		version: 1,
		providers: {},
		lastCleanup: 0,
	};
}
