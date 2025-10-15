import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatRequestMessage } from "vscode";

/**
 * Returns the number of tokens for a given text using the model specific tokenizer logic
 * @param model The language model to use
 * @param text The text to count tokens for
 * @param token A cancellation token for the request
 * @returns A promise that resolves to the number of tokens
 */
export async function prepareTokenCount(
	model: LanguageModelChatInformation,
	text: string | LanguageModelChatRequestMessage,
	_token: CancellationToken
): Promise<number> {
	if (typeof text === "string") {
		// Estimate tokens directly for plain text
		return estimateTextTokens(text);
	} else {
		// For complex messages, calculate tokens for each part separately
		let totalTokens = 0;

		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				// Estimate tokens directly for plain text
				totalTokens += estimateTextTokens(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				// Estimate tokens for image or data parts based on type
				if (part.mimeType.startsWith("image/")) {
					// Images are approximately 170 tokens
					totalTokens += 170;
				} else {
					// For other binary data, use a more conservative estimate
					totalTokens += Math.ceil(part.data.length / 4);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				// Tool call token calculation
				const toolCallText = `${part.name}(${JSON.stringify(part.input)})`;
				totalTokens += estimateTextTokens(toolCallText);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				// Tool result token calculation
				const resultText = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
				totalTokens += estimateTextTokens(resultText);
			}
		}

		// Add fixed overhead for roles and structure
		totalTokens += 4;

		return totalTokens;
	}
}

/** Roughly estimate tokens for VS Code chat messages (text only) */
export function estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let total = 0;
	for (const m of msgs) {
		for (const part of m.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += estimateTextTokens(part.value);
			}
		}
	}
	return total;
}

/** 针对不同内容类型的 token 估算 */
export function estimateTextTokens(text: string): number {
	const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
	const englishWords = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
	const symbols = text.length - chineseChars - englishWords;

	// 中文字符约1.5个token，英文单词约1个token，符号约0.5个token
	return Math.ceil(chineseChars * 1.5 + englishWords + symbols * 0.5);
}

/** Rough token estimate for tool definitions by JSON size */
export function estimateToolTokens(
	tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
): number {
	if (!tools || tools.length === 0) {
		return 0;
	}
	try {
		const json = JSON.stringify(tools);
		return Math.ceil(json.length / 4);
	} catch {
		return 0;
	}
}
