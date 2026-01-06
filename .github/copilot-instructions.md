# OAI Compatible Copilot - AI Agent Guidelines

## Project Overview
This is a VS Code extension that integrates OpenAI-compatible inference providers into GitHub Copilot Chat. It enables users to use frontier LLMs (Qwen3 Coder, Kimi K2, DeepSeek V3.2, GLM 4.6, etc.) through any OpenAI-compatible API provider.

## Architecture Patterns

### Core Components
1. **Provider System** (`src/provider.ts`): Main entry point implementing `LanguageModelChatProvider` - handles model selection, token counting, and request routing
2. **API Abstraction Layer** (`src/commonApi.ts`): Base class with tool call buffering, thinking content parsing, and streaming response handling
3. **Specific API Implementations**:
   - `src/openai/openaiApi.ts` - OpenAI-compatible API (supports reasoning, vision, tools)
   - `src/openai/openaiResponsesApi.ts` - OpenAI Responses API (newer format with separate input/output structure)
   - `src/ollama/ollamaApi.ts` - Ollama native API (different message format)
   - `src/anthropic/anthropicApi.ts` - Anthropic Claude API (separate message structure)
   - `src/gemini/geminiApi.ts` - Gemini native API (Google's Gemini models)
4. **Type System** (`src/types.ts`): Centralized type definitions for `HFModelItem` with extensive configuration options
5. **Utility Functions** (`src/utils.ts`): Shared helpers for retry logic, tool conversion, image handling, and model ID parsing
6. **Config View** (`src/views/configView.ts`): Webview-based UI for managing providers and models
7. **Model Information** (`src/provideModel.ts`): Fetches and prepares available models from API or user configuration

### Key Design Decisions
- **Multi-provider support**: Users can configure models from multiple providers simultaneously with provider-specific API keys
- **Configuration IDs**: Model IDs can include `::configId` suffix for different configurations of the same model (e.g., `glm-4.6::thinking`, `glm-4.6::no-thinking`)
- **Retry mechanism**: Automatic retry for HTTP errors (429, 500, 502, 503, 504) with exponential backoff via `createRetryConfig()` and `executeWithRetry()`
- **Thinking support**: Integration with VS Code's `languageModelThinkingPart` proposal for reasoning models like DeepSeek V3.2
- **XML think detection**: Automatic detection of XML think blocks in streaming responses via `_xmlThinkActive` state and `_thinkingBuffer` accumulation
- **API Mode Selection**: Models can specify `apiMode: "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini"` to use different underlying APIs
- **Request Delay Control**: Global (`oaicopilot.delay`) and per-model (`delay`) configuration to throttle consecutive requests and avoid rate limiting
- **Custom Headers Support**: Model-specific HTTP headers via `headers` field for authentication, versioning, or custom provider requirements
- **Family-based Optimizations**: `family` field enables model-specific behaviors (gpt-4, claude-3, gemini, oai-compatible)

## Development Workflows

### Build Commands
```bash
npm run compile        # TypeScript compilation to `out/` directory
npm run lint           # ESLint checking with TypeScript ESLint rules
npm run format         # Prettier formatting (configured in .prettierrc)
npm run watch          # Continuous TypeScript compilation in background
```

### Testing & Debugging
- **Run Extension**: Use VS Code's "Run Extension" launch configuration (F5)
- **Extension Tests**: Use "Extension Tests" launch configuration (requires `npm: watch-tests` task)
- **Watch Tasks**: Two background tasks run automatically in VS Code:
  - `npm: watch` - TypeScript compilation on file changes
  - `npm: watch-tests` - Test compilation for extension tests
- **Debugging**: Set breakpoints in TypeScript files, source maps are enabled in `tsconfig.json`

### VS Code Integration
- **API Proposals**: Uses `chatProvider` and `languageModelThinkingPart` proposals (enabled in `package.json`)
- **Secret Storage**: API keys stored via `vscode.SecretStorage` with prefixes (`oaicopilot.apiKey` for global, `oaicopilot.apiKey.{provider}` for provider-specific)
- **Status Bar**: Token usage displayed in status bar (`src/statusBar.ts`) - updates on each request
- **Extension Dependencies**: Requires `github.copilot-chat` extension
- **Configuration**: Models defined in `oaicopilot.models` array in VS Code settings

## Code Conventions

### TypeScript Patterns
- **Strict mode**: Enabled in `tsconfig.json` with `strict: true`
- **ES2024 target**: Modern JavaScript features
- **Module resolution**: `Node16` module system
- **Type imports**: Use `import type` for type-only imports (e.g., `import type { HFModelItem } from "./types"`)
- **Code comments**: Write in English, include JSDoc-style comments for public APIs
- **ESLint rules**: Configured in `eslint.config.mjs` with TypeScript ESLint and stylistic rules

### Error Handling
- **Retry logic**: Implement retry with `createRetryConfig()` and `executeWithRetry()` from `utils.ts`
- **HTTP errors**: Retry on specific status codes (429, 500, 502, 503, 504) with exponential backoff
- **User feedback**: Show appropriate messages via `vscode.window.showInformationMessage()` or `showErrorMessage()`
- **Streaming errors**: Handle errors gracefully in streaming responses without breaking the UI

### Model Configuration
- **Model items**: Defined in `HFModelItem` interface (`src/types.ts`) with extensive options
- **Provider-specific keys**: Support for multiple API keys via `oaicopilot.setProviderApikey` command
- **Configuration inheritance**: Model-specific `baseUrl` falls back to global `oaicopilot.baseUrl`
- **Family field**: Use `family: "gpt-4" | "claude-3" | "gemini" | "oai-compatible"` for model-specific optimizations
- **API mode**: Specify `apiMode: "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini"` to select underlying API implementation
- **Include reasoning in request**: Set `include_reasoning_in_request: true` for models like DeepSeek V3.2 to include reasoning content in assistant messages
- **Request delay**: Configure `delay` (per-model) or `oaicopilot.delay` (global) to throttle consecutive requests
- **Custom headers**: Add `headers` object for model-specific HTTP headers (authentication, versioning, etc.)

### Message Conversion
- **Role mapping**: Convert VS Code chat roles to provider-specific roles using `mapRole()` utility
- **Content handling**: Support for text, images (via data URLs using `createDataUrl()`), and tool calls
- **Thinking parts**: Parse and emit `LanguageModelThinkingPart` for reasoning models via `_thinkingBuffer`
- **Tool call buffering**: Assemble streaming tool calls using `_toolCallBuffers` in `CommonApi` base class

## File Organization

### Source Structure
```
src/
├── extension.ts              # Extension activation and command registration
├── provider.ts              # Main provider implementing LanguageModelChatProvider
├── commonApi.ts             # Base API class with streaming and tool call handling
├── types.ts                 # Type definitions (HFModelItem, HFApiMode, etc.)
├── utils.ts                 # Utility functions (retry, tool conversion, image handling)
├── statusBar.ts             # Status bar integration for token counting
├── provideModel.ts          # Model information provider and API fetching
├── provideToken.ts          # Token counting implementation
├── vscode.proposed.*.d.ts   # VS Code API proposal type definitions
├── openai/                  # OpenAI-compatible API implementation
│   ├── openaiApi.ts         # Main OpenAI API class
│   ├── openaiResponsesApi.ts # OpenAI Responses API (newer format with separate input/output structure)
│   └── openaiTypes.ts       # OpenAI-specific type definitions
├── ollama/                  # Ollama API implementation
│   ├── ollamaApi.ts         # Main Ollama API class
│   └── ollamaTypes.ts       # Ollama-specific type definitions
├── anthropic/               # Anthropic API implementation
│   ├── anthropicApi.ts      # Main Anthropic API class
│   └── anthropicTypes.ts    # Anthropic-specific type definitions
├── gemini/                  # Gemini native API implementation
│   ├── geminiApi.ts         # Main Gemini API class
│   └── geminiTypes.ts       # Gemini-specific type definitions
└── views/                   # UI components
    └── configView.ts        # Webview-based configuration UI
```

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