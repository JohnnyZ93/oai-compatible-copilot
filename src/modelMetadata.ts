/**
 * Model metadata lookup backed by models.dev (https://models.dev/api.json).
 *
 * Provider `/models` endpoints are notoriously inconsistent: OpenAI returns only
 * `{ id, object, created, owned_by }`, OpenRouter returns rich metadata, Gemini uses
 * `inputTokenLimit`/`outputTokenLimit`. Rather than guessing field names per provider,
 * we resolve the model id against a curated catalog that carries the authoritative
 * capability flags (tool calling, vision, reasoning) and token limits.
 *
 * The catalog is fetched lazily and cached in memory for the lifetime of the process.
 */

import type { HFModelItem } from "./types";

const MODELS_DEV_API = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 8000;

/** Normalized metadata for a single model. */
export interface ModelMetadata {
	/** Whether the model supports tool/function calling. */
	toolCall?: boolean;
	/** Whether the model accepts image input. */
	vision?: boolean;
	/** Whether the model performs chain-of-thought reasoning. */
	reasoning?: boolean;
	/** Maximum context window in tokens. */
	contextLength?: number;
	/** Maximum output tokens. */
	maxOutputTokens?: number;
	/** Whether the model accepts a custom `temperature`. */
	temperature?: boolean;
	/** Human readable name. */
	displayName?: string;
	/** Model family (e.g. "gpt", "claude", "gemini"). */
	family?: string;
}

/** models.dev entry shape (only the fields we consume). */
interface ModelsDevEntry {
	id?: string;
	name?: string;
	family?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	attachment?: boolean;
	temperature?: boolean;
	modalities?: { input?: string[]; output?: string[] };
	limit?: { context?: number; output?: number };
}

interface ModelsDevProvider {
	models?: Record<string, ModelsDevEntry>;
}
type ModelsDevCatalog = Record<string, ModelsDevProvider>;

let cachedCatalog: ModelsDevCatalog | undefined;
let inFlight: Promise<ModelsDevCatalog | undefined> | undefined;

/** Fetch and cache the models.dev catalog. Resolves to undefined on any failure. */
async function loadCatalog(): Promise<ModelsDevCatalog | undefined> {
	if (cachedCatalog) {
		return cachedCatalog;
	}
	if (inFlight) {
		return inFlight;
	}

	inFlight = (async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const resp = await fetch(MODELS_DEV_API, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
			if (!resp.ok) {
				throw new Error(`models.dev responded ${resp.status}`);
			}
			const parsed = (await resp.json()) as ModelsDevCatalog;
			if (!parsed || typeof parsed !== "object") {
				throw new Error("models.dev returned an unexpected payload");
			}
			cachedCatalog = parsed;
			return parsed;
		} catch (err) {
			console.error("[oaicopilot] Failed to load models.dev catalog", err);
			return undefined;
		} finally {
			clearTimeout(timer);
			inFlight = undefined;
		}
	})();

	return inFlight;
}

/** Lowercase and strip common vendor/date decorations for tolerant matching. */
function normalizeId(id: string): string {
	return id
		.toLowerCase()
		.replace(/^models\//, "")
		.replace(/@latest$/, "")
		.replace(/[_-]\d{8}$/, "")
		.trim();
}

/** Build a lookup index of normalized id -> metadata across all providers. */
function buildIndex(catalog: ModelsDevCatalog): Map<string, ModelMetadata> {
	const index = new Map<string, ModelMetadata>();

	for (const provider of Object.values(catalog)) {
		const models = provider?.models;
		if (!models || typeof models !== "object") {
			continue;
		}
		for (const entry of Object.values(models)) {
			if (!entry || typeof entry.id !== "string") {
				continue;
			}
			const meta: ModelMetadata = {
				toolCall: typeof entry.tool_call === "boolean" ? entry.tool_call : undefined,
				vision: Array.isArray(entry.modalities?.input) ? entry.modalities!.input!.includes("image") : undefined,
				reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
				contextLength: typeof entry.limit?.context === "number" ? entry.limit.context : undefined,
				maxOutputTokens: typeof entry.limit?.output === "number" ? entry.limit.output : undefined,
				temperature: typeof entry.temperature === "boolean" ? entry.temperature : undefined,
				displayName: typeof entry.name === "string" ? entry.name : undefined,
				family: typeof entry.family === "string" ? entry.family : undefined,
			};
			const key = normalizeId(entry.id);
			// First writer wins so a canonical vendor entry is not overwritten by a reseller.
			if (!index.has(key)) {
				index.set(key, meta);
			}
		}
	}

	return index;
}

let cachedIndex: Map<string, ModelMetadata> | undefined;

/**
 * Look up metadata for a model id.
 * @param id The raw model id reported by the provider.
 * @returns Normalized metadata, or undefined when the catalog is unavailable or has no match.
 */
export async function lookupModelMetadata(id: string): Promise<ModelMetadata | undefined> {
	if (!id) {
		return undefined;
	}
	const catalog = await loadCatalog();
	if (!catalog) {
		return undefined;
	}
	if (!cachedIndex) {
		cachedIndex = buildIndex(catalog);
	}

	const key = normalizeId(id);
	return cachedIndex.get(key);
}

/**
 * Enrich a provider-reported model with catalog metadata.
 * Catalog values take precedence over provider-reported values because they are curated;
 * provider values are kept as a fallback when the catalog has no entry.
 */
export async function enrichModelMetadata(model: HFModelItem): Promise<HFModelItem> {
	const meta = await lookupModelMetadata(model.id);
	if (!meta) {
		return model;
	}

	const enriched: HFModelItem = { ...model };
	if (meta.displayName && !model.displayName) {
		enriched.displayName = meta.displayName;
	}
	if (meta.contextLength !== undefined) {
		enriched.context_length = meta.contextLength;
	}
	if (meta.maxOutputTokens !== undefined) {
		enriched.max_completion_tokens = meta.maxOutputTokens;
	}
	if (meta.vision !== undefined) {
		enriched.vision = meta.vision;
	}
	if (meta.toolCall !== undefined) {
		enriched.supportsTools = meta.toolCall;
	}
	if (meta.family && !model.family) {
		enriched.family = meta.family;
	}
	return enriched;
}

/** Reset the in-memory cache. Exposed for tests. */
export function resetModelMetadataCache() {
	cachedCatalog = undefined;
	cachedIndex = undefined;
	inFlight = undefined;
}
