import * as vscode from "vscode";

import type { TokenUsage } from "./types";
import { logger } from "./logger";
import { VersionManager } from "./versionManager";

/**
 * Minimal OpenTelemetry tracer that exports one span per chat request to an
 * OTLP/HTTP (JSON) endpoint such as Langfuse (`.../api/public/otel`).
 *
 * Deliberately dependency-free (no @opentelemetry/* packages): we only need one
 * span per request, so we hand-roll the OTLP JSON payload following the GenAI
 * semantic conventions (`gen_ai.*` attributes), which Langfuse maps natively to
 * traces/generations with token usage.
 */

interface OtelConfig {
	enabled: boolean;
	endpoint: string;
	headers: Record<string, string>;
	captureContent: boolean;
}

function readConfig(): OtelConfig | undefined {
	const config = vscode.workspace.getConfiguration();
	if (!config.get<boolean>("oaicopilot.otel.enabled", false)) {
		return undefined;
	}
	const endpoint = config.get<string>("oaicopilot.otel.endpoint", "").replace(/\/+$/, "");
	if (!endpoint || !endpoint.startsWith("http")) {
		logger.warn("otel.disabled", { reason: "invalid or missing oaicopilot.otel.endpoint" });
		return undefined;
	}
	const headers = config.get<Record<string, string>>("oaicopilot.otel.headers", {}) ?? {};
	return {
		enabled: true,
		endpoint,
		headers,
		captureContent: config.get<boolean>("oaicopilot.otel.captureContent", false),
	};
}

function toAttribute(key: string, value: string | number | boolean): { key: string; value: Record<string, unknown> } {
	if (typeof value === "number" && Number.isInteger(value)) {
		return { key, value: { intValue: String(value) } };
	}
	if (typeof value === "number") {
		return { key, value: { doubleValue: value } };
	}
	if (typeof value === "boolean") {
		return { key, value: { boolValue: value } };
	}
	return { key, value: { stringValue: value } };
}

function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A chat span being tracked for the lifetime of one request. */
export interface ChatSpan {
	/** Record the final token usage reported by the API client. */
	setUsage(usage: TokenUsage | null): void;
	/** Record the assistant's full response text (only exported when captureContent is on). */
	setOutput(text: string): void;
	/** Record an error that failed the request. */
	setError(error: unknown): void;
	/** Finalize and export the span (fire-and-forget). */
	end(): void;
}

/**
 * Start a span for one chat request. Returns undefined when OTel export is not
 * enabled or misconfigured — all methods below are then no-ops via the caller's
 * optional chaining.
 */
export function startChatSpan(
	modelId: string,
	apiMode: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): ChatSpan | undefined {
	const cfg = readConfig();
	if (!cfg) {
		return undefined;
	}

	const startTime = Date.now();
	const startNano = String(BigInt(startTime) * 1_000_000n);
	const traceId = randomHex(16);
	const spanId = randomHex(8);

	let usage: TokenUsage | null = null;
	let output = "";
	let errorMessage: string | undefined;

	const attributes: { key: string; value: Record<string, unknown> }[] = [
		toAttribute("gen_ai.operation.name", "chat"),
		toAttribute("gen_ai.system", apiMode),
		toAttribute("gen_ai.request.model", modelId),
	];

	const events: Record<string, unknown>[] = [];

	return {
		setUsage(u) {
			usage = u;
		},
		setOutput(text) {
			output = text;
		},
		setError(error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		},
		end() {
			try {
				const endNano = String(BigInt(Date.now()) * 1_000_000n);

				if (usage) {
					attributes.push(toAttribute("gen_ai.usage.input_tokens", usage.prompt_tokens ?? 0));
					attributes.push(toAttribute("gen_ai.usage.output_tokens", usage.completion_tokens ?? 0));
				}
				if (errorMessage !== undefined) {
					attributes.push(toAttribute("error", true));
					events.push({
						name: "exception",
						timeUnixNano: endNano,
						attributes: [toAttribute("exception.message", errorMessage)],
					});
				}
				if (cfg.captureContent && output) {
					events.push({
						name: "gen_ai.content.completion",
						timeUnixNano: endNano,
						attributes: [toAttribute("gen_ai.completion", output)],
					});
				}

				// Content capture is opt-in: prompts carry the user's full conversation.
				if (cfg.captureContent) {
					const prompt = messages
						.map((m) => {
							const role = String((m as unknown as { role?: string }).role ?? "unknown");
							const parts: string[] = [];
							for (const part of m.content ?? []) {
								if (part instanceof vscode.LanguageModelTextPart) {
									parts.push(part.value);
								}
							}
							return parts.length > 0 ? `${role}: ${parts.join("")}` : role;
						})
						.join("\n");
					if (prompt) {
						events.push({
							name: "gen_ai.content.prompt",
							timeUnixNano: startNano,
							attributes: [toAttribute("gen_ai.prompt", prompt)],
						});
					}
				}

				const span: Record<string, unknown> = {
					traceId,
					spanId,
					name: `chat ${modelId}`,
					kind: 1 /* INTERNAL */,
					startTimeUnixNano: startNano,
					endTimeUnixNano: endNano,
					attributes,
					events,
					status: { code: errorMessage !== undefined ? 2 /* ERROR */ : 1 /* OK */ },
				};

				const payload = {
					resourceSpans: [
						{
							resource: {
								attributes: [
									toAttribute("service.name", "oai-compatible-copilot"),
									toAttribute("service.version", VersionManager.getUserAgent()),
								],
							},
							scopeSpans: [{ scope: { name: "oai-compatible-copilot" }, spans: [span] }],
						},
					],
				};

				// Fire-and-forget: tracing must never break the chat request.
				fetch(`${cfg.endpoint}/v1/traces`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...cfg.headers },
					body: JSON.stringify(payload),
				})
					.then((res) => {
						if (!res.ok) {
							logger.warn("otel.export.http_error", { status: res.status, statusText: res.statusText });
						}
					})
					.catch((e) => {
						logger.warn("otel.export.error", { error: e instanceof Error ? e.message : String(e) });
					});
			} catch (e) {
				logger.warn("otel.span.error", { error: e instanceof Error ? e.message : String(e) });
			}
		},
	};
}
