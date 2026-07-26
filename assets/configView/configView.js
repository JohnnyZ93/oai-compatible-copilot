const vscode = acquireVsCodeApi();
const state = {
	baseUrl: "",
	apiKey: "",
	delay: 0,
	readFileLines: 0,
	tokenUsageEnabled: false,
	retry: { enabled: true, max_attempts: 3, interval_ms: 1000, status_codes: [429, 500, 502, 503, 504] },
	commitModel: "",
	models: [],
	providerKeys: {},
	providerInfo: {},
};

// ===================== i18n 翻译表 =====================
// 从 HTML lang 属性读取语言设置（由 VS Code 端根据 vscode.env.language 注入）
const LOCALE = (() => {
	const lang = (document.documentElement.getAttribute("lang") || "en").toLowerCase();
	return lang.startsWith("zh") ? "zh" : "en";
})();

const Texts = {
	// 标题和通用
	title: { en: "OAI Copilot Configuration", zh: "OAICopilot 配置" },
	export: { en: "Export", zh: "导出" },
	import: { en: "Import", zh: "导入" },
	refresh: { en: "Refresh", zh: "刷新" },
	cancel: { en: "Cancel", zh: "取消" },
	save: { en: "Save", zh: "保存" },
	delete: { en: "Delete", zh: "删除" },
	edit: { en: "Edit", zh: "编辑" },
	none: { en: "None", zh: "无" },
	true: { en: "True", zh: "是" },
	false: { en: "False", zh: "否" },
	enabled: { en: "Enabled", zh: "启用" },
	disabled: { en: "Disabled", zh: "禁用" },
	actions: { en: "Actions", zh: "操作" },
	baseUrl: { en: "Base URL", zh: "基础 URL" },
	apiKey: { en: "API Key", zh: "API 密钥" },
	apiMode: { en: "API Mode", zh: "API 模式" },
	customHeaders: { en: "Custom Headers (JSON)", zh: "自定义请求头 (JSON)" },
	providerId: { en: "Provider ID", zh: "提供商 ID" },
	selectProvider: { en: "Select Provider", zh: "选择提供商" },
	addProvider: { en: "Add Provider", zh: "添加提供商" },
	modelId: { en: "Model ID", zh: "模型 ID" },
	displayName: { en: "Display Name", zh: "显示名称" },
	configId: { en: "Config ID", zh: "配置 ID" },
	contextLength: { en: "Context Length", zh: "上下文长度" },
	maxTokens: { en: "Max Tokens", zh: "最大 Token 数" },
	supportsVision: { en: "Supports Vision", zh: "支持视觉" },
	temperature: { en: "Temperature", zh: "温度" },
	topP: { en: "TopP", zh: "TopP" },
	delayMs: { en: "Delay (ms)", zh: "延迟 (毫秒)" },
	noData: { en: "No data", zh: "暂无数据" },
	noProviders: { en: "No providers", zh: "暂无提供商" },
	noModels: { en: "No models", zh: "暂无模型" },
	saveModel: { en: "Save Model", zh: "保存模型" },
	addModel: { en: "Add Model", zh: "添加模型" },
	addNewModel: { en: "Add New Model", zh: "添加新模型" },
	selectModel: { en: (count) => `Select Model (${count} available)`, zh: (count) => `选择模型（${count} 个可用）` },
	// 全局配置
	globalConfig: { en: "Global Configuration", zh: "全局配置" },
	globalBaseUrl: { en: "Global Base URL", zh: "全局基础 URL" },
	globalBaseUrlDesc: { en: "The base URL for the Openai Compatible Inference API.", zh: "OpenAI 兼容推理 API 的基础 URL。" },
	globalApiKey: { en: "Global API Key", zh: "全局 API 密钥" },
	globalApiKeyDesc: { en: "The API Key for Authentication.", zh: "用于身份验证的 API 密钥。" },
	delayMsDesc: { en: "Fixed delay in milliseconds between consecutive requests.", zh: "连续请求之间的固定请求间隔（毫秒）。" },
	readFileLines: { en: "Read File Lines", zh: "读取文件行数" },
	readFileLinesDesc: { en: "Number of lines to read when using read_file tool. Default is 0, let model decide lines.", zh: "使用 read_file 工具时读取的行数。默认为 0，由模型自行决定行数。" },
	tokenUsageEnabled: { en: "Enable Token Usage Tracking", zh: "启用 Token 消耗追踪" },
	tokenUsageEnabledDesc: { en: "Track daily and cumulative token consumption per provider. Default is false.", zh: "按供应商追踪每日和累计 Token 消耗。默认为关闭。" },
	saveGlobalConfig: { en: "Save Global Configuration", zh: "保存全局配置" },
	// 重试配置
	retryConfig: { en: "Retry Configuration", zh: "重试配置" },
	enableRetry: { en: "Enable Retry", zh: "启用重试" },
	enableRetryDesc: { en: "Enable retry mechanism for api errors.", zh: "启用 API 错误重试机制。" },
	maxAttempts: { en: "Max Attempts", zh: "最大尝试次数" },
	maxAttemptsDesc: { en: "Maximum number of retry attempts.", zh: "最大重试次数。" },
	retryInterval: { en: "Retry Interval (ms)", zh: "重试间隔 (毫秒)" },
	retryIntervalDesc: { en: "Interval between retry attempts in milliseconds.", zh: "重试之间的间隔（毫秒）。" },
	retryStatusCodes: { en: "Retry Status Codes (comma separated)", zh: "重试状态码（逗号分隔）" },
	retryStatusCodesDesc: { en: "Additional HTTP status codes that will be merged.", zh: "额外合并的 HTTP 状态码。" },
	// Git 提交
	gitCommitMsg: { en: "Git Commit Message", zh: "Git 提交信息" },
	gitCommitModel: { en: "Git Commit Model", zh: "Git 提交模型" },
	gitCommitModelDesc: { en: "Select the model to be used for Git commit message generation.", zh: "选择用于生成 Git 提交信息的模型。" },
	commitLanguage: { en: "Commit Language", zh: "提交语言" },
	commitLanguageDesc: { en: "Language for generated Git commit messages.", zh: "生成的 Git 提交信息的语言。" },
	// 提供商管理
	providerMgmt: { en: "Provider Management", zh: "提供商管理" },
	// 模型管理
	modelMgmt: { en: "Model Management", zh: "模型管理" },
	// 表格列标题
	thProviderId: { en: "Provider ID", zh: "提供商 ID" },
	thBaseUrl: { en: "Base URL", zh: "基础 URL" },
	thApiKey: { en: "API Key", zh: "API 密钥" },
	thApiMode: { en: "API Mode", zh: "API 模式" },
	thCustomHeaders: { en: "Custom Headers (JSON)", zh: "自定义请求头 (JSON)" },
	thActions: { en: "Actions", zh: "操作" },
	thModelId: { en: "Model ID", zh: "模型 ID" },
	thDisplayName: { en: "Display Name", zh: "显示名称" },
	thConfigId: { en: "Config ID", zh: "配置 ID" },
	thContextLength: { en: "Context Length", zh: "上下文长度" },
	thMaxTokens: { en: "Max Tokens", zh: "最大 Token 数" },
	thSupportsVision: { en: "Supports Vision", zh: "支持视觉" },
	thTemperature: { en: "Temperature", zh: "温度" },
	thTopP: { en: "TopP", zh: "TopP" },
	thDelayMs: { en: "Delay (ms)", zh: "延迟 (毫秒)" },
	// 模型表单
	modelProvider: { en: "Provider ID *", zh: "提供商 ID *" },
	modelProviderDesc: { en: "The provider that serves this model.", zh: "提供此模型的供应商。" },
	modelVision: { en: "Supports Vision", zh: "支持视觉" },
	modelVisionDesc: { en: "Whether the model supports image input.", zh: "模型是否支持图像输入。" },
	defaultFalse: { en: "Default (False)", zh: "默认（否）" },
	optTrue: { en: "True", zh: "是" },
	optFalse: { en: "False", zh: "否" },
	optEmpty: { en: "Default", zh: "默认" },
	modelApiMode: { en: "API Mode", zh: "API 模式" },
	modelApiModeDesc: { en: "API endpoint format for the provider.", zh: "提供商的 API 端点格式。" },
	modelIdInput: { en: "Model ID *", zh: "模型 ID *" },
	modelIdInputDesc: { en: "Model ID (e.g., gpt-4, claude-3).", zh: "模型 ID（如 gpt-4, claude-3）。" },
	modelConfigId: { en: "Config ID", zh: "配置 ID" },
	modelConfigIdDesc: { en: "Configuration ID for this model.", zh: "此模型的配置 ID。" },
	modelBaseUrl: { en: "Base URL", zh: "基础 URL" },
	modelBaseUrlDesc: { en: "Base URL for the model provider.", zh: "模型提供商的基础 URL。" },
	modelContextLength: { en: "Context Length", zh: "上下文长度" },
	modelContextLengthDesc: { en: "Maximum context length.", zh: "最大上下文长度。" },
	modelMaxTokens: { en: "Max Tokens", zh: "最大 Token 数" },
	modelMaxTokensDesc: { en: "Maximum number of tokens to generate.", zh: "最大生成 Token 数。" },
	modelMaxCompletionTokens: { en: "Max Completion Tokens", zh: "最大完成 Token 数" },
	modelMaxCompletionTokensDesc: { en: "Maximum output tokens (OpenAI new standard).", zh: "最大输出 Token 数（OpenAI 新标准）。" },
	modelTemperature: { en: "Temperature", zh: "温度" },
	modelTemperatureDesc: { en: "Sampling temperature (range: [0, 2]). Default is 0.", zh: "采样温度（范围：[0, 2]），默认为 0。" },
	modelTopP: { en: "Top P", zh: "Top P" },
	modelTopPDesc: { en: "Top-p sampling value (range: (0, 1]).", zh: "Top-p 采样值（范围：(0, 1]）。" },
	modelDelay: { en: "Delay (ms)", zh: "延迟 (毫秒)" },
	modelDelayDesc: { en: "Model-specific delay in milliseconds between consecutive requests.", zh: "模型特定的连续请求间隔（毫秒）。" },
	// 高级设置
	showAdvanced: { en: "Show Advanced Settings", zh: "显示高级设置" },
	hideAdvanced: { en: "Hide Advanced Settings", zh: "隐藏高级设置" },
	formDisplayName: { en: "Display Name", zh: "显示名称" },
	formDisplayNameDesc: { en: "Display name for the model.", zh: "模型的显示名称。" },
	modelFamily: { en: "Model Family", zh: "模型系列" },
	modelFamilyDesc: { en: "Model family for specific optimizations.", zh: "用于特定优化的模型系列。" },
	modelTopK: { en: "Top K", zh: "Top K" },
	modelTopKDesc: { en: "Top-k sampling value.", zh: "Top-k 采样值。" },
	modelMinP: { en: "Min P", zh: "Min P" },
	modelMinPDesc: { en: "Minimum probability threshold (range: [0, 1]).", zh: "最小概率阈值（范围：[0, 1]）。" },
	modelThinkingBudget: { en: "Thinking Budget", zh: "思考预算" },
	modelThinkingBudgetDesc: { en: "Maximum number of tokens for chain-of-thought output.", zh: "链式思考输出的最大 Token 数。" },
	modelFreqPenalty: { en: "Frequency Penalty", zh: "频率惩罚" },
	modelFreqPenaltyDesc: { en: "Frequency penalty (range: [-2, 2]).", zh: "频率惩罚（范围：[-2, 2]）。" },
	modelPresPenalty: { en: "Presence Penalty", zh: "存在惩罚" },
	modelPresPenaltyDesc: { en: "Presence penalty (range: [-2, 2]).", zh: "存在惩罚（范围：[-2, 2]）。" },
	modelRepPenalty: { en: "Repetition Penalty", zh: "重复惩罚" },
	modelRepPenaltyDesc: { en: "Repetition penalty (range: (0, 2]).", zh: "重复惩罚（范围：(0, 2]）。" },
	modelIncReasoning: { en: "Include Reasoning", zh: "包含推理" },
	modelIncReasoningDesc: { en: "Include reasoning_content in assistant messages.", zh: "在助手消息中包含 reasoning_content。" },
	modelThinkType: { en: "Thinking Type", zh: "思考类型" },
	modelThinkTypeDesc: { en: 'Include "thinking.type" in request body.', zh: '在请求体中包含 "thinking.type"。' },
	modelEnableThink: { en: "Enable Thinking", zh: "启用思考" },
	modelEnableThinkDesc: { en: 'Include "enable_thinking" in request body.', zh: '在请求体中包含 "enable_thinking"。' },
	modelReasonEffort: { en: "Reasoning Effort (OpenAI)", zh: "推理强度 (OpenAI)" },
	modelReasonEffortDesc: { en: "Default OpenAI reasoning effort. Leave empty to hide the Copilot picker.", zh: "默认 OpenAI 推理强度。留空则隐藏 Copilot 选择器。" },
	reasoningConfig: { en: "Reasoning Configuration (OpenRouter)", zh: "推理配置 (OpenRouter)" },
	reasoningEnabled: { en: "Reasoning Enabled", zh: "启用推理" },
	reasoningEnabledDesc: { en: "Enable reasoning params in request body.", zh: "在请求体中启用推理参数。" },
	reasoningEffort: { en: "Reasoning Effort", zh: "推理强度" },
	reasoningEffortDesc: { en: 'Include "reasoning.effort" in request body.', zh: '在请求体中包含 "reasoning.effort"。' },
	reasoningExclude: { en: "Reasoning Exclude", zh: "排除推理" },
	reasoningExcludeDesc: { en: 'Include "reasoning.exclude" in request body.', zh: '在请求体中包含 "reasoning.exclude"。' },
	reasoningMaxTokens: { en: "Reasoning Max Tokens", zh: "推理最大 Token 数" },
	reasoningMaxTokensDesc: { en: 'Include "reasoning.max_tokens" in request body.', zh: '在请求体中包含 "reasoning.max_tokens"。' },
	formCustomHeaders: { en: "Custom Headers (JSON)", zh: "自定义请求头 (JSON)" },
	formCustomHeadersDesc: { en: "Custom HTTP headers.", zh: "自定义 HTTP 请求头。" },
	formExtraParams: { en: "Extra Parameters (JSON)", zh: "额外参数 (JSON)" },
	formExtraParamsDesc: { en: "Extra request body parameters.", zh: "额外的请求体参数。" },
	// 下拉选择
	providerIdPh: { en: "Provider ID", zh: "提供商 ID" },
	baseUrlPh: { en: "Base URL", zh: "基础 URL" },
	apiKeyPh: { en: "API Key", zh: "API 密钥" },
	headersPh: { en: '{"X-API-Version": "v1"}', zh: '{"X-API-Version": "v1"}' },
	// API 模式
	apiModeOpenAI: { en: "OpenAI", zh: "OpenAI" },
	apiModeOpenAIResponses: { en: "OpenAI Responses", zh: "OpenAI Responses" },
	apiModeOllama: { en: "Ollama", zh: "Ollama" },
	apiModeAnthropic: { en: "Anthropic", zh: "Anthropic" },
	apiModeGemini: { en: "Gemini", zh: "Gemini" },
	// 提交语言
	commitLangEnglish: { en: "English", zh: "英语" },
	commitLangFrench: { en: "French", zh: "法语" },
	commitLangItalian: { en: "Italian", zh: "意大利语" },
	commitLangGerman: { en: "German", zh: "德语" },
	commitLangSpanish: { en: "Spanish", zh: "西班牙语" },
	commitLangRussian: { en: "Russian", zh: "俄语" },
	commitLangChineseSimplified: { en: "Chinese (Simplified)", zh: "简体中文" },
	commitLangChineseTraditional: { en: "Chinese (Traditional)", zh: "繁體中文" },
	commitLangJapanese: { en: "Japanese", zh: "日语" },
	commitLangKorean: { en: "Korean", zh: "韩语" },
	commitLangCzech: { en: "Czech", zh: "捷克语" },
	commitLangPortugueseBrazil: { en: "Portuguese (Brazil)", zh: "葡萄牙语 (巴西)" },
	commitLangTurkish: { en: "Turkish", zh: "土耳其语" },
	commitLangPolish: { en: "Polish", zh: "波兰语" },
	// 确认消息
	confirmDeleteProvider: { en: (provider) => `Are you sure you want to delete provider ${provider} and all its models?`, zh: (provider) => `确定要删除提供商 ${provider} 及其所有模型吗？` },
	confirmDeleteModel: { en: (modelId) => `Are you sure you want to delete model ${modelId}?`, zh: (modelId) => `确定要删除模型 ${modelId} 吗？` },
	// 错误消息
	modelIdRequired: { en: "Model ID is required.", zh: "模型 ID 不能为空。" },
	providerIdRequired: { en: "Provider ID is required.", zh: "提供商 ID 不能为空。" },
	valContextLength: { en: "Context Length must be a positive number.", zh: "上下文长度必须为正数。" },
	valMaxTokens: { en: "Max Tokens must be a positive number.", zh: "最大 Token 数必须为正数。" },
	valMaxCompletionTokens: { en: "Max Completion Tokens must be a positive number.", zh: "最大完成 Token 数必须为正数。" },
	valBothMaxTokens: { en: "Cannot set both 'max_tokens' and 'max_completion_tokens'. Use 'max_completion_tokens' only.", zh: "不能同时设置 'max_tokens' 和 'max_completion_tokens'，请仅使用 'max_completion_tokens'。" },
	valTemperature: { en: "Temperature must be between 0 and 2.", zh: "温度必须在 0 到 2 之间。" },
	valTopP: { en: "Top P must be between 0 and 1.", zh: "Top P 必须在 0 到 1 之间。" },
	valDelay: { en: "Delay must be a non-negative number.", zh: "延迟必须为非负数。" },
	valHeaders: { en: "Custom Headers must be a valid JSON object.", zh: "自定义请求头必须为有效的 JSON 对象。" },
	valExtra: { en: "Extra Parameters must be a valid JSON object.", zh: "额外参数必须为有效的 JSON 对象。" },
	errorFetchingModels: { en: "Error fetching models", zh: "获取模型失败" },
	failedFetchModels: { en: "Failed to fetch models.", zh: "获取模型失败。" },
	noModelsAvailable: { en: "No models available", zh: "无可用模型" },
	// Token 消耗统计
	tokenUsage: { en: "Token Usage", zh: "Token 消耗统计" },
	tokenUsageToday: { en: "Today", zh: "今日" },
	tokenUsageAllTime: { en: "All-time", zh: "累计" },
	tokenUsageProvider: { en: "Provider", zh: "供应商" },
	tokenUsagePromptTokens: { en: "Prompt Tokens", zh: "输入 Token" },
	tokenUsageCompletionTokens: { en: "Completion Tokens", zh: "输出 Token" },
	tokenUsageTotalTokens: { en: "Total Tokens", zh: "总 Token 数" },
	tokenUsageRequests: { en: "Requests", zh: "请求次数" },
	tokenUsageNoData: { en: "No token usage data recorded yet.", zh: "暂无 Token 消耗数据。" },
	tokenUsageResetConfirm: { en: "Are you sure you want to reset all token usage statistics? This cannot be undone.", zh: "确定要重置所有 Token 消耗统计数据吗？此操作不可撤销。" },
	tokenUsageResetDone: { en: "Token usage statistics have been reset.", zh: "Token 消耗统计数据已重置。" },
	tokenUsageExported: { en: (path) => `Token usage data exported to ${path}`, zh: (path) => `Token 消耗数据已导出到 ${path}` },
	tokenUsageShowDetails: { en: "Show Token Usage Details", zh: "显示 Token 消耗详情" },
	tokenUsageReset: { en: "Reset Token Usage Statistics", zh: "重置 Token 消耗统计" },
	tokenUsageExport: { en: "Export Token Usage Data", zh: "导出 Token 消耗数据" },
	tokenUsageRecentDays: { en: (days) => `Last ${days} Days`, zh: (days) => `最近 ${days} 天` },
	tokenUsagePerProvider: { en: "Per Provider", zh: "按供应商" },
	tokenUsageContext: { en: "Context Window", zh: "上下文窗口" },
	tokenUsageMessages: { en: "Messages", zh: "消息" },
	tokenUsageTools: { en: "Tools", zh: "工具" },
	tokenUsageClickConfig: { en: "Click to Open Configuration UI", zh: "点击打开配置面板" },
	ready: { en: "Ready", zh: "就绪" },
	// 推理强度
	reasoningEffort: { en: "Reasoning Effort", zh: "推理强度" },
	reasoningEffortMinimal: { en: "Minimal", zh: "最低" },
	reasoningEffortLow: { en: "Low", zh: "低" },
	reasoningEffortMedium: { en: "Medium", zh: "中等" },
	reasoningEffortHigh: { en: "High", zh: "高" },
	reasoningEffortXHigh: { en: "XHigh", zh: "极高" },
	reasoningEffortMax: { en: "Max", zh: "最高" },
	reasoningEffortAuto: { en: "Auto", zh: "自动" },
	reasoningEffortDescMinimal: { en: "Smallest reasoning budget", zh: "最低推理预算" },
	reasoningEffortDescLow: { en: "Low reasoning budget", zh: "低推理预算" },
	reasoningEffortDescMedium: { en: "Balanced reasoning budget", zh: "均衡推理预算" },
	reasoningEffortDescHigh: { en: "High reasoning budget", zh: "高推理预算" },
	reasoningEffortDescXHigh: { en: "Very high reasoning budget", zh: "极高推理预算" },
	reasoningEffortDescMax: { en: "Maximum reasoning budget", zh: "最高推理预算" },
	// Git 提交
	selectRepository: { en: "Select repository for commit message generation", zh: "选择要生成提交信息的仓库" },
	commitGenFailed: { en: (msg) => `Failed to generate commit message: ${msg}`, zh: (msg) => `生成提交信息失败：${msg}` },
	noChangesFound: { en: "No changes found in any workspace repositories.", zh: "工作区所有仓库中未发现更改。" },
	apiKeyNotFound: { en: "OAI Compatible API key not found", zh: "未找到 OAI Compatible API 密钥" },
	gitExtensionNotFound: { en: "Git extension not found", zh: "未找到 Git 扩展" },
	noGitRepos: { en: "No Git repositories available", zh: "无可用 Git 仓库" },
	repoNotFoundForScm: { en: "Repository not found for provided SCM", zh: "未找到 SCM 对应的仓库" },
	noChangesInRepo: { en: (repo) => `No changes in repository ${repo} for commit message`, zh: (repo) => `仓库 ${repo} 中无变更，无法生成提交信息` },
	noCommitModels: { en: "No models configured for commit message generation. Please set 'useForCommitGeneration' to true for at least one model in your configuration.", zh: "未配置用于提交信息生成的模型，请将至少一个模型的 'useForCommitGeneration' 设置为 true。" },
	emptyApiResponse: { en: "Empty API response", zh: "API 返回空响应" },
	invalidBaseUrl: { en: "Invalid base URL configuration.", zh: "无效的基础 URL 配置。" },
	defaultCommitSystemPrompt: { en: "You are a helpful assistant that generates informative git commit messages based on git diffs output. Skip preamble and remove all backticks surrounding the commit message.\nBased on the provided git diff, generate a conventional format commit message.", zh: "你是一个有用的助手，根据 git diff 输出生成信息丰富的 git 提交信息。跳过前言并删除提交信息周围的所有反引号。\n根据提供的 git diff，生成常规格式的提交信息。" },
	defaultCommitUserPrompt: { en: "Notes from developer (ignore if not relevant): {{USER_CURRENT_INPUT}}", zh: "开发者备注（如不相关请忽略）：{{USER_CURRENT_INPUT}}" },
	generatingCommitMsg: { en: (repo) => `Generating commit message for ${repo}...`, zh: (repo) => `正在为 ${repo} 生成提交信息...` },
	diffTruncated: { en: "\n\n[Diff truncated due to size]", zh: "\n\n[Diff 因大小限制被截断]" },
	// 图片处理
	unsupportedImageFormat: { en: "Unsupported image format", zh: "不支持的图片格式" },
	jpegDimensionsNotFound: { en: "JPEG dimensions not found", zh: "未找到 JPEG 图片尺寸" },
	invalidWebPImage: { en: "Not a valid WebP image.", zh: "不是有效的 WebP 图片。" },
	methodNotImplemented: { en: "Method not implemented.", zh: "方法未实现。" },
	invalidJsonForToolCall: { en: "Invalid JSON for tool call", zh: "工具调用 JSON 格式无效" },
	unsupportedWebPFormat: { en: "Unsupported WebP format.", zh: "不支持的 WebP 格式。" },
	extensionPathNotInitialized: { en: "Extension path not initialized. Call TokenizerManager.setExtensionPath() first.", zh: "扩展路径未初始化。请先调用 TokenizerManager.setExtensionPath()。" },
	gitNotInstalled: { en: "Git is not installed", zh: "Git 未安装" },
	notGitRepository: { en: "Not a git repository", zh: "不是 Git 仓库" },
	noChangesInWorkspace: { en: "No changes in workspace for commit message", zh: "工作区无变更，无法生成提交信息" },
	// 重复模型校验
	valDuplicateModel: { en: (id, configId) => `A model with ID="${id}"${configId ? ` and Config ID="${configId}"` : ""} already exists. Model ID and Config ID combination must be unique.`, zh: (id, configId) => `ID="${id}"${configId ? ` 且配置 ID="${configId}"` : ""} 的模型已存在。模型 ID 与配置 ID 的组合必须唯一。` },
};

