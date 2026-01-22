# OAI Compatible Copilot - AI Agent Guidelines

## Project Overview
VS Code extension integrating OpenAI-compatible inference providers into GitHub Copilot Chat. Enables frontier LLMs (Qwen3 Coder, Kimi K2, DeepSeek V3.2, GLM 4.6, etc.) through any OpenAI-compatible API provider.

## Architecture Patterns

### Core Components
1. **Provider System** (`src/provider.ts`): `LanguageModelChatProvider` implementation - model selection, token counting, request routing
2. **API Abstraction Layer** (`src/commonApi.ts`): Base class with tool call buffering, thinking content parsing, streaming response handling
3. **API Implementations**:
   - `src/openai/openaiApi.ts` - OpenAI Chat Completions (reasoning, vision, tools)
   - `src/openai/openaiResponsesApi.ts` - OpenAI Responses API (separate input/output structure)
   - `src/ollama/ollamaApi.ts` - Ollama native API
   - `src/anthropic/anthropicApi.ts` - Anthropic Claude Messages API
   - `src/gemini/geminiApi.ts` - Gemini native API
4. **Type System** (`src/types.ts`): `HFModelItem` interface with extensive configuration
5. **Utilities** (`src/utils.ts`): Retry logic, tool conversion, image handling, model ID parsing
6. **Config View** (`src/views/configView.ts`): Webview UI for providers/models
7. **Git Commit** (`src/gitCommit/commitMessageGenerator.ts`): Generate commit messages from git diffs

### Key Design Decisions
- **Multi-provider support**: Multiple providers with provider-specific API keys
- **Configuration IDs**: `modelId::configId` format for same-model variants (e.g., `glm-4.6::thinking`)
- **Retry mechanism**: HTTP errors (429, 500, 502, 503, 504) with exponential backoff
- **Thinking support**: VS Code `languageModelThinkingPart` for reasoning models
- **XML think detection**: `_xmlThinkActive` + `_thinkingBuffer` for streaming think blocks
- **API modes**: `openai` | `openai-responses` | `ollama` | `anthropic` | `gemini`
- **Request delay**: Global (`oaicopilot.delay`) and per-model (`delay`) throttling
- **Custom headers**: Model-specific `headers` for authentication/versioning
- **Family optimizations**: `family` field for model-specific behaviors

## Development Workflows

### Build Commands
```bash
npm run compile   # TypeScript → `out/`
npm run lint      # ESLint with TypeScript rules
npm run format    # Prettier formatting
npm run watch     # Continuous compilation
```

### Testing & Debugging
- **Run Extension**: F5 with "Run Extension" launch config
- **Extension Tests**: "Extension Tests" launch config (requires `npm: watch-tests`)
- **Watch Tasks**: `npm: watch` and `npm: watch-tests` run automatically
- **Debugging**: Breakpoints work with source maps enabled in `tsconfig.json`

### VS Code Integration
- **API Proposals**: `chatProvider`, `languageModelThinkingPart`, `languageModelDataPart`
- **Secret Storage**: `oaicopilot.apiKey` (global) and `oaicopilot.apiKey.{provider}`
- **Status Bar**: Token usage in `src/statusBar.ts`
- **Dependencies**: Requires `github.copilot-chat`
- **Configuration**: `oaicopilot.models` array in VS Code settings

## Code Conventions

### TypeScript Patterns
- **Strict mode**: `tsconfig.json` with `strict: true`
- **ES2024 target**: Modern JavaScript features
- **Module resolution**: `Node16`
- **Type imports**: Use `import type` for type-only imports
- **Code comments**: English, JSDoc for public APIs
- **ESLint**: `eslint.config.mjs` with TypeScript rules

### Error Handling
- **Retry logic**: `createRetryConfig()` + `executeWithRetry()` from `utils.ts`
- **HTTP errors**: Retry 429, 500, 502, 503, 504 with exponential backoff
- **User feedback**: `vscode.window.showInformationMessage()` / `showErrorMessage()`
- **Streaming errors**: Handle gracefully without breaking UI

### Model Configuration
- **Model items**: `HFModelItem` interface in `src/types.ts`
- **Provider-specific keys**: `oaicopilot.setProviderApikey` command
- **Configuration inheritance**: Model `baseUrl` falls back to global
- **Family field**: `family: "gpt-4" | "claude-3" | "gemini" | "oai-compatible"`
- **API mode**: `apiMode: "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini"`
- **Include reasoning**: `include_reasoning_in_request: true` for DeepSeek V3.2
- **Request delay**: `delay` (per-model) or `oaicopilot.delay` (global)
- **Custom headers**: `headers` object for authentication/versioning

