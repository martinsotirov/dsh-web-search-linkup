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
const OFFICIAL_BASE_URL = "https://api.linkup.so/v1";
const OFFICIAL_BASE_URLS = new Set([OFFICIAL_BASE_URL]);
/* Credential-ref grammar enforced by credentialRef() in the host — a rogue name
   combined with allowCustomBaseURL could otherwise exfiltrate an arbitrary secret. */
const CRED_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
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
	const canonical = (baseURL ?? OFFICIAL_BASE_URL).replace(/\/+$/u, "");
	if (canonical === "https://api.linkup.so") return OFFICIAL_BASE_URL; // normalize bare host
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
		apiKeyEnv: (() => {
			const env = typeof config?.apiKeyEnv === "string" && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV;
			if (!CRED_REF_PATTERN.test(env)) throw webError(`apiKeyEnv ${JSON.stringify(env)} is not a valid credential reference`, "WEB_PROVIDER_ERROR");
			return env;
		})(),
		baseURL: resolveBaseURL(config?.baseURL, config?.allowCustomBaseURL === true),
		depth: DEPTHS.has(config?.depth) ? config.depth : "standard",
		timeoutMs: Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 25000,
	};
}

function isAbortError(error) {
	return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Race an awaitable against an AbortSignal (port of the reference plugins' helper). */
function abortable(operation, signal) {
	if (signal === void 0) return Promise.resolve(operation);
	if (signal.aborted) return Promise.reject(webError("linkup search aborted", "WEB_ABORTED", { cause: signal.reason }));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(webError("linkup search aborted", "WEB_ABORTED", { cause: signal.reason }));
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(operation).then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
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
			let record;
			try {
				// Race against the caller's signal; a service FAILURE must not be
				// disguised as "no key stored" (reviewer finding 2).
				record = await abortable(credentials.resolve(options.apiKeyEnv), signal);
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw webError("linkup search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
				throw webError(`linkup: credential resolution failed: ${error?.message ?? error}`, "WEB_PROVIDER_ERROR", { cause: error });
			}
			if (typeof record?.value === "string" && record.value.length > 0) return record.value;
		}
		const ambient = process.env[options.apiKeyEnv];
		if (typeof ambient === "string" && ambient.length > 0) return ambient;
		throw webError(
			`linkup: no API key for ${JSON.stringify(options.apiKeyEnv)}; store it through the credentials service, export it in the launching environment, or set a literal apiKey in the web-search-linkup config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING",
		);
	}
	/** Abort/timeout classification shared by fetch and body-read catches. */
	wrapBodyError(error, options, signal) {
		if (signal?.aborted === true) return webError("linkup search aborted", "WEB_ABORTED", { cause: signal.reason ?? error });
		if (isAbortError(error)) return webError(`linkup search timed out after ${options.timeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
		return webError(`linkup: unprocessable response body: ${error?.message ?? error}`, "WEB_PROVIDER_ERROR", { cause: error });
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
			let detail = "";
			try {
				detail = await abortable(response.text(), signal);
			} catch (error) {
				throw this.wrapBodyError(error, options, signal);
			}
			throw webError(`linkup: HTTP ${response.status} from ${options.baseURL}/search: ${detail.slice(0, 400)}`, "WEB_PROVIDER_ERROR");
		}
		let payload;
		try {
			payload = await abortable(response.json(), signal);
		} catch (error) {
			if (error instanceof WebErr || (typeof error?.code === "string" && String(error.code).startsWith("WEB_"))) throw error; // pass through abort from abortable
			throw this.wrapBodyError(error, options, signal);
		}
		// Note: empty results THROWS (deepseek-provider precedent) instead of returning
		// an empty source list — a search that found nothing should say so loudly.
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
