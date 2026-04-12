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
	 * By default, uses the extension identifier. When useBrowserUserAgent setting is enabled,
	 * uses a Chrome-like User-Agent to avoid Cloudflare 1010 blocking.
	 */
	static getUserAgent(): string {
		const config = vscode.workspace.getConfiguration("oaicopilot");
		const useBrowserUA = config.get<boolean>("useBrowserUserAgent", false);

		if (useBrowserUA) {
			// Use a standard Chrome User-Agent to avoid Cloudflare 1010 errors
			// that block non-browser signatures
			return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.0";
		}

		// Default: use extension identifier
		const vscodeVersion = vscode.version;
		return `oai-compatible-copilot/${this.getVersion()} VSCode/${vscodeVersion}`;
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
