# AGENTS.md

This file provides guidance to AI Agent when working with code in this repository.

## Project Overview

This is a VS Code extension that integrates OpenAI-compatible inference providers into GitHub Copilot Chat. It allows users to use frontier open LLMs like Qwen3 Coder, Kimi K2, DeepSeek V3.1, GLM 4.5 and more in VS Code with GitHub Copilot Chat.

## Key Components

1. **Extension Entry Point**: `src/extension.ts` - Registers the language model chat provider and API key management command
2. **Provider Implementation**: `src/provider.ts` - Main implementation of the `HuggingFaceChatModelProvider` class that handles:
   - Model listing and configuration
   - Chat request processing
   - Streaming response handling
   - Tool calling support
   - Token counting
3. **Utility Functions**: `src/utils.ts` - Helper functions for:
   - Message and tool conversion between VS Code and OpenAI formats
   - Schema sanitization
   - JSON parsing
4. **Type Definitions**: `src/types.ts` - TypeScript interfaces for API responses and internal data structures

## Development Commands

- **Build**: `npm run compile`
- **Watch**: `npm run watch`
- **Lint**: `npm run lint`
- **Format**: `npm run format`
- **Test**: `npm run test`
- **Package**: `npx @vscode/vsce package -o extension.vsix`

## Architecture Notes

- The extension uses VS Code's Language Model Chat Provider API to integrate with Copilot
- It supports both user-configured models and dynamic model fetching from provider APIs
- Implements streaming response processing with SSE-like protocol
- Supports tool calling with custom control token parsing for text-embedded tool calls
- Handles multi-modal content (text and images)
- Provides custom token estimation logic for different content types
- Supports advanced model parameters like temperature, top_p, enable_thinking, etc.

## Configuration

Users can configure:
- `oaicopilot.baseUrl`: The base URL for the OpenAI Compatible Inference API
- `oaicopilot.models`: Array of preferred models with detailed configuration options