function i18n(key, ...args) {
	const entry = Texts[key];
	if (!entry) { return key; }
	const value = entry[LOCALE] || entry.en || key;
	if (typeof value === "function") {
		return value(...args);
	}
	return value;
}

// 页面加载完成后应用翻译
document.addEventListener("DOMContentLoaded", () => {
	document.querySelectorAll("[data-i18n]").forEach((el) => {
		const key = el.getAttribute("data-i18n");
		const text = i18n(key);
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
			el.placeholder = text;
		} else if (el.tagName === "OPTION") {
			el.textContent = text;
		} else {
			el.textContent = text;
		}
	});
	document.title = i18n("title");
});

// ===================== 原有 JS 逻辑 =====================
const pendingConfirmations = new Map();

// Global Configuration elements
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const delayInput = document.getElementById("delay");
const readFileLinesInput = document.getElementById("readFileLines");
const tokenUsageEnabledInput = document.getElementById("tokenUsageEnabled");
const retryEnabledInput = document.getElementById("retryEnabled");
const maxAttemptsInput = document.getElementById("maxAttempts");
const intervalMsInput = document.getElementById("intervalMs");
const statusCodesInput = document.getElementById("statusCodes");

// Provider management elements
const providerTableBody = document.getElementById("providerTableBody");

