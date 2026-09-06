# dsh-web-search-linkup

[Linkup](https://linkup.so)-backed search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web capability seam (`ctx.web`): it makes the built-in `web_search` tool run on Linkup's `/search` API instead of the shipped DeepSeek route.

Zero runtime dependencies (native `fetch`; a best-effort dynamic import picks up the host's `WebError` for typed error codes when resolvable). Node >= 22.

## Install

```bash
dsh plugin --profile web add <source>   # git URL, local path, or npm package
```

Installing adds the bundle patch (`dsh.bundle.patch` in `package.json`), which:

1. mounts the provider as plugin row `web-search-linkup`, and
2. selects it: `searchProvider: linkup` on the `web` row.

Then save your key — either on the web UI Models page (credentials service) or in the environment that starts `dsh`:

```bash
export LINKUP_API_KEY=lup_...
```

Restart `dsh` once after installing. Verify the composition:

```bash
dsh --profile web --dump-config | grep -A3 web-search-linkup
```

## Configuration

All optional; on the `web-search-linkup` row's `config`:

| Key | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `LINKUP_API_KEY` | credential-ref / env name holding the key |
| `apiKey` | — | literal key (last resort; keep it out of committed config) |
| `depth` | `standard` | `fast` \| `standard` \| `deep` (Linkup search depth) |
| `timeoutMs` | `25000` | per-request ceiling (stays under the tool's 30 s deadline) |
| `baseURL` | `https://api.linkup.so/v1` | API base |
| `allowCustomBaseURL` | `false` | must be `true` for any non-official https base (key-leak guard) |

A patch entry replaces the whole `config` of a row, so restate every key you keep.

## Behavior

- Maps Linkup `searchResults` (`{name,url,content}`) to the seam's `{url,title,snippet}`, deduped by URL (trailing-slash insensitive).
- Errors carry seam-style codes (`WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED`, `WEB_PROVIDER_ERROR`).
- Key resolution order: literal `apiKey` → credentials service → launch environment.
- `redirect: "error"` + official-host-only base URL: the Bearer key never leaves the official endpoint without explicit opt-in.

## Tests

```bash
npm test
```

## Switching back

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml (or home-level patch)
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

## Notes

- **Empty results throw** (`WEB_PROVIDER_ERROR`) rather than returning an empty list — following the shipped DeepSeek provider's precedent, a search that found nothing says so loudly. (The Brave community plugin returns `[]` instead; either is seam-legal.)
- The bundled patch sets **only** `searchProvider` on the `web` row — patch entries replace the whole `config` object, so we deliberately leave `fetchProvider` to the host defaults / `$DSH_WEB_FETCH_PROVIDER` / your own patch layer.
- `apiKeyEnv` must match the host credential-ref grammar (`[A-Za-z_][A-Za-z0-9_]*`); anything else makes the provider unavailable instead of risking an arbitrary Bearer secret.
