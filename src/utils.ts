import * as vscode from "vscode";
import type {
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIFunctionToolDef,
	OpenAIToolCall,
	ChatMessageContent,
	RetryConfig,
} from "./types";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
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

// Tool calling sanitization helpers

function isIntegerLikePropertyName(propertyName: string | undefined): boolean {
	if (!propertyName) {
		return false;
	}
	const lowered = propertyName.toLowerCase();
	const integerMarkers = [
		"id",
		"limit",
		"count",
		"index",
		"size",
		"offset",
		"length",
		"results_limit",
		"maxresults",
		"debugsessionid",
		"cellid",
	];
	return integerMarkers.some((m) => lowered.includes(m)) || lowered.endsWith("_id");
}

function sanitizeFunctionName(name: unknown): string {
	if (typeof name !== "string" || !name) {
		return "tool";
	}
	let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!/^[a-zA-Z]/.test(sanitized)) {
		sanitized = `tool_${sanitized}`;
	}
	sanitized = sanitized.replace(/_+/g, "_");
	return sanitized.slice(0, 64);
}

function pruneUnknownSchemaKeywords(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return {};
	}
	const allow = new Set([
		"type",
		"properties",
		"required",
		"additionalProperties",
		"description",
		"enum",
		"default",
		"items",
		"minLength",
		"maxLength",
		"minimum",
		"maximum",
		"pattern",
		"format",
	]);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
		if (allow.has(k)) {
			out[k] = v as unknown;
		}
	}
	return out;
}

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { type: "object", properties: {} } as Record<string, unknown>;
	}

	let schema = input as Record<string, unknown>;

	for (const composite of ["anyOf", "oneOf", "allOf"]) {
		const branch = (schema as Record<string, unknown>)[composite] as unknown;
		if (Array.isArray(branch) && branch.length > 0) {
			let preferred: Record<string, unknown> | undefined;
			for (const b of branch) {
				if (b && typeof b === "object" && (b as Record<string, unknown>).type === "string") {
					preferred = b as Record<string, unknown>;
					break;
				}
			}
			schema = { ...(preferred ?? (branch[0] as Record<string, unknown>)) };
			break;
		}
	}

	schema = pruneUnknownSchemaKeywords(schema);

	let t = schema.type as string | undefined;
	if (t == null) {
		t = "object";
		schema.type = t;
	}

	if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
		schema.type = "integer";
		t = "integer";
	}

	if (t === "object") {
		const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
		const newProps: Record<string, unknown> = {};
		if (props && typeof props === "object") {
			for (const [k, v] of Object.entries(props)) {
				newProps[k] = sanitizeSchema(v, k);
			}
		}
		schema.properties = newProps;

		const req = schema.required as unknown;
		if (Array.isArray(req)) {
			schema.required = req.filter((r) => typeof r === "string");
		} else if (req !== undefined) {
			schema.required = [];
		}

		const ap = schema.additionalProperties as unknown;
		if (ap !== undefined && typeof ap !== "boolean") {
			delete schema.additionalProperties;
		}
	} else if (t === "array") {
		const items = schema.items as unknown;
		if (Array.isArray(items) && items.length > 0) {
			schema.items = sanitizeSchema(items[0]);
		} else if (items && typeof items === "object") {
			schema.items = sanitizeSchema(items);
		} else {
			schema.items = { type: "string" } as Record<string, unknown>;
		}
	}

	return schema;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @param modelConfig model configuration that may affect message conversion.
 * @returns OpenAI-compatible messages array.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	modelConfig: { includeReasoningInRequest: boolean }
): OpenAIChatMessage[] {
	const out: OpenAIChatMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m);
		const textParts: string[] = [];
		const imageParts: vscode.LanguageModelDataPart[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];
		const reasoningParts: string[] = [];

		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
				imageParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				let args = "{}";
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, content });
			} else if (part instanceof vscode.LanguageModelThinkingPart) {
				// 处理思考内容
				const content = Array.isArray(part.value) ? part.value.join("") : part.value;
				reasoningParts.push(content);
			}
		}

		// 构建 assistant 消息，包含思考内容
		if (role === "assistant") {
			const assistantMessage: OpenAIChatMessage = {
				role: "assistant",
				content: textParts.join("\n") || undefined,
			};

			// 添加思考内容（根据配置决定是否包含）
			if (modelConfig.includeReasoningInRequest && reasoningParts.length > 0) {
				assistantMessage.reasoning_content = reasoningParts.join("\n");
			}

			// 添加工具调用
			if (toolCalls.length > 0) {
				assistantMessage.tool_calls = toolCalls;
			}

			// 只有当消息有内容、思考内容或工具调用时才添加
			if (assistantMessage.content || assistantMessage.reasoning_content || assistantMessage.tool_calls) {
				out.push(assistantMessage);
			}
		}

		// 处理工具结果
		for (const tr of toolResults) {
			out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
		}

		// 处理用户和系统消息
		if (textParts.length > 0 && role !== "assistant") {
			if (role === "user") {
				if (imageParts.length > 0) {
					// 多模态消息：包含图片、文本
					const contentArray: ChatMessageContent[] = [];
					contentArray.push({
						type: "text",
						text: textParts.join("\n"),
					});

					// 添加图片内容
					for (const imagePart of imageParts) {
						const dataUrl = createDataUrl(imagePart);
						contentArray.push({
							type: "image_url",
							image_url: {
								url: dataUrl,
							},
						});
					}
					out.push({ role, content: contentArray });
				} else {
					// 纯文本消息
					out.push({ role, content: textParts.join("\n") });
				}
			} else if (role === "system") {
				out.push({ role, content: textParts.join("\n") });
			}
		}
	}
	return out;
}

/**
 * 检查是否为图片MIME类型
 */
function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = sanitizeFunctionName(t.name);
			const description = typeof t.description === "string" ? t.description : "";
			const params = sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} });
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
	if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[OAI Compatible Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: sanitizeFunctionName(tools[0].name) } };
	}

	return { tools: toolDefs, tool_choice };
}

/**
 * Validate tool names to ensure they contain only word chars, hyphens, or underscores.
 * @param tools Tools to validate.
 */
export function validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
	for (const tool of tools) {
		if (!tool.name.match(/^[\w-]+$/)) {
			console.error("[OAI Compatible Model Provider] Invalid tool name detected:", tool.name);
			throw new Error(
				`Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`
			);
		}
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
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
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
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
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
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	retryConfig: RetryConfig,
	token: vscode.CancellationToken
): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const intervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		// Check for cancellation before each attempt
		if (token.isCancellationRequested) {
			throw new Error("Request was cancelled");
		}

		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableError = RETRYABLE_STATUS_CODES.some((code) => lastError?.message.includes(`[${code}]`));

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			console.warn(
				`[OAI Compatible Model Provider] Retryable error detected, retrying in ${intervalMs}ms (attempt ${attempt}/${maxAttempts})`
			);

			// Wait for the specified interval before retrying
			await new Promise<void>((resolve) => {
				let isResolved = false;
				const cleanup = () => {
					if (!isResolved) {
						cancellationListener.dispose();
						isResolved = true;
					}
				};
				const timeout = setTimeout(() => {
					cleanup();
					resolve();
				}, intervalMs);

				const cancellationListener = token.onCancellationRequested(() => {
					clearTimeout(timeout);
					cleanup();
					resolve();
				});
			});

			// Check if we were cancelled during the wait
			if (token.isCancellationRequested) {
				throw new Error("Request was cancelled");
			}
		}
	}

	// This should never be reached, but TypeScript needs it
	throw lastError || new Error("Retry failed");
}