// Model management elements
const modelTableBody = document.getElementById("modelTableBody");
const modelFormSection = document.getElementById("modelFormSection");
const modelFormTitle = document.getElementById("modelFormTitle");
const modelIdInput = document.getElementById("modelIdInput");
const modelIdDropdown = document.getElementById("modelIdDropdown");
const modelProviderInput = document.getElementById("modelProvider");
const modelDisplayNameInput = document.getElementById("modelDisplayName");
const modelConfigIdInput = document.getElementById("modelConfigId");
const modelBaseUrlInput = document.getElementById("modelBaseUrl");
const modelFamilyInput = document.getElementById("modelFamily");
const modelContextLengthInput = document.getElementById("modelContextLength");
const modelMaxTokensInput = document.getElementById("modelMaxTokens");
const modelVisionInput = document.getElementById("modelVision");
const modelApiModeInput = document.getElementById("modelApiMode");
const modelTemperatureInput = document.getElementById("modelTemperature");
const modelTopPInput = document.getElementById("modelTopP");
const modelDelayInput = document.getElementById("modelDelay");
const modelTopKInput = document.getElementById("modelTopK");
const modelMinPInput = document.getElementById("modelMinP");
const modelFrequencyPenaltyInput = document.getElementById("modelFrequencyPenalty");
const modelPresencePenaltyInput = document.getElementById("modelPresencePenalty");
const modelRepetitionPenaltyInput = document.getElementById("modelRepetitionPenalty");
const modelReasoningEffortInput = document.getElementById("modelReasoningEffort");
const modelEnableThinkingInput = document.getElementById("modelEnableThinking");
const modelThinkingBudgetInput = document.getElementById("modelThinkingBudget");
const modelIncludeReasoningInput = document.getElementById("modelIncludeReasoning");
const modelMaxCompletionTokensInput = document.getElementById("modelMaxCompletionTokens");
const modelReasoningEnabledInput = document.getElementById("modelReasoningEnabled");
const modelReasoningExcludeInput = document.getElementById("modelReasoningExclude");
const modelReasoningEffortORInput = document.getElementById("modelReasoningEffortOR");
const modelReasoningMaxTokensInput = document.getElementById("modelReasoningMaxTokens");
const modelThinkingTypeInput = document.getElementById("modelThinkingType");
const modelHeadersInput = document.getElementById("modelHeaders");
const modelExtraInput = document.getElementById("modelExtra");
const saveModelBtn = document.getElementById("saveModel");
const cancelModelBtn = document.getElementById("cancelModel");
const toggleAdvancedSettingsBtn = document.getElementById("toggleAdvancedSettings");
const commitModelInput = document.getElementById("commitModel");
const commitLanguageInput = document.getElementById("commitLanguage");
const advancedSettingsContent = document.getElementById("advancedSettingsContent");

