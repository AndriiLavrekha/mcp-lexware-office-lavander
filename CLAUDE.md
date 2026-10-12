# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm install` — install deps (Node 22+, pnpm per `packageManager`)
- `pnpm run build` — clean `build/`, compile with `tsc`, chmod binaries
- `pnpm test` — build, then run `node --test build/*.test.js` (this is what CI runs)
- `pnpm run typecheck` — `tsc --noEmit` only
- Single test file: `pnpm run build && node --test build/multi-account.test.js`
- Single test by name: `node --test --test-name-pattern="<regex>" build/<file>.test.js` (after build)
- Run from source for local MCP dev: `npx tsx src/index.ts` (stdio transport; needs `LEXWARE_OFFICE_API_KEY` or account config)

Tests run against compiled JS in `build/`, so always rebuild before re-running a test file. No linter is configured.

## API Documentation

Lexware Office REST API: https://developers.lexoffice.io/docs/

Fetch specific sections on demand with WebFetch. Key sections:
- Contacts: `/docs/#contacts-endpoint`
- Invoices: `/docs/#invoices-endpoint`
- Vouchers (voucherlist): `/docs/#voucherlist-endpoint`
- Down-Payment Invoices: `/docs/#down-payment-invoices-endpoint`
- Dunnings: `/docs/#dunnings-endpoint`

## Architecture (Code Mode)

Instead of one MCP tool per endpoint, the server exposes two tools, both of which run model-supplied JS async arrow functions in a QuickJS sandbox:

- `search` — sandbox gets `spec` (the catalog) only. 1 s timeout.
- `execute` — sandbox gets `spec` plus a `lexware` object. 30 s timeout, `maxRequests` cap (default 10, max 50) enforced host-side.

Files:
- `src/index.ts` — MCP server, tool definitions (the tool description strings are the model-facing TypeScript API docs for the sandbox — keep them in sync with `executor.ts`), wires the account registry into `execute` via a single host function `__lexwareRequestJson`.
- `src/executor.ts` — `QuickJsExecutor`. Builds the in-sandbox `lexware` object as a JS prelude (`request`, `json`, `paginate`, `account(id)`, `allAccounts`, `mapAccounts`, per-account shorthand like `lexware.freelance`, money helpers `requireMoney`/`sumMoney`/`formatMoney`). All of these funnel into `__lexwareRequestJson` with JSON-string payloads.
- `src/lexware-client.ts` — host side: `LexwareApiClient` (HTTP, path validation — relative `/v1/...` only, rate-limit queue, write gating, multipart/base64/`contentPath` upload handling, response shaping) and `LexwareClientRegistry` (one client per account). API keys live only here, never in the sandbox.
- `src/lexware-spec.ts` — curated OpenAPI-lite catalog (`paths`, `workflows`, `info.domainIndex`, finance/status semantics). `index.ts` injects runtime `info.writesEnabled`, `info.accounts`, `info.defaultAccountId` at call time.
- `src/truncate.ts` — caps MCP text payloads at 24k chars with recovery guidance.
- `src/cli-v2.ts` — deprecated `lexware-office-v2` bin alias; logs to stderr (stdout is the MCP channel — never `console.log` in server code).

### Accounts and write permissions

`loadAccountsFromEnv()` in `lexware-client.ts` merges accounts from `LEXWARE_OFFICE_CONFIG_FILE` (JSON file), `LEXWARE_OFFICE_ACCOUNTS_JSON`, and `LEXWARE_OFFICE_API_KEY_<ID>` named vars (per-account `_NAME_`, `_ALLOW_WRITES_`, `_READ_ONLY_`; optional `LEXWARE_OFFICE_ACCOUNTS` list must match keys); legacy single `LEXWARE_OFFICE_API_KEY` (id `default`) only when none of those exist. Ids are normalized to lowercase `[a-z0-9_-]`; reserved/duplicate ids throw. Any config error is fatal at startup (`index.ts` exits) — never fall back to another source, and never put config contents in error messages (they may hold keys).

Write gating (`LexwareApiClient.writesEnabled()`): global `READ_ONLY=true` always wins → per-account `readOnly` → per-account `allowWrites` → global `ALLOW_WRITES` (loader forces `allowWrites=false` on unflagged accounts when 2+ exist, so global only matters single-account). `LexwareClientRegistry.resolve()` rejects writes without an explicit account when 2+ accounts exist; the sandbox forwards only explicit account selections and the host applies the default for reads. File uploads count as writes; `contentPath` reads are confined to `LEXWARE_OFFICE_UPLOAD_DIR` (realpath-checked, extension allowlist, config file denied). Base URLs must be `https://`.

## Conventions

- Catalog entries in `lexware-spec.ts` must match official Lexware docs (`docsUrl` per operation); `spec-contract.test.ts` checks voucher types/statuses against the docs and that `domainIndex` and `spec.paths` agree.
- `code-mode-contract.test.ts` covers end-to-end tool behavior (only two tools registered, no API key/Node globals in sandbox, path escapes rejected, write gating, upload modes, truncation) — extend it when changing request handling.
- Optional fields use `!== undefined` guards, not falsy checks.
- Tests are `src/*.test.ts` (node:test + `node:assert/strict`).
- `docs/guide.md` is user-facing and checked in; `src/docs-contract.test.ts` asserts parts of it (e.g. voucherlist examples must use `totalAmount`). README and guide document env vars and the sandbox API — update them when those change.
- Releases via release-please (conventional commit messages: `feat:`, `fix:`, `chore:`).
- Source files use tabs for indentation.
