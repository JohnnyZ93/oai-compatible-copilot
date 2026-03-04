# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Build/Test/Lint Commands
```bash
npm run compile        # Build TypeScript
npm run watch          # Build in watch mode
npm run lint           # Run ESLint
npm run format         # Format with Prettier
npm run test           # Run tests (compile + vscode-test)
npm run build          # Package extension to .vsix
npm run download-api   # Download VS Code proposed API types (required after vscode.d.ts updates)
```

## Architecture
- **Entry**: `src/extension.ts` - registers `HuggingFaceChatModelProvider` under vendor id `oaicopilot`
- **Core Provider**: `src/provider.ts` - implements `LanguageModelChatProvider` interface
- **API Providers**: `src/openai/`, `src/ollama/`, `src/anthropic/`, `src/gemini/` - each handles provider-specific API

## Key Conventions
- Uses VS Code proposed API `chatProvider` - types in `src/vscode.proposed.*.d.ts`
- API keys stored via `vscode.SecretStorage` with keys `oaicopilot.apiKey` or `oaicopilot.apiKey.{provider}`
- Model config via `oaicopilot.models` setting (see `src/types.ts` for `HFModelItem`)
- Supports multi-provider: same model can have different `configId` for different settings

## Code Style (from eslint.config.mjs)
- Semicolons required (`@stylistic/semi`)
- Curly braces required (`curly`)
- Unused vars with `_` prefix are ignored