const modelErrorElement = document.getElementById("modelError");
const dropdownContent = modelIdDropdown.querySelector(".dropdown-content");
const dropdownHeader = modelIdDropdown.querySelector(".dropdown-header");

// Global Configuration save button event listener
document.getElementById("saveBase").addEventListener("click", () => {
	const retry = {
		enabled: retryEnabledInput.checked,
		max_attempts: parseInt(maxAttemptsInput.value) || 3,
		interval_ms: parseInt(intervalMsInput.value) || 1000,
		status_codes: statusCodesInput.value
			? statusCodesInput.value.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n))
			: [],
	};
	vscode.postMessage({
		type: "saveGlobalConfig",
		baseUrl: baseUrlInput.value,
		apiKey: apiKeyInput.value,
		delay: parseInt(delayInput.value) || 0,
		readFileLines: parseInt(readFileLinesInput.value) || 0,
		tokenUsageEnabled: tokenUsageEnabledInput.checked,
		retry: retry,
		commitModel: commitModelInput.value,
		commitLanguage: commitLanguageInput.value,
	});
});

const handleRefresh = () => {
	if (modelFormSection.style.display !== "none") {
		modelFormSection.style.display = "none";
		resetModelForm();
	}
	vscode.postMessage({ type: "requestInit" });
};

