# 🤗 OAI Compatible Provider for Copilot

[![CI](https://github.com/JohnnyZ93/oai-compatible-copilot/actions/workflows/release.yml/badge.svg)](https://github.com/JohnnyZ93/oai-compatible-copilot/actions)
[![License](https://img.shields.io/github/license/JohnnyZ93/oai-compatible-copilot?color=orange&label=License)](https://github.com/JohnnyZ93/oai-compatible-copilot/blob/main/LICENSE)

Use frontier open LLMs like Qwen3 Coder, Kimi K2, DeepSeek V3.1, GLM 4.5 and more in VS Code with GitHub Copilot Chat powered by any OpenAI-compatible provider 🔥

## ✨ Why Use the OAI Compatible Provider in Copilot
- Supports almost all OpenAI-compatible providers, such as ModelScope, SiliconFlow, DeepSeek...
- Supports vision models.
- Offers additional configuration options for chat requests.
- Supports control model thinking and reasoning content show in chat interface.
  > ![thinkingPartDemo](./assets/thinkingPartDemo.png)
- Supports configuring models from multiple providers simultaneously, automatically managing API keys without switch them repeatedly.
---

## ⚡ Quick Start
1. Install the OAI Compatible Provider for Copilot extension [here](https://marketplace.visualstudio.com/items?itemName=johnny-zhao.oai-compatible-copilot).
2. Open VS Code Settings and configure `oaicopilot.baseUrl` and `oaicopilot.models`.
3. Open VS Code's chat interface.
4. Click the model picker and select "Manage Models...".
5. Choose "OAI Compatible" provider.
6. Enter your API key — it will be saved locally.
   - For multiple providers, configuring baseUrl in `oaicopilot.models` firstly.
   - Use the command "OAICopilot: Set OAI Compatible Multi-Provider Apikey" to configure provider-specific API keys.
7. Select the models you want to add to the model picker.

### Requirements
- VS Code 1.104.0 or higher.
- OpenAI-compatible provider API key.

### Settings Example

```json
"oaicopilot.baseUrl": "https://api-inference.modelscope.cn/v1",
"oaicopilot.models": [
    {
        "id": "Qwen/Qwen3-Next-80B-A3B-Instruct",
        "owned_by": "modelscope",
        "context_length": 256000,
        "max_tokens": 8192,
        "temperature": 0,
        "top_p": 1,
        "enable_thinking": true,
        "reasoning": {
            "enabled": true,
            "effort": "high",
            "exclude": false
        }
    },
    {
        "id": "gpt-5-turbo",
        "owned_by": "custom-provider",
        "baseUrl": "https://api.custom-provider.com/v1",
        "family": "gpt-5",
        "context_length": 128000,
        "max_tokens": 4096
    }
]
```

**Optional parameters:**
- `family`: Specify model family (e.g., `gpt-4`, `claude-3`, `gemini`) to enable model-specific optimizations. Defaults to `oai-compatible`.
- `baseUrl`: Model-specific base URL. If not provided, the global `oaicopilot.baseUrl` will be used.
- `enable_thinking`: Enable model thinking and reasoning content (for non-OpenRouter providers).
- `reasoning`: OpenRouter reasoning configuration with options like `enabled`, `effort`, `exclude`, and `max_tokens`.
---

## 🛠️ Development
```bash
git clone https://github.com/JohnnyZ93/oai-compatible-copilot
cd oai-compatible-copilot
npm install
npm run compile
```
Press F5 to launch an Extension Development Host.

Common scripts:
- Build: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`
- Format: `npm run format`
- Publish: `npx @vscode/vsce package -o extension.vsix`

---

## Thanks to

Thanks to all the people who contribute.

- [Contributors](https://github.com/JohnnyZ93/oai-compatible-copilot/graphs/contributors)
- [Hugging Face Chat Extension](https://github.com/huggingface/huggingface-vscode-chat)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

---

## Support & License
- Open issues: https://github.com/JohnnyZ93/oai-compatible-copilot/issues
- License: MIT License Copyright (c) 2025 Johnny Zhao
