import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatProvider,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";

import type { HFModelItem, HFModelsResponse } from "./types";

import { convertTools, convertMessages, tryParseJSONObject, validateRequest } from "./utils";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOOLS_PER_REQUEST = 128;

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	private _chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];
	/** Buffer for assembling streamed tool calls by index. */
	private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	private _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	private _hasEmittedAssistantText = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	private _emittedBeginToolCallsHint = false;

	// Lightweight tokenizer state for tool calls embedded in text
	private _textToolParserBuffer = "";
	private _textToolActive:
		| undefined
		| {
			name?: string;
			index?: number;
			argBuffer: string;
			emitted?: boolean;
		};
	private _emittedTextToolCallKeys = new Set<string>();
	private _emittedTextToolCallIds = new Set<string>();

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(private readonly secrets: vscode.SecretStorage, private readonly userAgent: string) { }

	/** Roughly estimate tokens for VS Code chat messages (text only) */
	private estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += this.estimateTextTokens(part.value);
				}
			}
		}
		return total;
	}

	/** 针对不同内容类型的 token 估算 */
	private estimateTextTokens(text: string): number {
		const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
		const englishWords = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
		const symbols = text.length - chineseChars - englishWords;

		// 中文字符约1.5个token，英文单词约1个token，符号约0.5个token
		return Math.ceil(chineseChars * 1.5 + englishWords + symbols * 0.5);
	}

	/** Rough token estimate for tool definitions by JSON size */
	private estimateToolTokens(tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined): number {
		if (!tools || tools.length === 0) { return 0; }
		try {
			const json = JSON.stringify(tools);
			return Math.ceil(json.length / 4);
		} catch {
			return 0;
		}
	}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const apiKey = await this.ensureApiKey(options.silent);
		if (!apiKey) {
			return [];
		}

		// Check for user-configured models first
		const config = vscode.workspace.getConfiguration();
		const userModels = config.get<HFModelItem[]>('oaicopilot.models', []);

		let infos: LanguageModelChatInformation[];
		if (userModels && userModels.length > 0) {
			// Return user-provided models directly
			infos = userModels.map((m) => {
				const contextLen = m?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = m?.max_tokens ?? DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				return {
					id: `${m.id}`,
					name: `${m.id} via ${m.owned_by}`,
					tooltip: `OAI Compatible via ${m.owned_by}`,
					family: "oai-compatible",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: m?.vision ?? false,
					},
				} satisfies LanguageModelChatInformation;
			});
		} else {
			// Fallback: Fetch models from Hugging Face API
			const { models } = await this.fetchModels(apiKey);

			infos = models.flatMap((m) => {
				const providers = m?.providers ?? [];
				const modalities = m.architecture?.input_modalities ?? [];
				const vision = Array.isArray(modalities) && modalities.includes("image");

				// Build entries for all providers that support tool calling
				const toolProviders = providers.filter((p) => p.supports_tools === true);
				const entries: LanguageModelChatInformation[] = [];

				for (const p of toolProviders) {
					const contextLen = p?.context_length ?? DEFAULT_CONTEXT_LENGTH;
					const maxOutput = DEFAULT_MAX_TOKENS;
					const maxInput = Math.max(1, contextLen - maxOutput);
					entries.push({
						id: `${m.id}:${p.provider}`,
						name: `${m.id} via ${p.provider}`,
						tooltip: `OAI Compatible via ${p.provider}`,
						family: "oai-compatible",
						version: "1.0.0",
						maxInputTokens: maxInput,
						maxOutputTokens: maxOutput,
						capabilities: {
							toolCalling: true,
							imageInput: vision,
						},
					} satisfies LanguageModelChatInformation);
				}

				if (entries.length === 0) {
					const base = providers.length > 0 ? providers[0] : null;
					const contextLen = base?.context_length ?? DEFAULT_CONTEXT_LENGTH;
					const maxOutput = DEFAULT_MAX_TOKENS;
					const maxInput = Math.max(1, contextLen - maxOutput);
					entries.push({
						id: `${m.id}`,
						name: `${m.id} via OAI Compatible`,
						tooltip: "OAI Compatible",
						family: "oai-compatible",
						version: "1.0.0",
						maxInputTokens: maxInput,
						maxOutputTokens: maxOutput,
						capabilities: {
							toolCalling: true,
							imageInput: true,
						},
					} satisfies LanguageModelChatInformation);
				}

				return entries;
			});
		}

		this._chatEndpoints = infos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		return infos;
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
	}

	/**
	 * Fetch the list of models and supplementary metadata from Hugging Face.
	 * @param apiKey The HF API key used to authenticate.
	 */
	private async fetchModels(
		apiKey: string
	): Promise<{ models: HFModelItem[] }> {
		const config = vscode.workspace.getConfiguration();
		const BASE_URL = config.get<string>('oaicopilot.baseUrl', "");
		const modelsList = (async () => {
			const resp = await fetch(`${BASE_URL}/models`, {
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": this.userAgent },
			});
			if (!resp.ok) {
				let text = "";
				try {
					text = await resp.text();
				} catch (error) {
					console.error("[OAI Compatible Model Provider] Failed to read response text", error);
				}
				const err = new Error(
					`Failed to fetch OAI Compatible models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
				);
				console.error("[OAI Compatible Model Provider] Failed to fetch OAI Compatible models", err);
				throw err;
			}
			const parsed = (await resp.json()) as HFModelsResponse;
			return parsed.data ?? [];
		})();

		try {
			const models = await modelsList;
			return { models };
		} catch (err) {
			console.error("[OAI Compatible Model Provider] Failed to fetch OAI Compatible models", err);
			throw err;
		}
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {

		this._toolCallBuffers.clear();
		this._completedToolCallIndices.clear();
		this._hasEmittedAssistantText = false;
		this._emittedBeginToolCallsHint = false;
		this._textToolParserBuffer = "";
		this._textToolActive = undefined;
		this._emittedTextToolCallKeys.clear();
		this._emittedTextToolCallIds.clear();


		let requestBody: Record<string, unknown> | undefined;
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[OAI Compatible Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		try {
			const apiKey = await this.ensureApiKey(true);
			if (!apiKey) {
				throw new Error("OAI Compatible API key not found");
			}
			if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
				throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
			}

			const openaiMessages = convertMessages(messages);
			validateRequest(messages);

			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = config.get<HFModelItem[]>('oaicopilot.models', []);
			const um = userModels.find((um) => um.id === model.id);

			// 配置 temperature
			const oTemperature = options.modelOptions?.temperature ?? 0;
			const temperature = um?.temperature ?? oTemperature;

			// 配置 top_p
			const oTopP = options.modelOptions?.top_p ?? 1;
			const topP = um?.top_p ?? oTopP;

			// 配置 max_tokens
			const oMaxTokens = options.modelOptions?.max_tokens ?? DEFAULT_MAX_TOKENS;
			const maxTokens = um?.max_tokens ?? oMaxTokens;

			// 配置 requestBody
			requestBody = {
				model: model.id,
				messages: openaiMessages,
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: maxTokens,
				temperature: temperature,
				top_p: topP
			};

			// 配置 enable_thinking
			const enableThinking = um?.enable_thinking ?? false;
			if (enableThinking) {
				(requestBody as Record<string, unknown>).enable_thinking = enableThinking;
			}

			// 配置 stop
			if (options.modelOptions) {
				const mo = options.modelOptions as Record<string, unknown>;
				if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
					(requestBody as Record<string, unknown>).stop = mo.stop;
				}
			}

			// 配置 tools
			const toolConfig = convertTools(options);
			if (toolConfig.tools) {
				(requestBody as Record<string, unknown>).tools = toolConfig.tools;
			}
			if (toolConfig.tool_choice) {
				(requestBody as Record<string, unknown>).tool_choice = toolConfig.tool_choice;
			}

			// 配置 用户定义其他参数
			if (um?.top_k !== undefined) {
				(requestBody as Record<string, unknown>).top_k = um.top_k;
			}
			if (um?.min_p !== undefined) {
				(requestBody as Record<string, unknown>).min_p = um.min_p;
			}
			if (um?.frequency_penalty !== undefined) {
				(requestBody as Record<string, unknown>).frequency_penalty = um.frequency_penalty;
			}
			if (um?.presence_penalty !== undefined) {
				(requestBody as Record<string, unknown>).presence_penalty = um.presence_penalty;
			}
			if (um?.repetition_penalty !== undefined) {
				(requestBody as Record<string, unknown>).repetition_penalty = um.repetition_penalty;
			}

			// 发送请求
			const BASE_URL = config.get<string>('oaicopilot.baseUrl', "");
			const response = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"User-Agent": this.userAgent,
				},
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error("[OAI Compatible Model Provider] OAI Compatible API error response", errorText);
				throw new Error(
					`OAI Compatible API error: ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`
				);
			}

			if (!response.body) {
				throw new Error("No response body from OAI Compatible API");
			}
			await this.processStreamingResponse(response.body, trackingProgress, token);
		} catch (err) {
			console.error("[OAI Compatible Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			throw err;
		}
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === 'string') {
			// 纯文本直接估算token
			return this.estimateTextTokens(text);
		} else {
			// 对于复杂消息，分别计算各部分的token
			let totalTokens = 0;

			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					// 纯文本部分直接估算token
					totalTokens += this.estimateTextTokens(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					// 图片或数据部分根据类型估算token
					if (part.mimeType.startsWith('image/')) {
						// 图片大约170个token
						totalTokens += 170;
					} else {
						// 对于其他二进制数据，使用更保守的估算
						totalTokens += Math.ceil(part.data.length / 4);
					}
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					// 工具调用的token计算
					const toolCallText = `${part.name}(${JSON.stringify(part.input)})`;
					totalTokens += this.estimateTextTokens(toolCallText);
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					// 工具结果的token计算
					const resultText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
					totalTokens += this.estimateTextTokens(resultText);
				}
			}

			// 添加角色和结构的固定开销
			totalTokens += 4;

			return totalTokens;
		}
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param silent If true, do not prompt the user.
	 */
	private async ensureApiKey(silent: boolean): Promise<string | undefined> {
		let apiKey = await this.secrets.get("oaicopilot.apiKey");
		if (!apiKey && !silent) {
			const entered = await vscode.window.showInputBox({
				title: "OAI Compatible API Key",
				prompt: "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("oaicopilot.apiKey", apiKey);
			}
		}
		return apiKey;
	}

	/**
	 * Read and parse the HF Router streaming (SSE-like) response and report parts.
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	private async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6);
					if (data === "[DONE]") {
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						// Flush any in-progress text-embedded tool call (silent if incomplete)
						await this.flushActiveTextToolCall(progress);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						await this.processDelta(parsed, progress);
					} catch {
						// Silently ignore malformed SSE lines temporarily
					}
				}
			}
		} finally {
			reader.releaseLock();
			// Clean up any leftover tool call state
			this._toolCallBuffers.clear();
			this._completedToolCallIndices.clear();
			this._hasEmittedAssistantText = false;
			this._emittedBeginToolCallsHint = false;
			this._textToolParserBuffer = "";
			this._textToolActive = undefined;
			this._emittedTextToolCallKeys.clear();
		}
	}

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param delta Parsed SSE chunk from the Router.
	 * @param progress Progress reporter for parts.
	 */
	private async processDelta(
		delta: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): Promise<boolean> {
		let emitted = false;
		const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) { return false; }

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		// report thinking progress if backend provides it and host supports it
		try {
			const maybeThinking = (choice as Record<string, unknown> | undefined)?.thinking ?? (deltaObj as Record<string, unknown> | undefined)?.thinking;
			if (maybeThinking !== undefined) {
				const vsAny = (vscode as unknown as Record<string, unknown>);
				const ThinkingCtor = vsAny["LanguageModelThinkingPart"] as
					| (new (text: string, id?: string, metadata?: unknown) => unknown)
					| undefined;
				if (ThinkingCtor) {
					let text = "";
					let id: string | undefined;
					let metadata: unknown;
					if (maybeThinking && typeof maybeThinking === "object") {
						const mt = maybeThinking as Record<string, unknown>;
						text = typeof mt["text"] === "string" ? (mt["text"] as string) : "";
						id = typeof mt["id"] === "string" ? (mt["id"] as string) : undefined;
						metadata = mt["metadata"];
					} else if (typeof maybeThinking === "string") {
						text = maybeThinking;
					}
					if (text) {
						progress.report(new (ThinkingCtor as new (text: string, id?: string, metadata?: unknown) => unknown)(text, id, metadata) as unknown as vscode.LanguageModelResponsePart);
						emitted = true;
					}
				}
			}
		} catch {
			// ignore errors here temporarily
		}
		if (deltaObj?.content) {
			const content = String(deltaObj.content);
			const res = this.processTextContent(content, progress);
			if (res.emittedText) {
				this._hasEmittedAssistantText = true;
			}
			if (res.emittedAny) {
				emitted = true;
			}
		}

		if (deltaObj?.tool_calls) {
			const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

			// SSEProcessor-like: if first tool call appears after text, emit a whitespace
			// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
			if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				const idx = (tc.index as number) ?? 0;
				// Ignore any further deltas for an index we've already completed
				if (this._completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (tc.id && typeof tc.id === "string") {
					buf.id = tc.id as string;
				}
				const func = tc.function as Record<string, unknown> | undefined;
				if (func?.name && typeof func.name === "string") {
					buf.name = func.name as string;
				}
				if (typeof func?.arguments === "string") {
					buf.args += func.arguments as string;
				}
				this._toolCallBuffers.set(idx, buf);

				// Emit immediately once arguments become valid JSON to avoid perceived hanging
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = (choice.finish_reason as string | undefined) ?? undefined;
		if (finish === "tool_calls" || finish === "stop") {
			// On both 'tool_calls' and 'stop', emit any buffered calls and throw on invalid JSON
			await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ true);
		}
		return emitted;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	private processTextContent(
		input: string,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): { emittedText: boolean; emittedAny: boolean } {
		const BEGIN = "<|tool_call_begin|>";
		const ARG_BEGIN = "<|tool_call_argument_begin|>";
		const END = "<|tool_call_end|>";

		let data = this._textToolParserBuffer + input;
		let emittedText = false;
		let emittedAny = false;
		let visibleOut = "";

		while (data.length > 0) {
			if (!this._textToolActive) {
				const b = data.indexOf(BEGIN);
				if (b === -1) {
					// No tool-call start: emit visible portion, but keep any partial BEGIN prefix as buffer
					const longestPartialPrefix = ((): number => {
						for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
							if (data.endsWith(BEGIN.slice(0, k))) { return k; }
						}
						return 0;
					})();
					if (longestPartialPrefix > 0) {
						const visible = data.slice(0, data.length - longestPartialPrefix);
						if (visible) { visibleOut += this.stripControlTokens(visible); }
						this._textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
						data = "";
						break;
					} else {
						// All visible, clean other control tokens
						visibleOut += this.stripControlTokens(data);
						data = "";
						break;
					}
				}
				// Emit text before the token
				const pre = data.slice(0, b);
				if (pre) {
					visibleOut += this.stripControlTokens(pre);
				}
				// Advance past BEGIN
				data = data.slice(b + BEGIN.length);

				// Find the delimiter that ends the name/index segment
				const a = data.indexOf(ARG_BEGIN);
				const e = data.indexOf(END);
				let delimIdx = -1;
				let delimKind: "arg" | "end" | undefined = undefined;
				if (a !== -1 && (e === -1 || a < e)) { delimIdx = a; delimKind = "arg"; }
				else if (e !== -1) { delimIdx = e; delimKind = "end"; }
				else {
					// Incomplete header; keep for next chunk (re-add BEGIN so we don't lose it)
					this._textToolParserBuffer = BEGIN + data;
					data = "";
					break;
				}

				const header = data.slice(0, delimIdx).trim();
				const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
				const name = m?.[1] ?? undefined;
				const index = m?.[2] ? Number(m?.[2]) : undefined;
				this._textToolActive = { name, index, argBuffer: "", emitted: false };
				// Advance past delimiter token
				if (delimKind === "arg") {
					data = data.slice(delimIdx + ARG_BEGIN.length);
				} else /* end */ {
					// No args, finalize immediately
					data = data.slice(delimIdx + END.length);
					const did = this.emitTextToolCallIfValid(progress, this._textToolActive, "{}");
					if (did) {
						this._textToolActive.emitted = true;
						emittedAny = true;
					}
					this._textToolActive = undefined;
				}
				continue;
			}

			// We are inside arguments, collect until END and emit as soon as JSON becomes valid
			const e2 = data.indexOf(END);
			if (e2 === -1) {
				// No end marker yet, accumulate and check for early valid JSON
				this._textToolActive.argBuffer += data;
				// Early emit when JSON becomes valid and we haven't emitted yet
				if (!this._textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
					if (did) {
						this._textToolActive.emitted = true;
						emittedAny = true;
					}
				}
				data = "";
				break;
			} else {
				this._textToolActive.argBuffer += data.slice(0, e2);
				// Consume END
				data = data.slice(e2 + END.length);
				// Final attempt to emit if not already
				if (!this._textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
					if (did) {
						emittedAny = true;
					}
				}
				this._textToolActive = undefined;
				continue;
			}
		}

		// Emit any visible text
		const textToEmit = visibleOut;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedText = true;
			emittedAny = true;
		}

		// Store leftover for next chunk
		this._textToolParserBuffer = data;

		return { emittedText, emittedAny };
	}

	private emitTextToolCallIfValid(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
		argText: string,
	): boolean {
		const name = call.name ?? "unknown_tool";
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return false;
		}
		const canonical = JSON.stringify(parsed.value);
		const key = `${name}:${canonical}`;
		// identity-based dedupe when index is present
		if (typeof call.index === "number") {
			const idKey = `${name}:${call.index}`;
			if (this._emittedTextToolCallIds.has(idKey)) {
				return false;
			}
			// Mark identity as emitted
			this._emittedTextToolCallIds.add(idKey);
		} else if (this._emittedTextToolCallKeys.has(key)) {
			return false;
		}
		this._emittedTextToolCallKeys.add(key);
		const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
		progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
		return true;
	}

	private async flushActiveTextToolCall(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): Promise<void> {
		if (!this._textToolActive) {
			return;
		}
		const argText = this._textToolActive.argBuffer;
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return;
		}
		// Emit (dedupe ensures we don't double-emit)
		this.emitTextToolCallIfValid(progress, this._textToolActive, argText);
		this._textToolActive = undefined;
	}

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	private async tryEmitBufferedToolCall(
		index: number,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const parameters = canParse.value;
		try {
			const canonical = JSON.stringify(parameters);
			this._emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
		} catch { /* ignore */ }
		progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	private async flushToolCallBuffers(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		throwOnInvalid: boolean,
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", { idx, snippet: (buf.args || "").slice(0, 200) });
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			try {
				const canonical = JSON.stringify(parsed.value);
				this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
			} catch { /* ignore */ }
			progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	/** Strip provider control tokens like <|tool_calls_section_begin|> and <|tool_call_begin|> from streamed text. */
	private stripControlTokens(text: string): string {
		try {
			// Remove section markers and explicit tool call begin/argument/end markers that some backends stream as text
			return text
				.replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
				.replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
		} catch {
			return text;
		}
	}

}
