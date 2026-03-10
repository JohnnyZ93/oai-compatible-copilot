import type {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { FallbackModelRef, HFApiMode, HFModelItem, RetryConfig, RuntimeResponsePart } from "./types";
import { createRetryConfig, isRetryableError } from "./utils";

const FALLBACK_ELIGIBLE_STATUS_CODES = [401, 403, 404, 405];

export interface ResolvedChatModelTarget {
	resolvedModelId: string;
	requestModelId: string;
	userModel: HFModelItem;
	baseUrl: string;
	apiKey: string;
	apiMode: HFApiMode;
	selectedModelId: string;
	selectedProvider?: string;
	failoverReason?: string;
}

export interface ChatRequestContext {
	messages: readonly LanguageModelChatRequestMessage[];
	options: ProvideLanguageModelChatResponseOptions;
	progress: Progress<LanguageModelResponsePart2>;
	token: CancellationToken;
}

export type ResolveFallbackTarget = (fallback: FallbackModelRef) => Promise<ResolvedChatModelTarget | undefined>;

export type ChatRequestFn = (
	target: ResolvedChatModelTarget,
	ctx: ChatRequestContext,
	retryConfig: RetryConfig
) => Promise<void>;

class BufferedProgress implements Progress<LanguageModelResponsePart2> {
	private readonly parts: RuntimeResponsePart[] = [];

	report(part: LanguageModelResponsePart2): void {
		this.parts.push(part);
	}

	hasBufferedParts(): boolean {
		return this.parts.length > 0;
	}

	replay(target: Progress<LanguageModelResponsePart2>): void {
		for (const part of this.parts) {
			target.report(part);
		}
	}
}

export class FallbackExecutor {
	async executeWithFallback(
		primaryTarget: ResolvedChatModelTarget,
		fallbacks: readonly FallbackModelRef[] | undefined,
		resolveFallbackTarget: ResolveFallbackTarget,
		requestFn: ChatRequestFn,
		ctx: ChatRequestContext
	): Promise<void> {
		const retryConfig = createRetryConfig();
		const targets: ResolvedChatModelTarget[] = [primaryTarget];
		const seen = new Set([primaryTarget.resolvedModelId]);

		for (const fallback of fallbacks ?? []) {
			const target = await resolveFallbackTarget(fallback);
			if (!target) {
				console.warn("[OAI Compatible Model Provider] Failed to resolve fallback model", fallback);
				continue;
			}
			if (seen.has(target.resolvedModelId)) {
				continue;
			}
			seen.add(target.resolvedModelId);
			targets.push(target);
		}

		const errors: Error[] = [];

		for (let index = 0; index < targets.length; index++) {
			const target =
				index === 0
					? targets[index]
					: {
						...targets[index],
						selectedModelId: primaryTarget.requestModelId,
						selectedProvider: primaryTarget.userModel.owned_by,
						failoverReason: errors.length > 0 ? errors[errors.length - 1].message : undefined,
					  };
			const bufferedProgress = new BufferedProgress();
			const bufferedContext: ChatRequestContext = {
				...ctx,
				progress: bufferedProgress,
			};

			try {
				if (index > 0) {
					console.warn(
						`[OAI Compatible Model Provider] Falling back to model ${target.resolvedModelId} (${target.baseUrl})`
					);
				}
				await requestFn(target, bufferedContext, retryConfig);
				bufferedProgress.replay(ctx.progress);
				return;
			} catch (error) {
				const normalizedError = error instanceof Error ? error : new Error(String(error));
				errors.push(normalizedError);

				if (!this.isFallbackEligible(normalizedError, retryConfig) && index < targets.length - 1) {
					throw normalizedError;
				}
			}
		}

		const details = errors.map((error, index) => `[${index + 1}/${errors.length}] ${error.message}`).join("\n");
		throw new Error(
			`All configured endpoints failed for ${primaryTarget.resolvedModelId}.${details ? `\n${details}` : ""}`
		);
	}

	private isFallbackEligible(error: Error, retryConfig: RetryConfig): boolean {
		return isRetryableError(error, retryConfig, FALLBACK_ELIGIBLE_STATUS_CODES);
	}
}