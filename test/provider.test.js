import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function makeProvider(config, credentials) {
	let registered;
	apply({ web: { registerSearchProvider: (p) => { registered = p; } }, get: (s) => s === "credentials" ? credentials : void 0 }, config);
	return registered;
}
const okResponse = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
const RESULTS = { results: [{ name: "T", url: "https://e.example", content: "c" }] };

test("request shape: POST /search, body, bearer auth, redirect:error", async () => {
	const savedFetch = globalThis.fetch;
	let seen;
	globalThis.fetch = async (url, init) => { seen = { url, init }; return okResponse(RESULTS); };
	try {
		const p = makeProvider({ apiKey: "lup_test_123", depth: "deep" });
		const r = await p.search({ query: "q1" });
		assert.equal(seen.url, "https://api.linkup.so/v1/search");
		assert.equal(seen.init.method, "POST");
		assert.equal(seen.init.redirect, "error");
		assert.equal(seen.init.headers.authorization, "Bearer lup_test_123");
		assert.deepEqual(JSON.parse(seen.init.body), { q: "q1", depth: "deep", outputType: "searchResults" });
		assert.equal(r.sources[0].url, "https://e.example");
	} finally { globalThis.fetch = savedFetch; }
});

test("caller abort during body read is WEB_ABORTED, not unprocessable", async () => {
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true, status: 200,
		json: () => new Promise((_, reject) => { /* never resolves on its own */ }),
		text: async () => "",
	});
	try {
		const p = makeProvider({ apiKey: "lup_test_123" });
		const ac = new AbortController();
		setTimeout(() => ac.abort(new Error("user cancelled")), 15);
		await assert.rejects(p.search({ query: "q" }, ac.signal), (err) => err.code === "WEB_ABORTED");
	} finally { globalThis.fetch = savedFetch; }
});

test("timeout is WEB_PROVIDER_ERROR with timeout wording", async () => {
	const savedFetch = globalThis.fetch;
	globalThis.fetch = (url, init) => new Promise((_, reject) => {
		init.signal.addEventListener("abort", () => reject(new DOMException("Timeout", "TimeoutError")));
	});
	try {
		const p = makeProvider({ apiKey: "lup_test_123", timeoutMs: 20 });
		await assert.rejects(p.search({ query: "q" }), (err) => err.code === "WEB_PROVIDER_ERROR" && /timed out/.test(err.message));
	} finally { globalThis.fetch = savedFetch; }
});

test("credential service FAILURE is not disguised as missing key", async () => {
	const p = makeProvider({}, { resolve: async () => { throw new Error("store offline"); } });
	await assert.rejects(p.search({ query: "q" }), (err) => err.code === "WEB_PROVIDER_ERROR" && /credential resolution failed/.test(err.message));
});

test("keyless available() stays true; missing key surfaces at search time", async () => {
	const saved = process.env.LINKUP_API_KEY;
	delete process.env.LINKUP_API_KEY;
	try {
		const p = makeProvider({}, { resolve: async () => void 0 });
		assert.equal(p.available(), true);
		await assert.rejects(p.search({ query: "q" }), (err) => err.code === "WEB_PROVIDER_CREDENTIAL_MISSING");
	} finally { if (saved !== undefined) process.env.LINKUP_API_KEY = saved; }
});

test("invalid apiKeyEnv fails availability (credential-ref grammar)", () => {
	assert.equal(makeProvider({ apiKeyEnv: "bad name;rm -rf" }).available(), false);
	assert.equal(makeProvider({ apiKeyEnv: "LINKUP_API_KEY" }).available(), true);
});
