import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLinkupResponse, apply } from "../lib/index.js";

test("maps results to normalized sources", () => {
	const r = mapLinkupResponse({ results: [
		{ name: "Title A", url: "https://a.example", content: "Snippet A" },
		{ name: "Title B", url: "https://b.example", content: "" },
	]});
	assert.equal(r.sources.length, 2);
	assert.deepEqual(r.sources[0], { url: "https://a.example", title: "Title A", snippet: "Snippet A" });
	assert.deepEqual(r.sources[1], { url: "https://b.example", title: "Title B" });
	assert.equal(r.truncated, false);
});

test("dedupes by url (trailing-slash insensitive), drops url-less items", () => {
	const r = mapLinkupResponse({ results: [
		{ name: "X", url: "https://x.example", content: "one" },
		{ name: "X again", url: "https://x.example/", content: "two" },
		{ name: "no url" },
	]});
	assert.equal(r.sources.length, 1);
	assert.equal(r.sources[0].snippet, "one");
});

test("throws coded error on empty results", () => {
	assert.throws(() => mapLinkupResponse({ results: [] }), (err) => err.code === "WEB_PROVIDER_ERROR");
	assert.throws(() => mapLinkupResponse(undefined), (err) => err.code === "WEB_PROVIDER_ERROR");
});

test("config guards via registered provider", () => {
	const register = (config) => {
		let registered;
		apply({ web: { registerSearchProvider: (p) => { registered = p; } }, get: () => void 0 }, config);
		return registered;
	};
	assert.equal(register({ depth: "bogus" }).available(), true); // bogus depth falls back to standard
	assert.equal(register({ baseURL: "http://evil.example" }).available(), false); // custom http without opt-in
	assert.equal(register({ baseURL: "https://proxy.example/v1" }).available(), false); // custom https needs opt-in
	assert.equal(register({ baseURL: "https://proxy.example/v1", allowCustomBaseURL: true }).available(), true);
	assert.equal(register({}).available(), true);
});

test("missing key yields WEB_PROVIDER_CREDENTIAL_MISSING", async () => {
	let registered;
	apply({ web: { registerSearchProvider: (p) => { registered = p; } }, get: () => void 0 }, {});
	const saved = process.env.LINKUP_API_KEY;
	delete process.env.LINKUP_API_KEY;
	try {
		await assert.rejects(registered.search({ query: "x" }), (err) => err.code === "WEB_PROVIDER_CREDENTIAL_MISSING");
	} finally {
		if (saved !== undefined) process.env.LINKUP_API_KEY = saved;
	}
});