### Message Conversion
- **Role mapping**: `mapRole()` utility for VS Code → provider roles
- **Content handling**: Text, images (data URLs via `createDataUrl()`), tool calls
- **Thinking parts**: `LanguageModelThinkingPart` via `_thinkingBuffer`
- **Tool call buffering**: `_toolCallBuffers` in `CommonApi`

## File Organization

### Configuration Files
- `package.json` - Extension metadata, dependencies, and VS Code contributions
- `tsconfig.json` - TypeScript configuration with strict mode and ES2024 target
- `eslint.config.mjs` - ESLint configuration with TypeScript ESLint and stylistic rules
- `.prettierrc` - Code formatting rules for consistent style
- `.github/workflows/release.yml` - CI/CD workflow for packaging and publishing

## Integration Points

### VS Code APIs
- `vscode.lm.registerLanguageModelChatProvider()` - Register chat provider (vendor: "oaicopilot")
- `vscode.SecretStorage` - Secure API key storage with provider-specific prefixes
- `vscode.StatusBarItem` - Display token usage in status bar
- `vscode.commands.registerCommand()` - Extension commands (`oaicopilot.setApikey`, `oaicopilot.setProviderApikey`, `oaicopilot.openConfig`)
- `vscode.WebviewPanel` - Configuration UI in `src/views/configView.ts`

### External Dependencies
- **No runtime dependencies** - Extension uses VS Code APIs only
- **Dev dependencies**: TypeScript, ESLint, Prettier, VS Code test utilities
- **API Proposals**: Experimental VS Code APIs enabled via `enabledApiProposals` in `package.json`

## Common Tasks

### Adding New API Provider
1. Create new directory under `src/` (e.g., `src/newprovider/`)
2. Create API class extending `CommonApi` with proper type imports
3. Implement `convertMessages()`, `prepareRequestBody()`, and `processStreamingResponse()` methods
4. Add provider-specific type definitions (e.g., `newproviderTypes.ts`)
5. Update provider instantiation logic in `provider.ts` with new provider check
6. Update `HFApiMode` type in `src/types.ts` if adding new API mode

### Modifying Model Configuration
1. Update `HFModelItem` interface in `src/types.ts` with new fields
2. Update configuration parsing in `src/provider.ts` to handle new fields
3. Update API implementations to process new configuration fields
4. Update `prepareLanguageModelChatInformation()` in `src/provideModel.ts` if affecting model info
5. Update configuration UI in `src/views/configView.ts` and `assets/configView/`
6. Update documentation in `README.md` and package.json configuration schema

### Testing Changes
1. Run `npm run watch` in background for continuous compilation
2. Use "Run Extension" launch configuration (F5) to test in Extension Development Host
3. Test model selection, API calls, and configuration UI
4. Check status bar updates for token counting
5. Verify retry logic with simulated API errors

## Important Notes
- **API Key Management**: Users can set global (`oaicopilot.apiKey`) or provider-specific (`oaicopilot.apiKey.{provider}`) API keys
- **Model Families**: `family` field enables model-specific optimizations (gpt-4, claude-3, gemini, oai-compatible)
- **Vision Support**: Enabled via `vision: true` in model configuration, handled via data URLs
- **Tool Support**: Convert VS Code tools to OpenAI function definitions using `convertToolsToOpenAI()`
- **Streaming**: Support for streaming responses with tool call buffering via `_toolCallBuffers`
- **Thinking Content**: Parse thinking content via `_thinkingBuffer` in `CommonApi` for reasoning models
- **XML Think Detection**: Automatic detection of XML think blocks in streaming responses via `_xmlThinkActive` state and `_thinkingBuffer` accumulation
- **Configuration IDs**: Use `::configId` suffix for multiple model configurations (e.g., `glm-4.6::thinking`)
- **Request Delay Control**: Global (`oaicopilot.delay`) and per-model (`delay`) configuration to throttle consecutive requests and avoid rate limiting
- **Custom Headers Support**: Model-specific HTTP headers via `headers` field for authentication, versioning, or custom provider requirements
- **Gemini tool call metadata**: Uses `_geminiToolCallMetaByCallId` map to track tool call metadata across streaming responses

## Troubleshooting
- **Compilation errors**: Check TypeScript strict mode requirements and type imports
- **API errors**: Verify retry logic in `utils.ts` and HTTP status code handling
- **Missing models**: Check `prepareLanguageModelChatInformation()` in `src/provideModel.ts`
- **Thinking not working**: Ensure `languageModelThinkingPart` proposal is enabled in `package.json`
- **Streaming issues**: Check tool call buffering in `CommonApi` and SSE parsing
- **Image handling**: Verify `createDataUrl()` utility for image data URL conversion