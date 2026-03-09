import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatRequestMessage } from "vscode";
import { getTokenizer } from "./tokenizer/tokenizerManager";
import { getImageDimensions } from "./tokenizer/imageUtils";
import { createDataUrl } from "./utils";

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
	_token: CancellationToken,
	modelConfig: { includeReasoningInRequest: boolean }
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
				totalTokens += await estimateTextTokens(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				// Estimate tokens for image or data parts based on type
				if (part.mimeType.startsWith("image/")) {
					totalTokens += calculateImageTokenCost(createDataUrl(part));
				} else if (part.mimeType === "cache_control") {
					/* ignore */
				} else {
					// For other binary data, use a more conservative estimate
					totalTokens += Math.ceil(part.data.length / 4);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				// Tool call token calculation
				const toolCallText = `${part.name}(${JSON.stringify(part.input)})`;
				totalTokens += await estimateTextTokens(toolCallText);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				// Tool result token calculation
				const resultText = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
				totalTokens += await estimateTextTokens(resultText);
			} else if (part instanceof vscode.LanguageModelThinkingPart) {
				// Thinking Token
				if (modelConfig.includeReasoningInRequest) {
					const thinkingText = Array.isArray(part.value) ? part.value.join("") : part.value;
					totalTokens += await estimateTextTokens(thinkingText);
				}
			}
		}

		// Add fixed overhead for roles and structure
		totalTokens += 4;

		return totalTokens;
	}
}

/**
 * Count tokens using real tokenizer
 */
export async function estimateTextTokens(text: string): Promise<number> {
	return getTokenizer.countTokens(text);
}

// https://platform.openai.com/docs/guides/vision#calculating-costs
export function calculateImageTokenCost(imageUrl: string): number {
	let { width, height } = getImageDimensions(imageUrl);

	// Scale image to fit within a 2048 x 2048 square if necessary.
	if (width > 2048 || height > 2048) {
		const scaleFactor = 2048 / Math.max(width, height);
		width = Math.round(width * scaleFactor);
		height = Math.round(height * scaleFactor);
	}

	const scaleFactor = 768 / Math.min(width, height);
	width = Math.round(width * scaleFactor);
	height = Math.round(height * scaleFactor);

	const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);

	return tiles * 170 + 85;
}
