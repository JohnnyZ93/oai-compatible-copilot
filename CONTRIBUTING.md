# Contributing Guide

Thanks for taking the time to start contributing. This guide will help you get started with the project.

Also the project welcome serious and willing maintainers.

## How to contribute?

### Creating an Issue

For anything else than a typo or a bug fix, please raise an issue to discuss your proposal before submitting any code.

### License for contributions

As the copyright owner, you agree to license your contributions under an irrevocable MIT license.

### For Developers: Creating a Pull Request

**Requirements:**
- VS Code 1.104.0 or higher.
- Node.js 22.
- Your OpenAI-compatible provider API key.

```bash
git clone https://github.com/JohnnyZ93/oai-compatible-copilot
cd oai-compatible-copilot
npm install
npm run compile
```
Press F5 to launch an Extension Development Host.

**Common scripts:**
- Build: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`
- Format: `npm run format`

### Tests

You should use your own OpenAI-compatible provider API key for test.