document.getElementById("exportConfig").addEventListener("click", () => { vscode.postMessage({ type: "exportConfig" }); });
document.getElementById("importConfig").addEventListener("click", () => { vscode.postMessage({ type: "importConfig" }); });
document.getElementById("refreshGlobalConfig").addEventListener("click", handleRefresh);
document.getElementById("refreshProviders").addEventListener("click", handleRefresh);
document.getElementById("refreshModels").addEventListener("click", handleRefresh);

// Add Provider button event listener
document.getElementById("addProvider").addEventListener("click", () => {
	const newRow = document.createElement("tr");
	newRow.innerHTML = `
		<td><input type="text" class="provider-input" data-field="provider" placeholder="${i18n("providerIdPh")}" /></td>
		<td><input type="text" class="provider-input" data-field="baseUrl" placeholder="${i18n("baseUrlPh")}" /></td>
		<td><input type="password" class="provider-input" data-field="apiKey" placeholder="${i18n("apiKeyPh")}" /></td>
		<td>
			<select class="provider-input" data-field="apiMode">
				<option value="openai">${i18n("apiModeOpenAI")}</option>
				<option value="openai-responses">${i18n("apiModeOpenAIResponses")}</option>
				<option value="ollama">${i18n("apiModeOllama")}</option>
				<option value="anthropic">${i18n("apiModeAnthropic")}</option>
				<option value="gemini">${i18n("apiModeGemini")}</option>
			</select>
		</td>
		<td><textarea class="provider-input" data-field="headers" rows="2" placeholder='${i18n("headersPh")}' style="width:100%;font-family:monospace;font-size:12px;"></textarea></td>
		<td>
			<button class="save-provider-btn secondary">${i18n("save")}</button>
			<button class="cancel-provider-btn secondary">${i18n("cancel")}</button>
		</td>
	`;
	providerTableBody.appendChild(newRow);
	const saveBtn = newRow.querySelector(".save-provider-btn");
	const cancelBtn = newRow.querySelector(".cancel-provider-btn");
	saveBtn.addEventListener("click", () => {
		const inputs = newRow.querySelectorAll(".provider-input");
		const providerData = {};
		inputs.forEach((input) => { providerData[input.getAttribute("data-field")] = input.value; });
		let headers = undefined;
		if (providerData.headers && providerData.headers.trim()) {
			try { headers = JSON.parse(providerData.headers); } catch (e) { /* ignore */ }
		}
		vscode.postMessage({
			type: "addProvider",
			provider: providerData.provider,
			baseUrl: providerData.baseUrl || undefined,
			apiKey: providerData.apiKey || undefined,
			apiMode: providerData.apiMode || undefined,
			headers: headers,
		});
		newRow.remove();
	});
	cancelBtn.addEventListener("click", () => { newRow.remove(); });
});

// Add Model button event listeners
document.getElementById("addModel").addEventListener("click", () => {
	modelFormSection.style.display = "block";
	modelFormTitle.textContent = i18n("addNewModel");
	resetModelForm();
});

modelProviderInput.addEventListener("change", () => {
	const selectedProvider = modelProviderInput.value;
	if (selectedProvider && state.providerInfo[selectedProvider]) {
		modelBaseUrlInput.value = state.providerInfo[selectedProvider].baseUrl;
		modelApiModeInput.value = state.providerInfo[selectedProvider].apiMode;
		const headers = state.providerInfo[selectedProvider].headers;
		modelHeadersInput.value = headers ? JSON.stringify(headers, null, 2) : "";
		vscode.postMessage({
			type: "fetchModels",
			baseUrl: state.providerInfo[selectedProvider].baseUrl || state.baseUrl,
			apiKey: state.providerKeys[selectedProvider] || state.apiKey,
			apiMode: state.providerInfo[selectedProvider].apiMode || modelApiModeInput.value || "openai",
			headers,
		});
	}
});

toggleAdvancedSettingsBtn.addEventListener("click", () => {
	const isCurrentlyVisible = advancedSettingsContent.style.display !== "none";
	advancedSettingsContent.style.display = isCurrentlyVisible ? "none" : "block";
	toggleAdvancedSettingsBtn.textContent = isCurrentlyVisible ? i18n("showAdvanced") : i18n("hideAdvanced");
});

saveModelBtn.addEventListener("click", () => {
	const modelData = collectModelFormData();
	if (!validateModelData(modelData)) { return; }
	const isEditing = modelIdInput.hasAttribute("data-editing");
	if (isEditing) {
		let originalModelId = modelData.originalModelId;
		let originalConfigId = modelData.originalConfigId;
		delete modelData.originalModelId;
		delete modelData.originalConfigId;
		vscode.postMessage({ type: "updateModel", model: modelData, originalModelId, originalConfigId });
	} else {
		vscode.postMessage({ type: "addModel", model: modelData });
	}
	modelFormSection.style.display = "none";
	resetModelForm();
});

cancelModelBtn.addEventListener("click", () => {
	modelFormSection.style.display = "none";
	resetModelForm();
});

