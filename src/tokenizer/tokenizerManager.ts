import { TikTokenizer, createByEncoderName } from "@microsoft/tiktokenizer";

// Simple LRU Cache for token counts
class TokenCache {
	private cache = new Map<string, number>();
	private maxSize = 5000;
	private maxSizeBytes = 5_000_000; // 5MB
	private currentSize = 0;

	get(key: string): number | undefined {
		const value = this.cache.get(key);
		if (value !== undefined) {
			// Move to end (most recently used)
			this.cache.delete(key);
			this.cache.set(key, value);
		}
		return value;
	}

	set(key: string, value: number): void {
		// Calculate size of new entry
		const entrySize = key.length * 2 + 8; // Approximate size in bytes

		// Evict if would exceed limits
		while ((this.cache.size >= this.maxSize || this.currentSize + entrySize > this.maxSizeBytes) && this.cache.size > 0) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey === undefined) break;
			this.cache.delete(firstKey);
		}

		this.cache.set(key, value);
		this.currentSize += entrySize;
	}
}

// Tokenizer singleton
export class TokenizerManager {
	private static instance: TokenizerManager | null = null;
	private tokenizer: TikTokenizer | null = null;
	private cache = new TokenCache();
	private tokenizerReady: Promise<void> | null = null;

	private constructor() {}

	static getInstance(): TokenizerManager {
		if (!TokenizerManager.instance) {
			TokenizerManager.instance = new TokenizerManager();
		}
		return TokenizerManager.instance;
	}

	async getTokenizer(): Promise<TikTokenizer> {
		if (!this.tokenizer) {
			if (!this.tokenizerReady) {
				this.tokenizerReady = (async () => {
					this.tokenizer = await createByEncoderName("o200k_base");
				})();
			}
			await this.tokenizerReady;
			if (!this.tokenizer) {
				throw new Error("Failed to initialize tokenizer");
			}
		}
		return this.tokenizer;
	}

	async countTokens(text: string): Promise<number> {
		if (!text) return 0;

		const cached = this.cache.get(text);
		if (cached !== undefined) {
			return cached;
		}

		const tokenizer = await this.getTokenizer();
		const tokens = tokenizer.encode(text, ["<|im_start|>", "<|im_end|>", "<|im_sep|>"]);
		const count = tokens.length;

		this.cache.set(text, count);
		return count;
	}
}

// Export singleton instance
export const getTokenizer = TokenizerManager.getInstance();
