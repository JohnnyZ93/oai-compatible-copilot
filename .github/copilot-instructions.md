# OAI Compatible Copilot - AI Agent Guidelines

## Project Overview
This is a VS Code extension that integrates OpenAI-compatible inference providers into GitHub Copilot Chat. It enables users to use frontier LLMs (Qwen3 Coder, Kimi K2, DeepSeek V3.2, GLM 4.6, etc.) through any OpenAI-compatible API provider.

## Architecture Patterns

### Core Components
1. **Provider System** (`src/provider.ts`): Main entry point implementing `LanguageModelChatProvider`
2. **API Abstraction Layer** (`src/commonApi.ts`): Base class for all API implementations
3. **Specific API Implementations**:
   - `src/openai/openaiApi.ts` - OpenAI-compatible API
   - `src/ollama/ollamaApi.ts` - Ollama local API
   - `src/anthropic/anthropicApi.ts` - Anthropic Claude API
4. **Type System** (`src/types.ts`): Centralized type definitions for model configurations
5. **Utility Functions** (`src/utils.ts`): Shared helpers for retry logic, tool conversion, etc.

### Key Design Decisions
- **Multi-provider support**: Users can configure models from multiple providers simultaneously
- **Configuration IDs**: Model IDs can include `::configId` suffix for different configurations of the same model
- **Retry mechanism**: Automatic retry for HTTP errors (429, 500, 502, 503, 504) with exponential backoff
- **Thinking support**: Integration with VS Code's `languageModelThinkingPart` proposal for reasoning content

## Development Workflows

### Build Commands
```bash
npm run compile        # TypeScript compilation
npm run lint           # ESLint checking
npm run format         # Prettier formatting
```

### Testing & Debugging
- **Run Extension**: Use VS Code's "Run Extension" launch configuration
- **Extension Tests**: Use "Extension Tests" launch configuration (requires `tasks: watch-tests`)
- **Watch Tasks**: Two background tasks run automatically:
  - `npm: watch` - TypeScript compilation
  - `npm: watch-tests` - Test compilation

### VS Code Integration
- **API Proposals**: Uses `chatProvider` and `languageModelThinkingPart` proposals
- **Secret Storage**: API keys stored via `vscode.SecretStorage`
- **Status Bar**: Token usage displayed in status bar (`src/statusBar.ts`)

## Code Conventions

### TypeScript Patterns
- **Strict mode**: Enabled in `tsconfig.json`
- **ES2024 target**: Modern JavaScript features
- **Module resolution**: `Node16` module system
- **Type imports**: Use `import type` for type-only imports
- write code comments in English.

### Error Handling
- **Retry logic**: Implement retry with `createRetryConfig()` and `executeWithRetry()` from `utils.ts`
- **HTTP errors**: Retry on specific status codes (429, 500, 502, 503, 504)
- **User feedback**: Show appropriate messages via `vscode.window.showInformationMessage()`

### Model Configuration
- **Model items**: Defined in `HFModelItem` interface (`src/types.ts`)
- **Provider-specific keys**: Support for multiple API keys via `oaicopilot.setProviderApikey` command
- **Configuration inheritance**: Model-specific `baseUrl` falls back to global `oaicopilot.baseUrl`

### Message Conversion
- **Role mapping**: Convert VS Code chat roles to provider-specific roles in API implementations
- **Content handling**: Support for text, images (via data URLs), and tool calls
- **Thinking parts**: Parse and emit `LanguageModelThinkingPart` for reasoning models

## File Organization

### Source Structure
```
src/
├── extension.ts              # Extension activation
├── provider.ts              # Main provider implementation
├── commonApi.ts             # Base API class
├── types.ts                 # Type definitions
├── utils.ts                 # Utility functions
├── statusBar.ts             # Status bar integration
├── provideModel.ts          # Model information provider
├── provideToken.ts          # Token counting
├── openai/                  # OpenAI-compatible API
├── ollama/                  # Ollama API
└── anthropic/               # Anthropic API
```

### Configuration Files
- `package.json` - Extension metadata and dependencies
- `tsconfig.json` - TypeScript configuration
- `eslint.config.mjs` - ESLint configuration (ES modules)
- `.prettierrc` - Code formatting rules

## Integration Points

### VS Code APIs
- `vscode.lm.registerLanguageModelChatProvider()` - Register chat provider
- `vscode.SecretStorage` - Secure API key storage
- `vscode.StatusBarItem` - Display token usage
- `vscode.commands.registerCommand()` - Extension commands

### External Dependencies
- **No runtime dependencies** - Extension uses VS Code APIs only
- **Dev dependencies**: TypeScript, ESLint, Prettier, VS Code test utilities
- **API Proposals**: Experimental VS Code APIs enabled via `enabledApiProposals`

## Common Tasks

### Adding New API Provider
1. Create new directory under `src/` (e.g., `src/newprovider/`)
2. Create API class extending `CommonApi`
3. Implement `convertMessages()` and `sendRequest()` methods
4. Add to provider instantiation logic in `provider.ts`
5. Update type definitions if needed

### Modifying Model Configuration
1. Update `HFModelItem` interface in `src/types.ts`
2. Update configuration parsing in `src/provider.ts`
3. Update API implementations to handle new fields
4. Update documentation in `README.md`

### Testing Changes
1. Run `npm run watch` in background
2. Use "Run Extension" launch configuration
3. Test in Extension Development Host window
4. Check status bar updates and error handling

## Important Notes
- **API Key Management**: Users can set global or provider-specific API keys
- **Model Families**: `family` field enables model-specific optimizations
- **Vision Support**: Enabled via `vision: true` in model configuration
- **Tool Support**: Convert VS Code tools to OpenAI function definitions
- **Streaming**: Support for streaming responses with tool call buffering

## Troubleshooting
- **Compilation errors**: Check TypeScript strict mode requirements
- **API errors**: Verify retry logic in `utils.ts`
- **Missing models**: Check `provideLanguageModelChatInformation()` in `provider.ts`
- **Thinking not working**: Ensure `languageModelThinkingPart` proposal is enabled