window.addEventListener("message", (event) => {
	const message = event.data;
	switch (message.type) {
		case "init": {
			const { baseUrl, apiKey, delay, readFileLines, tokenUsageEnabled, retry, commitModel, models, providerKeys, commitLanguage } = message.payload;
			state.baseUrl = baseUrl;
			state.apiKey = apiKey;
			state.delay = delay || 0;
			state.readFileLines = readFileLines || 0;
			state.tokenUsageEnabled = tokenUsageEnabled === true; // default false
			state.retry = retry || { enabled: true, max_attempts: 3, interval_ms: 1000, status_codes: [] };
			state.models = models || [];
			state.commitModel = commitModel || "";
			state.providerKeys = providerKeys || {};
			baseUrlInput.value = baseUrl || "";
			apiKeyInput.value = apiKey || "";
			delayInput.value = state.delay;
			readFileLinesInput.value = message.payload.readFileLines || 0;
			tokenUsageEnabledInput.checked = state.tokenUsageEnabled;
			retryEnabledInput.checked = state.retry.enabled !== false;
			maxAttemptsInput.value = state.retry.max_attempts || 3;
			intervalMsInput.value = state.retry.interval_ms || 1000;
			statusCodesInput.value = state.retry.status_codes ? state.retry.status_codes.join(",") : "";
			populateCommitModelDropdown();
			commitModelInput.value = state.commitModel || "";
			commitLanguageInput.value = commitLanguage;
			renderProviders();
			renderModels();
			break;
		}
		case "modelsFetched":
			populateModelIdDropdown(message.models);
			break;
		case "modelsFetchError":
			dropdownHeader.textContent = i18n("errorFetchingModels");
			dropdownContent.innerHTML = `<div class="dropdown-option error">${i18n("failedFetchModels")}</div>`;
			console.error("[oaicopilot] Failed to fetch models:", message.error);
			break;
		case "confirmResponse": {
			const pendingAction = pendingConfirmations.get(message.id);
			if (pendingAction && message.confirmed) {
				if (pendingAction.action) { pendingAction.action(); }
				pendingConfirmations.delete(message.id);
			} else if (pendingAction) {
				pendingConfirmations.delete(message.id);
			}
			break;
		}
	}
});

function renderProviders() {
	const providers = Array.from(new Set(state.models.map((m) => m.owned_by).filter(Boolean))).sort((a, b) => a.localeCompare(b));
	if (!providers.length) {
		providerTableBody.innerHTML = `<tr><td colspan="6" class="no-data">${i18n("noProviders")}</td></tr>`;
		modelProviderInput.innerHTML = `<option value="">${i18n("selectProvider")}</option>`;
		return;
	}
	const rows = providers.map((provider) => {
		const providerModels = state.models.filter((m) => m.owned_by === provider);
		const firstModel = providerModels[0];
		const headersJson = firstModel.headers ? JSON.stringify(firstModel.headers, null, 2) : "";
		return `
		<tr data-provider="${provider}">
			<td>${provider}</td>
			<td><input type="text" class="provider-input" data-field="baseUrl" value="${firstModel.baseUrl || ""}" placeholder="${i18n("baseUrlPh")}" /></td>
			<td><input type="password" class="provider-input" data-field="apiKey" value="${state.providerKeys[provider] || ""}" placeholder="${i18n("apiKeyPh")}" /></td>
			<td>
				<select class="provider-input" data-field="apiMode">
					<option value="openai" ${firstModel.apiMode === "openai" ? "selected" : ""}>${i18n("apiModeOpenAI")}</option>
					<option value="openai-responses" ${firstModel.apiMode === "openai-responses" ? "selected" : ""}>${i18n("apiModeOpenAIResponses")}</option>
					<option value="ollama" ${firstModel.apiMode === "ollama" ? "selected" : ""}>${i18n("apiModeOllama")}</option>
					<option value="anthropic" ${firstModel.apiMode === "anthropic" ? "selected" : ""}>${i18n("apiModeAnthropic")}</option>
					<option value="gemini" ${firstModel.apiMode === "gemini" ? "selected" : ""}>${i18n("apiModeGemini")}</option>
				</select>
			</td>
			<td><textarea class="provider-input" data-field="headers" rows="2" placeholder='${i18n("headersPh")}' style="width:100%;font-family:monospace;font-size:12px;">${headersJson}</textarea></td>
			<td class="action-buttons">
				<button class="update-provider-btn" data-provider="${provider}">${i18n("save")}</button>
				<button class="delete-provider-btn danger" data-provider="${provider}">${i18n("delete")}</button>
			</td>
		</tr>`;
	}).join("");
	providerTableBody.innerHTML = rows;

	state.providerInfo = {};
	const providerOptions = providers.map((provider) => {
		const providerModels = state.models.filter((m) => m.owned_by === provider);
		const firstModel = providerModels[0];
		state.providerInfo[provider] = {
			baseUrl: firstModel.baseUrl || state.baseUrl,
			apiMode: firstModel.apiMode || "openai",
			apiKey: state.providerKeys[provider] || state.apiKey,
			headers: firstModel.headers,
		};
		return `<option value="${provider}">${provider}</option>`;
	}).join("");
	modelProviderInput.innerHTML = `<option value="">${i18n("selectProvider")}</option>` + providerOptions;

	document.querySelectorAll(".update-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const provider = event.target.getAttribute("data-provider");
			const row = event.target.closest("tr");
			const inputs = row.querySelectorAll(".provider-input");
			const providerData = {};
			inputs.forEach((input) => { providerData[input.getAttribute("data-field")] = input.value; });
			let headers = undefined;
			if (providerData.headers && providerData.headers.trim()) {
				try { headers = JSON.parse(providerData.headers); } catch (e) { /* ignore */ }
			}
			vscode.postMessage({
				type: "updateProvider", provider,
				baseUrl: providerData.baseUrl || undefined,
				apiKey: providerData.apiKey || undefined,
				apiMode: providerData.apiMode || undefined,
				headers,
			});
		});
	});

	document.querySelectorAll(".delete-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const provider = event.target.getAttribute("data-provider");
			const confirmId = "deleteProvider_" + Date.now();
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteProvider", provider }),
			});
			vscode.postMessage({
				type: "requestConfirm", id: confirmId,
				message: i18n("confirmDeleteProvider", provider),
				action: "deleteProvider",
			});
		});
	});
}

