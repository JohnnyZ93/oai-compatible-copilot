import * as vscode from "vscode";

export class VersionManager {
	private static _version: string | null = null;

	/**
	 * Get the current extension version
	 */
	static getVersion(): string {
		if (this._version === null) {
			const extension = vscode.extensions.getExtension("johnny-zhao.oai-compatible-copilot");
			this._version = extension?.packageJSON?.version ?? "unknown";
		}
		return this._version!;
	}

	/**
	 * Build a User-Agent for API requests.
	 * Master switch: useBrowserUserAgent
	 * - When false: Always use default extension identifier UA
	 * - When true: Use customUserAgent if set, otherwise Chrome-like UA
	 */
	static getUserAgent(): string {
		const config = vscode.workspace.getConfiguration("oaicopilot");
		const useBrowserUA = config.get<boolean>("useBrowserUserAgent", false);

		// Master switch off: always use default extension UA
		if (!useBrowserUA) {
			const vscodeVersion = vscode.version;
			return `oai-compatible-copilot/${this.getVersion()} VSCode/${vscodeVersion}`;
		}

		// Master switch on: check for custom UA first
		const customUA = config.get<string>("customUserAgent", "");
		if (customUA && customUA.trim()) {
			return customUA.trim();
		}

		// Fallback to Chrome User-Agent to avoid Cloudflare 1010 errors
		return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.0";
	}

	/**
	 * Get the current extension information
	 */
	static getClientInfo(): { name: string; version: string; author: string } {
		return {
			name: "oai-compatible-copilot",
			version: this.getVersion(),
			author: "johnny-zhao",
		};
	}
}
