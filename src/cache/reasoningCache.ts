/**
 * Simple in-memory cache for reasoning content.
 * Maps tool call IDs to their associated reasoning content.
 * This helps restore reasoning content when it's lost from VS Code's history (e.g. after summarization),
 * preventing API errors (HTTP 400) from providers like DeepSeek that require reasoning_content to be present.
 */
export class ReasoningCache {
	private static instance: ReasoningCache;
	private cache: Map<string, string>;

	private constructor() {
		this.cache = new Map();
	}

	/**
	 * Get the singleton instance of the cache.
	 */
	public static getInstance(): ReasoningCache {
		if (!ReasoningCache.instance) {
			ReasoningCache.instance = new ReasoningCache();
		}
		return ReasoningCache.instance;
	}

	/**
	 * Add reasoning content associated with tool calls.
	 * @param toolCallIds Array of tool call IDs generated in the same response
	 * @param content The reasoning content text
	 */
	public add(toolCallIds: string[], content: string): void {
		if (!content || toolCallIds.length === 0) {
			return;
		}

		// Map each tool call ID to the same reasoning content
		for (const id of toolCallIds) {
			this.cache.set(id, content);
		}
	}

	/**
	 * Retrieve reasoning content for a given tool call ID.
	 * @param toolCallId The tool call ID to look up
	 */
	public get(toolCallId: string): string | undefined {
		return this.cache.get(toolCallId);
	}

	/**
	 * Clear the cache.
	 */
	public clear(): void {
		this.cache.clear();
	}
}
