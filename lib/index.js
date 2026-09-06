/**
 * dsh-web-search-linkup — Linkup `/search` provider for the DSH web seam (ctx.web).
 *
 * Registers under provider id "linkup"; select it with the bundled patch (auto-applied
 * when installed via `dsh plugin --profile web add`), or pin manually:
 *   - id: web
 *     name: '@deepseek-ai/dsh-web'
 *     config: { searchProvider: linkup, fetchProvider: http }
 *
 * Config (plain object; cordis passes it through unchanged):
 *   apiKey             literal key (last resort; prefer credentials)
 *   apiKeyEnv          credential/env name for the key   (default LINKUP_API_KEY)
 *   baseURL            API base                          (default https://api.linkup.so/v1)
 *   allowCustomBaseURL opt-in to non-official https endpoints (key-exfiltration guard)
 *   depth              fast | standard | deep            (default standard)
 *   timeoutMs          per-request ceiling               (default 25000)
 *
 * Zero runtime dependencies. Uses the host's WebError when resolvable for typed
 * error codes; otherwise falls back to an equivalent local error shape.
 */
const PROVIDER_ID = "linkup";
const DEPTHS = new Set(["fast", "standard", "deep"]);
const OFFICIAL_BASE_URLS = new Set(["https://api.linkup.so", "https://api.linkup.so/v1"]);
const DEFAULT_API_KEY_ENV = "LINKUP_API_KEY";
const DEFAULT_BASE_URL = "https://api.linkup.so/v1";
const USER_AGENT = "dsh-web-search-linkup/0.2.0";

/** Local stand-in mirroring the seam's WebError shape (message, code, cause). */
class LinkupWebError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
}
let WebErr = LinkupWebError;
try {
	const mod = await import("@deepseek-ai/dsh-web");
	if (typeof mod?.WebError === "function") WebErr = mod.WebError;
} catch {
	/* host module not resolvable from the plugin dir: keep local shape */
}
const webError = (message, code, options) => new WebErr(message, code, options);

/** Canonicalize + guard the base URL so a mistyped config can never leak the key. */
function resolveBaseURL(baseURL, allowCustom) {
	const canonical = (baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
	if (OFFICIAL_BASE_URLS.has(canonical)) return canonical;
	if (allowCustom !== true) {
		throw webError(`custom baseURL ${JSON.stringify(canonical)} is not allowed; only the official ${DEFAULT_BASE_URL} is permitted unless allowCustomBaseURL: true`, "WEB_PROVIDER_ERROR");
	}
	if (!/^https:\/\//u.test(canonical)) throw webError(`custom baseURL must use https, got ${JSON.stringify(canonical)}`, "WEB_PROVIDER_ERROR");
	return canonical;
}

function resolveOptions(config) {
	return {
		apiKey: typeof config?.apiKey === "string" && config.apiKey.length > 0 ? config.apiKey : void 0,
		apiKeyEnv: typeof config?.apiKeyEnv === "string" && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV,
		baseURL: resolveBaseURL(config?.baseURL, config?.allowCustomBaseURL === true),
		depth: DEPTHS.has(config?.depth) ? config.depth : "standard",
		timeoutMs: Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 25000,
	};
}

function isAbortError(error) {
	return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

class LinkupSearchProvider {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config ?? {};
		this.id = PROVIDER_ID;
	}
	available() {
		try {
			resolveOptions(this.config);
			return true;
		} catch {
			return false;
		}
	}
	async apiKey(options, signal) {
		if (signal?.aborted) throw webError("linkup search aborted", "WEB_ABORTED", { cause: signal.reason });
		if (options.apiKey !== void 0) return options.apiKey;
		const credentials = this.ctx.get("credentials");
		if (credentials !== void 0) {
			const record = await credentials.resolve(options.apiKeyEnv).catch(() => void 0);
			if (typeof record?.value === "string" && record.value.length > 0) return record.value;
		}
		const ambient = process.env[options.apiKeyEnv];
		if (typeof ambient === "string" && ambient.length > 0) return ambient;
		throw webError(
			`linkup: no API key for ${JSON.stringify(options.apiKeyEnv)}; store it through the credentials service, export it in the launching environment, or set a literal apiKey in the web-search-linkup config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING",
		);
	}
	async search(request, signal) {
		const options = resolveOptions(this.config);
		const apiKey = await this.apiKey(options, signal);
		const composed = signal
			? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
			: AbortSignal.timeout(options.timeoutMs);
		let response;
		try {
			response = await fetch(`${options.baseURL}/search`, {
				method: "POST",
				redirect: "error",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "user-agent": USER_AGENT },
				body: JSON.stringify({ q: request.query, depth: options.depth, outputType: "searchResults" }),
				signal: composed,
			});
		} catch (error) {
			if (signal?.aborted === true) throw webError("linkup search aborted", "WEB_ABORTED", { cause: signal.reason ?? error });
			if (isAbortError(error)) throw webError(`linkup search timed out after ${options.timeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
			throw webError(`linkup: request to ${options.baseURL}/search failed: ${error?.message ?? error}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw webError(`linkup: HTTP ${response.status} from ${options.baseURL}/search: ${detail.slice(0, 400)}`, "WEB_PROVIDER_ERROR");
		}
		let payload;
		try {
			payload = await response.json();
		} catch (error) {
			throw webError(`linkup: unprocessable response body: ${error?.message ?? error}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		return mapLinkupResponse(payload);
	}
}

/** Map Linkup searchResults ({name,url,content}) to the seam's normalized sources. */
export function mapLinkupResponse(payload) {
	const seen = new Set();
	const sources = [];
	for (const item of Array.isArray(payload?.results) ? payload.results : []) {
		if (typeof item?.url !== "string" || item.url.length === 0) continue;
		const key = item.url.replace(/\/+$/u, ""); // trailing-slash-insensitive dedupe
		if (seen.has(key)) continue;
		seen.add(key);
		sources.push({
			url: item.url,
			...(typeof item.name === "string" && item.name.length > 0 ? { title: item.name } : {}),
			...(typeof item.content === "string" && item.content.length > 0 ? { snippet: item.content } : {}),
		});
	}
	if (sources.length === 0) throw webError("linkup: response contained no usable results", "WEB_PROVIDER_ERROR");
	return { sources, truncated: false };
}

export const name = "web-search-linkup";
export const inject = ["web"];

export function apply(ctx, config) {
	ctx.web.registerSearchProvider(new LinkupSearchProvider(ctx, config));
}
