import type * as vscode from "vscode";
import type { HFModelItem } from "./types";
import { I18N } from "./i18n";

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
			title: I18N.reasoningEffort(),
			enum: REASONING_EFFORT_VALUES,
			enumItemLabels: [I18N.reasoningEffortMinimal(), I18N.reasoningEffortLow(), I18N.reasoningEffortMedium(), I18N.reasoningEffortHigh(), I18N.reasoningEffortXHigh(), I18N.reasoningEffortMax()],
			enumDescriptions: [
				I18N.reasoningEffortDescMinimal(),
				I18N.reasoningEffortDescLow(),
				I18N.reasoningEffortDescMedium(),
				I18N.reasoningEffortDescHigh(),
				I18N.reasoningEffortDescXHigh(),
				I18N.reasoningEffortDescMax(),
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
