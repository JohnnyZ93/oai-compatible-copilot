# Change Log

## 0.2.5 (2026-01-19)

- Fix: Prevent simultaneous `max_tokens` and `max_completion_tokens` configuration to avoid API conflicts.
- Feat(openai-responses): Add stateful `previous_response_id` support for conversation continuity.
- Feat: Add `oaicopilot.commitLanguage` configuration for commit messages. Users can now select from 14 supported languages via the settings interface.

Thanks to:
 - @matchs for contributing the [PR #118](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/118).
 - @Andy963 for contributing the [PR #119](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/119).

## 0.2.4 (2026-01-15)

- Feat(openai-responses): enhance streaming response handling.

## 0.2.3 (2026-01-14)

- Fix(anthropic): avoid double /v1 suffix when baseUrl already includes version.
- Refactor: update `OpenAI responses` interface and supports Volcengine provider.
- Feat: add model `family` and system prompts documentation to README. (Include: Anthropic, Gemini, xAI, OpenAI)
- Refactor: simplify temperature handling in API implementations. Now You can delete `temperature` in request.

Thanks to @matchs for contributing the [PR #111](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/111).

## 0.2.2 (2026-01-12)

- Feat: Add git commit message generation button on Souce Control Panel
- Feat(thinking): show reasoning summaries in Copilot (OpenAI Responses + Gemini)
- Fix: add default thinking content for empty reasoning
- Fix: add conditional reasoning token counting on statusBarItem

Thanks to @Andy963 for contributing the [PR #104](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/104).

## 0.2.1 (2026-01-04)

Thanks to @Andy963 for contributing the [PR #89](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/89):

- Feat: Add OpenAI Responses API mode (`apiMode: "openai-responses"`, endpoint `/responses`).
- Feat: Add Gemini native API mode (`apiMode: "gemini"`, endpoint `.../v1beta/models/{model}:streamGenerateContent?alt=sse`).
- Fix: Preserve Gemini `thoughtSignature` for tool-calling follow-up requests (required by newer Gemini thinking models).
- Fix: Accept `provider` / `provide` as aliases of `owned_by` in `oaicopilot.models`.
- Fix: Anthropic mode sends `anthropic-version: 2023-06-01` and includes request URL in errors for easier relay debugging.

## 0.2.0 (2025-12-25)

- Fix: [Text content blocks must be non-empty on Anthropic api](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/79)
- Fix: [Edit modelId and providerId on configuration UI.](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/85)

## 0.1.9 (2025-12-24)

- Feat: [Make top_p optional in request body.](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/81)
- Feat: [Add Model-specific delay configuration.](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/74)
- Feat: [Add Model Configuration UI](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/68)
- Enhanced `oaicopilot.models` configuration including:
  - `delay`: Model-specific delay in milliseconds between consecutive requests. If not specified, falls back to global `oaicopilot.delay` configuration.
- New Command `OAICopilot: Open Configuration UI`.

## 0.1.8 (2025-12-17)

- Feat: [Add Ollama /api/chat](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/65)
- Feat: [Add Anthropic /v1/messages](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/60)
- Enhanced `oaicopilot.models` configuration including:
  - `apiMode`: API mode: 'openai' (Default) for API (/v1/chat/completions), 'ollama' for API (/api/chat), 'anthropic' for API (/v1/messages).

## 0.1.7 (2025-12-10)

- Feat: [Expand oaicopilot.retry to handle other type of errors](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/62)
- Fix: [Add buffer for think content](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/61)
- Add `oaicopilot.retry` configuration including:
  > Retry configuration for handling api errors like [429, 500, 502, 503, 504].
  - `status_codes`: Additional HTTP status codes that will be merged. Default is [429, 500, 502, 503, 504].

## 0.1.6 (2025-12-08)

- Feat: [Сontext window state in statusBar](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/59)

## 0.1.5 (2025-12-05)

- Fix: [Deepseek v3.2 reasoning tool call failed](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/54)
- Enhanced `oaicopilot.models` configuration including:
  - `include_reasoning_in_request`: Whether to include reasoning_content in assistant messages sent to the API. Support deepseek-v3.2 or others.

## 0.1.4 (2025-11-03)

- Feat: [Add headers support](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/31)
- Feat: [Add displayName option for models in Copilot interface](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/32)
- Enhanced `oaicopilot.models` configuration including:
  - `displayName`: Display name for the model that will be shown in the Copilot interface.
  - `headers`: Custom HTTP headers to be sent with every request to this model's provider (e.g., `{"X-API-Version": "v1", "X-Custom-Header": "value"}`).

## 0.1.3 (2025-10-31)

- Fix: [Forces a prompt to set the default API key every time VS Code starts](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/30)

## 0.1.2 (2025-10-29)

- Feat: [add support for extra configuration parameters](https://github.com/JohnnyZ93/oai-compatible-copilot/pull/28)
- Enhanced `oaicopilot.models` configuration including:
  - `extra`: Extra request parameters that will be used in /chat/completions.

## 0.1.1 (2025-10-28)

- Fix: Cannot change apiKey when the `oaicopilot.models` have no baseUrl.

## 0.1.0 (2025-10-28)

- Feat: [Add request delay to prevent 429 Errors](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/24)
- Fix: [Not Asking for Key when add new provider](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/26)
- Add `oaicopilot.delay` configuration: Fixed delay in milliseconds between consecutive requests. Default is 0 (no delay).

## 0.0.9 (2025-10-27)

- Feat: [Add Retry Mechanism for Model 429 Errors](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/24)
- Fix: [Thinking block not end and show in new chat](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/25)
- Add `oaicopilot.retry` configuration including:
  > Retry configuration for handling api errors like [429, 500, 502, 503, 504].
  - `enabled`: Enable retry mechanism for api errors. Default is true.
  - `max_attempts`: Maximum number of retry attempts. Default is 3.
  - `interval_ms`: Interval between retry attempts in milliseconds. Default is 1000 (1 seconds).

## 0.0.8 (2025-10-21)

- Fix: [LLM output missing `<`](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/19)
- Remove inline tool call response processing, significantly accelerating model response speed.

## 0.0.7 (2025-10-15)

- Feat: [`<think>` block is not detected properly for Perplexity Sonar models](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/21)
- Update VS Code proposed api version.

## 0.0.6 (2025-10-10)

- Feat: [OpenAI use `max_completion_tokens` instead of `max_tokens` for GPT-5](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/19)
- Enhanced `oaicopilot.models` configuration including:
  - `max_completion_tokens`: Maximum number of tokens to generate (OpenAI new standard parameter)
  - `reasoning_effort`: Reasoning effort level (OpenAI reasoning configuration)


## 0.0.5 (2025-10-09)

- Feat: [GLM 4.6 - no thinking tags](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/15)
- Feat: [Multi-config for the same model](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/18)
- Enhanced `oaicopilot.models` configuration including:
  - `configId`: Configuration ID for this model. Allows defining the same model with different settings (e.g. 'glm-4.6::thinking', 'glm-4.6::no-thinking')
  - `thinking`: Thinking configuration for Zai provider
    - `type`: Set to 'enabled' to enable thinking, 'disabled' to disable thinking

## 0.0.4 (2025-09-23)

- Fix: [Base url should be model specific](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/4)
- Fix: [Set the effort variable of the reasoning model](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/5)
- Fix: [Allow setting a custom model 'family'](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/8)

## 0.0.3 (2025-09-18)

- Now you can see the model reasoning content in chat interface.
  > ![thinkingPartDemo](./assets/thinkingPartDemo.png)
- Fix: [Thinking Budget #2](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/2)
- Fix: [iflow api key no response was returned #1](https://github.com/JohnnyZ93/oai-compatible-copilot/issues/1)

## 0.0.2 (2025-09-18)

- Deleted settings including:
  - `oaicopilot.enableThinking`
  - `oaicopilot.maxTokens`
  - `oaicopilot.temperature`
  - `oaicopilot.topP`
- Enhanced `oaicopilot.models` configuration with support for per-model settings including:
  - `max_tokens`: Maximum number of tokens to generate
  - `enable_thinking`: Switches between thinking and non-thinking modes
  - `temperature`: Sampling temperature (range: [0, 2])
  - `top_p`: Top-p sampling value (range: (0, 1])
  - `top_k`: Top-k sampling value
  - `min_p`: Minimum probability threshold
  - `frequency_penalty`: Frequency penalty (range: [-2, 2])
  - `presence_penalty`: Presence penalty (range: [-2, 2])
  - `repetition_penalty`: Repetition penalty (range: (0, 2])
- Improved token estimation algorithm with better support for Chinese characters
- Enhanced multi-modal message handling for image and text content

## 0.0.1 (2025-09-16)

- Initial release