function renderModels() {
	const models = state.models.filter((m) => !m.id.startsWith("__provider__")).sort((a, b) => a.id.localeCompare(b.id));
	if (!models.length) {
		modelTableBody.innerHTML = `<tr><td colspan="11" class="no-data">${i18n("noModels")}</td></tr>`;
		return;
	}
	const rows = models.map((model) => {
		return `
		<tr data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">
			<td>${model.id}</td>
			<td>${model.owned_by}</td>
			<td>${model.displayName || ""}</td>
			<td>${model.configId || ""}</td>
			<td>${model.context_length || ""}</td>
			<td>${model.max_tokens || model.max_completion_tokens || ""}</td>
			<td>${model.vision ? i18n("true") : ""}</td>
			<td>${model.temperature !== undefined && model.temperature !== null ? model.temperature : ""}</td>
			<td>${model.top_p !== undefined && model.top_p !== null ? model.top_p : ""}</td>
			<td>${model.delay || ""}</td>
			<td class="action-buttons">
				<button class="update-model-btn" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">${i18n("edit")}</button>
				<button class="delete-model-btn danger" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">${i18n("delete")}</button>
			</td>
		</tr>`;
	}).join("");
	modelTableBody.innerHTML = rows;

	document.querySelectorAll(".update-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const parsedModelId = modelId.includes("::")
				? { baseId: modelId.split("::")[0], configId: modelId.split("::")[1] }
				: { baseId: modelId, configId: null };
			const model = state.models.find((m) =>
				m.id === parsedModelId.baseId &&
				((parsedModelId.configId && m.configId === parsedModelId.configId) || (!parsedModelId.configId && !m.configId))
			);
			if (model) {
				modelFormSection.style.display = "block";
				modelFormTitle.textContent = LOCALE === "zh" ? `编辑模型：${modelId}` : `Edit Model: ${modelId}`;
				populateModelForm(model);
			}
		});
	});

	document.querySelectorAll(".delete-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const confirmId = "deleteModel_" + Date.now();
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteModel", modelId }),
			});
			vscode.postMessage({
				type: "requestConfirm", id: confirmId,
				message: i18n("confirmDeleteModel", modelId),
				action: "deleteModel",
			});
		});
	});
}

function resetModelForm() {
	showModelError("");
	modelIdInput.value = "";
	modelProviderInput.value = "";
	modelDisplayNameInput.value = "";
	modelConfigIdInput.value = "";
	modelBaseUrlInput.value = "";
	modelFamilyInput.value = "";
	modelContextLengthInput.value = 128000;
	modelMaxTokensInput.value = 4096;
	modelVisionInput.value = "";
	modelApiModeInput.value = "openai";
	modelTemperatureInput.value = 0;
	modelTopPInput.value = "";
	modelDelayInput.value = "";
	modelTopKInput.value = "";
	modelMinPInput.value = "";
	modelFrequencyPenaltyInput.value = "";
	modelPresencePenaltyInput.value = "";
	modelRepetitionPenaltyInput.value = "";
	modelReasoningEffortInput.value = "";
	modelEnableThinkingInput.value = "";
	modelThinkingBudgetInput.value = "";
	modelIncludeReasoningInput.value = "";
	modelMaxCompletionTokensInput.value = "";
	modelReasoningEnabledInput.value = "";
	modelReasoningExcludeInput.value = "";
	modelReasoningEffortORInput.value = "";
	modelReasoningMaxTokensInput.value = "";
	modelThinkingTypeInput.value = "";
	modelHeadersInput.value = "";
	modelExtraInput.value = "";
	advancedSettingsContent.style.display = "none";
	toggleAdvancedSettingsBtn.textContent = i18n("showAdvanced");
	modelIdInput.removeAttribute("data-editing");
	modelIdInput.removeAttribute("data-original-id");
	modelIdInput.removeAttribute("data-original-configId");
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
	dropdownContent.innerHTML = "";
}

function collectModelFormData() {
	const isEditing = modelIdInput.hasAttribute("data-editing");
	return {
		id: modelIdInput.value.trim(),
		owned_by: modelProviderInput.value.trim(),
		displayName: modelDisplayNameInput.value.trim() || undefined,
		configId: modelConfigIdInput.value.trim() || undefined,
		baseUrl: modelBaseUrlInput.value.trim() || undefined,
		family: modelFamilyInput.value.trim() || undefined,
		context_length: modelContextLengthInput.value ? parseInt(modelContextLengthInput.value) : undefined,
		max_tokens: modelMaxTokensInput.value ? parseInt(modelMaxTokensInput.value) : undefined,
		vision: modelVisionInput.value ? modelVisionInput.value === "true" : undefined,
		apiMode: modelApiModeInput.value || undefined,
		temperature: modelTemperatureInput.value !== "" ? parseFloat(modelTemperatureInput.value) : undefined,
		top_p: modelTopPInput.value !== "" ? parseFloat(modelTopPInput.value) : undefined,
		delay: modelDelayInput.value ? parseInt(modelDelayInput.value) : undefined,
		top_k: modelTopKInput.value ? parseInt(modelTopKInput.value) : undefined,
		min_p: modelMinPInput.value !== "" ? parseFloat(modelMinPInput.value) : undefined,
		frequency_penalty: modelFrequencyPenaltyInput.value !== "" ? parseFloat(modelFrequencyPenaltyInput.value) : undefined,
		presence_penalty: modelPresencePenaltyInput.value !== "" ? parseFloat(modelPresencePenaltyInput.value) : undefined,
		repetition_penalty: modelRepetitionPenaltyInput.value !== "" ? parseFloat(modelRepetitionPenaltyInput.value) : undefined,
		reasoning_effort: modelReasoningEffortInput.value || undefined,
		enable_thinking: modelEnableThinkingInput.value ? modelEnableThinkingInput.value === "true" : undefined,
		thinking_budget: modelThinkingBudgetInput.value ? parseInt(modelThinkingBudgetInput.value) : undefined,
		include_reasoning_in_request: modelIncludeReasoningInput.value ? modelIncludeReasoningInput.value === "true" : undefined,
		max_completion_tokens: modelMaxCompletionTokensInput.value ? parseInt(modelMaxCompletionTokensInput.value) : undefined,
		reasoning: buildReasoningConfig(),
		thinking: buildThinkingConfig(),
		headers: parseJsonField(modelHeadersInput.value),
		extra: parseJsonField(modelExtraInput.value),
		originalModelId: isEditing ? modelIdInput.getAttribute("data-original-id") : undefined,
		originalConfigId: isEditing ? modelIdInput.getAttribute("data-original-configId") : undefined,
	};
}

function buildReasoningConfig() {
	const enabled = modelReasoningEnabledInput.value ? modelReasoningEnabledInput.value === "true" : undefined;
	const effort = modelReasoningEffortORInput.value || undefined;
	const exclude = modelReasoningExcludeInput.value ? modelReasoningExcludeInput.value === "true" : undefined;
	const maxTokens = modelReasoningMaxTokensInput.value ? parseInt(modelReasoningMaxTokensInput.value) : undefined;
	if (enabled !== undefined || effort !== undefined || exclude !== undefined || maxTokens !== undefined) {
		return { enabled, effort, exclude, max_tokens: maxTokens };
	}
	return undefined;
}

function buildThinkingConfig() {
	const type = modelThinkingTypeInput.value || undefined;
	if (type !== undefined) { return { type }; }
	return undefined;
}

function parseJsonField(value) {
	if (!value || value.trim() === "") { return undefined; }
	try { return JSON.parse(value.trim()); } catch (error) { return undefined; }
}

