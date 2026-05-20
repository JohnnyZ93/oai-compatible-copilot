import type * as vscode from "vscode";
import type { HFModelItem } from "./types";

export type ReasoningEffortPickerValue = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES: readonly ReasoningEffortPickerValue[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const REASONING_EFFORT_CONFIGURATION_SCHEMA = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			enum: REASONING_EFFORT_VALUES,
			enumItemLabels: ["Minimal", "Low", "Medium", "High", "XHigh", "Max"],
			enumDescriptions: [
				"Smallest reasoning budget",
				"Low reasoning budget",
				"Balanced reasoning budget",
				"High reasoning budget",
				"Very high reasoning budget",
				"Maximum reasoning budget",
			],
			default: "medium",
			group: "navigation",
		},
	},
} as const;

export function createReasoningEffortConfigurationSchema(defaultValue: ReasoningEffortPickerValue) {
	return {
		properties: {
			reasoningEffort: {
				...REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort,
				default: defaultValue,
			},
		},
	} as const;
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable?: boolean;
	readonly detail?: string;
	readonly tooltip?: string;
	readonly configurationSchema?: ReturnType<typeof createReasoningEffortConfigurationSchema>;
};

export function isReasoningEffortPickerEnabled(
	model: HFModelItem | undefined
): model is HFModelItem & { reasoning_effort: ReasoningEffortPickerValue } {
	return isReasoningEffortValue(model?.reasoning_effort);
}

export function isOpenRouterReasoningEffortPickerEnabled(
	model: HFModelItem | undefined
): boolean {
	const reasoningConfig = model?.reasoning as { effort?: unknown } | undefined;
	return isReasoningEffortValue(reasoningConfig?.effort);
}

export function getConfiguredReasoningEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined,
	fallback: ReasoningEffortPickerValue = "medium"
): ReasoningEffortPickerValue {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configuredEffort =
		modelOptions?.modelConfiguration?.reasoningEffort ?? modelOptions?.configuration?.reasoningEffort;

	if (isReasoningEffortValue(configuredEffort)) {
		return configuredEffort;
	}
	return fallback;
}

export function isReasoningEffortValue(value: unknown): value is ReasoningEffortPickerValue {
	return typeof value === "string" && REASONING_EFFORT_VALUES.includes(value as ReasoningEffortPickerValue);
}
