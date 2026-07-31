import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { HFModelItem, RetryConfig } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";

import { logger } from "./logger";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
}

export function getModelProviderId(model: unknown): string {
	if (!model || typeof model !== "object") {
		return "";
	}
	const obj = model as Record<string, unknown>;
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provide) ||
		pick(obj.provider) ||
		pick(obj.ownedBy) ||
		pick(obj.owner) ||
		pick(obj.vendor)
	);
}

export function normalizeUserModels(models: unknown): HFModelItem[] {
	const list = Array.isArray(models) ? models : [];
	const out: HFModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const provider = getModelProviderId(item);
		out.push({ ...(item as HFModelItem), owned_by: provider });
	}
	return out;
}

/**
 * Parse a model ID that may contain a configuration ID separator.
 * Format: "baseId::configId" or just "baseId"
 */
export function parseModelId(modelId: string): ParsedModelId {
	const parts = modelId.split("::");
	if (parts.length >= 2) {
		return {
			baseId: parts[0],
			configId: parts.slice(1).join("::"), // In case configId itself contains '::'
		};
	}
	return {
		baseId: modelId,
	};
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? { type: "object", properties: {} };
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[OAI Compatible Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

export type OpenAIResponsesToolChoice = "auto" | { type: "function"; name: string };

/**
 * Convert VS Code tool definitions to OpenAI Responses API tool definitions.
 * Responses uses `{ type:"function", name, description, parameters }` (no nested `function` object).
 */
export function convertToolsToOpenAIResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: OpenAIResponsesToolChoice;
} {
	const toolConfig = convertToolsToOpenAI(options);
	if (!toolConfig.tools || toolConfig.tools.length === 0) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = toolConfig.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = {
			type: "function",
			name: t.function.name,
		};
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: OpenAIResponsesToolChoice | undefined;
	if (toolConfig.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (toolConfig.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: toolConfig.tool_choice.function.name };
	}

	return { tools, tool_choice };
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

export interface ToolResultImage {
	mimeType: string;
	data: Uint8Array;
	sourcePath?: string;
}

export interface ToolCallMetadata {
	name?: string;
	input?: Record<string, unknown>;
}

export interface ToolResultContent {
	text: string;
	images: ToolResultImage[];
}

export function createDataUrlFromImageInfo(image: ToolResultImage): string {
	const base64Data = Buffer.from(image.data).toString("base64");
	return `data:${image.mimeType};base64,${base64Data}`;
}

function guessImageMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") {
		return "image/jpeg";
	}
	if (ext === ".png") {
		return "image/png";
	}
	if (ext === ".gif") {
		return "image/gif";
	}
	if (ext === ".webp") {
		return "image/webp";
	}
	return "application/octet-stream";
}

function isImageToolCall(toolCallMeta?: ToolCallMetadata): boolean {
	const input = toolCallMeta?.input;
	if (input && (typeof input.imagePath === "string" || typeof input.image_path === "string")) {
		return true;
	}
	const name = toolCallMeta?.name?.toLowerCase() ?? "";
	return name.includes("image");
}

function extractCandidateImagePaths(toolCallMeta?: ToolCallMetadata): string[] {
	if (!isImageToolCall(toolCallMeta)) {
		return [];
	}
	const input = toolCallMeta?.input;
	if (!input) {
		return [];
	}
	const candidates: string[] = [];
	for (const key of ["filePath", "file_path", "path", "imagePath", "image_path", "uri"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) {
			candidates.push(value.trim());
		}
	}
	return candidates;
}

function readImageInfoFromPath(candidate: string): ToolResultImage | undefined {
	try {
		let filePath = candidate;
		if (filePath.startsWith("file://")) {
			filePath = vscode.Uri.parse(filePath).fsPath;
		}
		const mimeType = guessImageMimeType(filePath);
		if (!isImageMimeType(mimeType) || !fs.existsSync(filePath)) {
			return undefined;
		}
		return { mimeType, data: fs.readFileSync(filePath), sourcePath: filePath };
	} catch {
		return undefined;
	}
}

function stringifyToolResultPartContent(c: unknown): string {
	if (c instanceof vscode.LanguageModelTextPart) {
		return c.value;
	}
	if (typeof c === "string") {
		return c;
	}
	if (c instanceof vscode.LanguageModelDataPart && (c.mimeType === "cache_control" || isImageMimeType(c.mimeType))) {
		return "";
	}
	try {
		return JSON.stringify(c);
	} catch {
		return "";
	}
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		text += stringifyToolResultPartContent(c);
	}
	return text;
}

/**
 * Collect text and image attachments from a tool result.
 *
 * Some VS Code image tools return only a `vscode-chat-response-resource://...` marker in the
 * textual tool result. That URI is internal to VS Code and cannot be dereferenced by remote API
 * providers. When the original image tool call included a local path, read that supported image
 * file and attach it as real bytes so provider adapters can emit standard multimodal payloads.
 */
export function collectToolResultContent(
	pr: { content?: ReadonlyArray<unknown> },
	toolCallMeta?: ToolCallMetadata
): ToolResultContent {
	let text = "";
	const images: ToolResultImage[] = [];

	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelDataPart && isImageMimeType(c.mimeType)) {
			images.push({ mimeType: c.mimeType, data: c.data });
		} else {
			text += stringifyToolResultPartContent(c);
		}
	}

	if (images.length === 0) {
		for (const candidate of extractCandidateImagePaths(toolCallMeta)) {
			const image = readImageInfoFromPath(candidate);
			if (image) {
				images.push(image);
				break;
			}
		}
	}

	return { text, images };
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("oaicopilot.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const baseIntervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableStatusError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));
			// Check if error is retryable based on network error patterns
			const isRetryableNetworkError = networkErrorPatterns.some((pattern) => lastError?.message.includes(pattern));
			const isRetryableError = isRetryableStatusError || isRetryableNetworkError;

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			// Exponential backoff: interval doubles each attempt, capped at 60s
			const delayMs = Math.min(baseIntervalMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt), RETRY_MAX_INTERVAL_MS);

			logger.warn("retry.attempt", {
				attempt: attempt + 1,
				maxAttempts,
				delayMs,
				errorName: lastError.name,
				errorMessage: lastError.message,
			});

			console.error(
				`[OAI Compatible Model Provider] Retryable error detected, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts}). Error:`,
				lastError instanceof Error ? { name: lastError.name, message: lastError.message } : String(lastError)
			);

			// Wait for the calculated interval before retrying
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// This should never be reached, but TypeScript needs it
	logger.error("retry.exhausted", {
		maxAttempts,
		lastError: lastError ? { name: lastError.name, message: lastError.message } : String(lastError),
	});
	throw lastError || new Error("Retry failed");
}