function showModelError(message) {
	if (modelErrorElement) {
		modelErrorElement.textContent = message;
		modelErrorElement.style.display = message ? "block" : "none";
		if (message) { modelErrorElement.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
	}
}

function validateModelData(modelData) {
	showModelError("");
	if (!modelData.id) { showModelError(i18n("modelIdRequired")); return false; }
	if (!modelData.owned_by) { showModelError(i18n("providerIdRequired")); return false; }
	const isEditing = modelIdInput.hasAttribute("data-editing");
	const hasDuplicate = state.models
		.filter((m) => {
			if (isEditing) {
				const isOrigin = m.id === modelData.originalModelId &&
					((modelData.originalConfigId && m.configId === modelData.originalConfigId) || (!modelData.originalConfigId && !m.configId));
				return !isOrigin;
			}
			return true;
		})
		.some((m) => m.id === modelData.id && ((modelData.configId && m.configId === modelData.configId) || (!modelData.configId && !m.configId)));
	if (hasDuplicate) {
		showModelError(i18n("valDuplicateModel", modelData.id, modelData.configId));
		return false;
	}
	if (modelData.context_length !== undefined && (isNaN(modelData.context_length) || modelData.context_length <= 0)) { showModelError(i18n("valContextLength")); return false; }
	if (modelData.max_tokens !== undefined && (isNaN(modelData.max_tokens) || modelData.max_tokens <= 0)) { showModelError(i18n("valMaxTokens")); return false; }
	if (modelData.max_completion_tokens !== undefined && (isNaN(modelData.max_completion_tokens) || modelData.max_completion_tokens <= 0)) { showModelError(i18n("valMaxCompletionTokens")); return false; }
	if (modelData.max_tokens !== undefined && modelData.max_completion_tokens !== undefined) { showModelError(i18n("valBothMaxTokens")); return false; }
	if (modelData.temperature !== undefined && (isNaN(modelData.temperature) || modelData.temperature < 0 || modelData.temperature > 2)) { showModelError(i18n("valTemperature")); return false; }
	if (modelData.top_p !== undefined && (isNaN(modelData.top_p) || modelData.top_p < 0 || modelData.top_p > 1)) { showModelError(i18n("valTopP")); return false; }
	if (modelData.delay !== undefined && (isNaN(modelData.delay) || modelData.delay < 0)) { showModelError(i18n("valDelay")); return false; }
	if (modelData.headers && typeof modelData.headers !== "object") { showModelError(i18n("valHeaders")); return false; }
	if (modelData.extra && typeof modelData.extra !== "object") { showModelError(i18n("valExtra")); return false; }
	return true;
}

function populateModelIdDropdown(models) {
	const modelsArray = Array.from(models || []);
	dropdownContent.innerHTML = "";
	if (!modelsArray.length) {
		dropdownHeader.textContent = i18n("noModelsAvailable");
		return;
	}
	dropdownHeader.textContent = i18n("selectModel", modelsArray.length);
	modelsArray.forEach((model) => {
		const option = document.createElement("div");
		option.className = "dropdown-option";
		option.textContent = model.id;
		option.dataset.modelId = model.id;
		option.addEventListener("click", () => {
			modelIdInput.value = model.id;
			hideDropdown();
			dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => { opt.classList.remove("selected"); });
			option.classList.add("selected");
		});
		dropdownContent.appendChild(option);
	});
}

function populateCommitModelDropdown() {
	while (commitModelInput.children.length > 1) { commitModelInput.removeChild(commitModelInput.lastChild); }
	const commitCompatibleModels = state.models
		.filter((model) => {
			const apiMode = model.apiMode || "openai";
			return apiMode !== "gemini" && !model.id.startsWith("__provider__");
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	commitCompatibleModels.forEach((model) => {
		const option = document.createElement("option");
		const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
		option.value = fullModelId;
		option.textContent = model.displayName || fullModelId;
		commitModelInput.appendChild(option);
	});
}

function showDropdown() { if (dropdownContent.children.length > 0) { modelIdDropdown.classList.add("show"); } }
function hideDropdown() { modelIdDropdown.classList.remove("show"); }
function toggleDropdown() { if (modelIdDropdown.classList.contains("show")) { hideDropdown(); } else { showDropdown(); } }

function populateModelForm(model) {
	showModelError("");
	modelIdInput.setAttribute("data-original-id", model.id || "");
	modelIdInput.setAttribute("data-original-configId", model.configId || "");
	modelIdInput.value = model.id || "";
	const currentProvider = model.owned_by || "";
	const providerExists = Array.from(modelProviderInput.options).some((option) => option.value === currentProvider);
	if (!providerExists && currentProvider) {
		const newOption = document.createElement("option");
		newOption.value = currentProvider;
		newOption.textContent = currentProvider;
		modelProviderInput.appendChild(newOption);
	}
	const providerInfo = state.providerInfo[currentProvider];
	const fetchBaseUrl = model.baseUrl || state.baseUrl;
	const fetchApiKey = state.providerKeys[currentProvider] || state.apiKey;
	const fetchApiMode = providerInfo?.apiMode || model.apiMode || modelApiModeInput.value || "openai";
	vscode.postMessage({ type: "fetchModels", baseUrl: fetchBaseUrl, apiKey: fetchApiKey, apiMode: fetchApiMode, headers: model.headers });
	modelProviderInput.value = currentProvider;
	modelDisplayNameInput.value = model.displayName || "";
	modelConfigIdInput.value = model.configId || "";
	modelBaseUrlInput.value = model.baseUrl || "";
	modelFamilyInput.value = model.family || "";
	modelContextLengthInput.value = model.context_length || "";
	modelMaxTokensInput.value = model.max_tokens || "";
	modelVisionInput.value = model.vision ? "true" : "";
	modelApiModeInput.value = model.apiMode || "openai";
	modelTemperatureInput.value = model.temperature !== undefined && model.temperature !== null ? model.temperature : "";
	modelTopPInput.value = model.top_p !== undefined && model.top_p !== null ? model.top_p : "";
	modelDelayInput.value = model.delay || "";
	modelTopKInput.value = model.top_k || "";
	modelMinPInput.value = model.min_p !== undefined && model.min_p !== null ? model.min_p : "";
	modelFrequencyPenaltyInput.value = model.frequency_penalty !== undefined && model.frequency_penalty !== null ? model.frequency_penalty : "";
	modelPresencePenaltyInput.value = model.presence_penalty !== undefined && model.presence_penalty !== null ? model.presence_penalty : "";
	modelRepetitionPenaltyInput.value = model.repetition_penalty !== undefined && model.repetition_penalty !== null ? model.repetition_penalty : "";
	modelReasoningEffortInput.value = model.reasoning_effort || "";
	modelEnableThinkingInput.value = model.enable_thinking !== undefined ? String(model.enable_thinking) : "";
	modelThinkingBudgetInput.value = model.thinking_budget || "";
	modelIncludeReasoningInput.value = model.include_reasoning_in_request !== undefined ? String(model.include_reasoning_in_request) : "";
	modelMaxCompletionTokensInput.value = model.max_completion_tokens || "";
	modelThinkingTypeInput.value = model.thinking?.type || "";
	modelHeadersInput.value = model.headers ? JSON.stringify(model.headers, null, 2) : "";
	modelExtraInput.value = model.extra ? JSON.stringify(model.extra, null, 2) : "";
	if (model.reasoning) {
		modelReasoningEnabledInput.value = model.reasoning.enabled !== undefined ? String(model.reasoning.enabled) : "";
		modelReasoningEffortORInput.value = model.reasoning.effort || "";
		modelReasoningExcludeInput.value = model.reasoning.exclude !== undefined ? String(model.reasoning.exclude) : "";
		modelReasoningMaxTokensInput.value = model.reasoning.max_tokens || "";
	}
	modelIdInput.setAttribute("data-editing", "true");
}
