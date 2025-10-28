# Change Log

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