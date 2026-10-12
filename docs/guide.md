# Guide: Code Mode MCP server

This document explains how the `mcp-lexware-office` MCP server works and how to use it effectively.

## Distribution model

End users should consume `mcp-lexware-office` as a packaged Node MCP server, not by running TypeScript source files directly.

The package follows the standard TypeScript MCP layout:

- `bin` entries point to compiled JavaScript in `build/`.
- `files: ["build", "docs"]` keeps published tarballs small.
- `prepare` runs `npm run build` for GitHub installs, so `build/` does not need to be committed.

For GitHub installs, use an explicit GitHub package spec:

```json
"args": ["-y", "--package=github:JannikWempe/mcp-lexware-office#semver:^2", "lexware-office"]
```

After publishing to npm, use the npm package name instead:

```json
"args": ["-y", "--package=mcp-lexware-office", "lexware-office"]
```

For local development only, after cloning the repo and installing dependencies, it is fine to run the TypeScript source with `tsx`:

```json
"args": ["-y", "tsx", "/absolute/path/to/mcp-lexware-office/src/index.ts"]
```

## Why Code Mode

Endpoint-shaped MCP tools (one tool per API operation) are approachable, but the tool list becomes large and still cannot cover every Lexware API edge case perfectly.

This server uses a smaller tool surface:

1. `search` helps the model inspect a curated Lexware API catalog.
2. `execute` lets the model run a constrained API workflow using `lexware.request`.

This gives better coverage for:

- less common Lexware endpoints,
- multi-step reporting questions,
- pagination and aggregation,
- API behavior that needs catalog notes or examples,
- workflows that would otherwise require many narrowly shaped MCP tools.

## The two tools

### `search`

`search` runs a sandboxed JavaScript async arrow function against a curated OpenAPI-lite catalog in `src/lexware-spec.ts`.

Example:

```js
async () => {
  return Object.entries(spec.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({
        method,
        path,
        summary: op.summary,
        tags: op.tags
      }))
    )
    .filter(op => op.tags.includes('contacts'));
}
```

The `search` sandbox receives only the catalog. It does not receive the Lexware API key, Node globals, filesystem access, `fetch`, imports, or arbitrary network access.

### `execute`

`execute` uses the same sandbox plus one host capability: `lexware.request`.

Example:

```js
async () => {
  const response = await lexware.request({
    method: 'GET',
    path: '/v1/contacts',
    query: { name: 'Muster', page: 0, size: 10 }
  });

  if (!response.ok) {
    return { status: response.status, errorCategory: response.errorCategory, data: response.data };
  }

  return response.data;
}
```

`lexware.request`:

- calls only relative `/v1/...` Lexware API paths,
- rejects absolute URLs and external hosts,
- hides the API key from sandboxed code,
- rate-limits host requests to 2 requests/second by default,
- returns JSON/text or binary metadata,
- adds operation metadata when the request matches the catalog,
- allows unknown `/v1/...` paths for API coverage gaps.

Useful helper methods are also exposed inside `execute`:

```ts
declare const lexware: {
  // Accounts metadata & selectors:
  accounts: Array<{ id: string; name: string; writesEnabled: boolean }>;
  account(id: string): LexwareAccountClient;
  [accountId: string]: LexwareAccountClient | any; // direct shorthand, e.g. lexware.freelance, lexware.saas
  allAccounts<T>(callback: (client: LexwareAccountClient, accountId: string) => Promise<T>): Promise<Record<string, T>>;
  mapAccounts<T>(accountIds: string[], callback: (client: LexwareAccountClient, accountId: string) => Promise<T>): Promise<Record<string, T>>;

  // Operations on default or single account:
  request<T = unknown>(input: LexwareRequest): Promise<LexwareResponse<T>>;
  json(input: LexwareRequest): Promise<unknown>;
  paginate<T = unknown>(input: LexwareRequest, options?: { maxPages?: number }): Promise<T[]>;
  requireNumber(row: unknown, fieldPath: string): number;
  requireMoney(row: unknown, fieldPath: string): number;
  sumMoney(rows: unknown[], fieldPath: string): number;
  formatMoney(cents: number, currency?: string): string;
};
```

## Multi-Account & Cross-Account Consolidation

With one or more connected Lexware Office accounts, the server injects account discovery metadata and scoped clients into the sandboxed `execute` tool:

```js
async () => {
  // Run queries across all accounts concurrently
  const reportByAccount = await lexware.allAccounts(async (client) => {
    const vouchers = await client.paginate({
      path: '/v1/voucherlist',
      query: { voucherType: 'invoice', voucherStatus: 'paid' }
    });

    const netCents = lexware.sumMoney(vouchers, 'totalAmount');
    return {
      name: client.name,
      invoiceCount: vouchers.length,
      netRevenueCents: netCents,
      netRevenue: lexware.formatMoney(netCents)
    };
  });

  const totalCents = Object.values(reportByAccount).reduce((sum, item) => sum + item.netRevenueCents, 0);

  return {
    accounts: reportByAccount,
    consolidatedRevenue: lexware.formatMoney(totalCents)
  };
}
```

Or query specific accounts explicitly:

```js
async () => {
  const freelanceInvoices = await lexware.freelance.paginate({ path: '/v1/voucherlist', query: { voucherType: 'invoice' } });
  const gewerbeInvoices = await lexware.account('gewerbe').paginate({ path: '/v1/voucherlist', query: { voucherType: 'invoice' } });

  return {
    freelance: freelanceInvoices.length,
    gewerbe: gewerbeInvoices.length
  };
}
```

Account selection rules:

- Reads without an account go to the default account: `LEXWARE_OFFICE_DEFAULT_ACCOUNT`, otherwise the first configured account. Order: `LEXWARE_OFFICE_CONFIG_FILE` entries, then `LEXWARE_OFFICE_ACCOUNTS_JSON` entries (in file order), then `LEXWARE_OFFICE_API_KEY_<ID>` accounts in `LEXWARE_OFFICE_ACCOUNTS` order, then remaining ones alphabetically. Set `LEXWARE_OFFICE_DEFAULT_ACCOUNT` explicitly when you have several accounts.
- Per-account flags depend on where the account is defined: `"allowWrites"` / `"readOnly"` (JSON booleans) for config-file and JSON accounts; `LEXWARE_OFFICE_ALLOW_WRITES_<ID>` / `LEXWARE_OFFICE_READ_ONLY_<ID>` / `LEXWARE_OFFICE_NAME_<ID>` (matched case-insensitively) only for `LEXWARE_OFFICE_API_KEY_<ID>` accounts.
- `LEXWARE_OFFICE_API_KEY` (legacy single key) cannot be combined with other account sources; use `LEXWARE_OFFICE_API_KEY_DEFAULT` instead.
- With two or more accounts, `POST`/`PUT`/`PATCH`/`DELETE` **must** name the account (`lexware.account('id')`, `lexware.<id>`, or `{ account: 'id', ... }`); otherwise the request is rejected, so writes never land in the wrong books by accident.
- `maxRequests` is shared across all accounts in one `execute` call — raise it (max 50) for `allAccounts` + `paginate` reports.

Account configuration is validated at startup and the server exits on any error instead of falling back to another source: invalid JSON, a missing `apiKey`, a duplicate id (ids are lowercased and non `[a-z0-9_-]` characters become `_`), an account listed in `LEXWARE_OFFICE_ACCOUNTS` without a key, an unknown `LEXWARE_OFFICE_DEFAULT_ACCOUNT`, a boolean flag that isn't `true`/`false`/`1`/`0`, a reserved id (`accounts`, `account`, `request`, `json`, `paginate`, `constructor`, `prototype`, `then`, or one starting with `_`), or a non-`https://` `baseUrl`. Error messages never include config contents.

## Binary-safe file uploads

Three binary-safe upload modes are supported in addition to the legacy `rawBody=true` string-based multipart. Prefer `multipart` with `contentPath` — the file's bytes never pass through the model or the sandbox.

### `multipart` with `contentPath` — host reads a local file (preferred)

For multipart uploads (e.g. `/v1/files`, `/v1/vouchers/{id}/files`), pass the file's absolute path. The host reads the file from disk outside the QuickJS sandbox and builds `FormData` with `Blob` parts:

```js
async () => {
  const response = await lexware.request({
    method: 'POST',
    path: '/v1/files',
    multipart: [
      { name: 'file', contentType: 'application/pdf', contentPath: '/absolute/path/to/receipt.pdf' },
      { name: 'type', value: 'voucher' },
    ],
  });
  // response.sent echoes what was uploaded for integrity checks:
  // { bytes, parts: [{ name, filename, bytes, sha256 }] }
  return { id: response.data?.id, sent: response.sent };
}
```

- `contentPath` is **disabled unless `LEXWARE_OFFICE_UPLOAD_DIR` is set**. The path must be absolute and resolve (after following symlinks) to a regular file inside that directory, with extension `.pdf`, `.jpg`, `.jpeg`, `.png`, or `.xml` (25 MB cap). The account config file (`LEXWARE_OFFICE_CONFIG_FILE`) and hard-linked files are always refused, and the file is re-checked after opening. Keep the directory writable only by you — not by other users or processes you don't trust. This keeps sandboxed code — which may be steered by prompt injection in Lexware data — from reading arbitrary host files.
- `filename` defaults to the `contentPath` basename.
- Uploads are writes: the target account must allow writes. Check `client.writesEnabled` to branch early.

### `multipart` with `contentBase64` — binary FormData parts

When the bytes are only available as base64 (e.g. fetched externally), use `contentBase64` instead of `contentPath`. The host decodes the base64 outside the sandbox:

```js
{ name: 'file', filename: 'receipt.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0x...' }
```

### `bodyBase64` — raw binary body

Send a raw (non-multipart) binary request body by base64-encoding it and setting `bodyBase64`. The host decodes the base64 and sends the raw bytes. `contentType` defaults to `application/octet-stream`. Not usable on multipart endpoints like `/v1/files` — those reject non-multipart bodies before sending (see below).

Key constraints:
- `body`, `bodyBase64`, and `multipart` are mutually exclusive — set at most one per request.
- `value`, `contentBase64`, and `contentPath` are mutually exclusive within a single multipart part — set exactly one.
- GET requests may not include any body mode.
- Invalid base64 and unreadable `contentPath` files are rejected before the request is sent.
- Endpoints cataloged as `multipart/form-data` reject `body`/`bodyBase64` up front (instead of an opaque Lexware 500) unless an explicit `contentType` containing `multipart/` and a boundary marks a deliberately hand-rolled body.
- Requests with binary payloads echo `response.sent` (`bytes`, `sha256` per part) so callers can verify what was uploaded.

### Legacy `rawBody=true`

The original `rawBody=true` mode is preserved for backward compatibility. It sends a string body verbatim (UTF-8 encoded) and is adequate for text-based multipart (e.g. manually constructed ASCII boundaries). It is **not** binary-safe for arbitrary byte sequences — use `multipart` with `contentPath`/`contentBase64` or `bodyBase64` for true binary payloads.

## Permissions

**The server is read-only by default.** Because `execute` is a single powerful tool (not separate per-operation MCP tools), writes are blocked unless explicitly opted in.

To enable writes, set:

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true"
}
```

`LEXWARE_OFFICE_READ_ONLY=true` is a hard block that overrides `ALLOW_WRITES=true`:

```json
{
  "LEXWARE_OFFICE_READ_ONLY": "true"
}
```

Priority order per account (highest wins):

1. Global `LEXWARE_OFFICE_READ_ONLY=true` → writes always blocked on every account, regardless of per-account settings
2. Per-account read-only (`LEXWARE_OFFICE_READ_ONLY_<ID>=true` / `"readOnly": true`) → blocked
3. Per-account opt-in (`LEXWARE_OFFICE_ALLOW_WRITES_<ID>=true` / `"allowWrites": true`) → allowed (`false` → blocked)
4. Global `LEXWARE_OFFICE_ALLOW_WRITES=true` → allowed, **only in single-account setups**; with two or more accounts each account must opt in on its own
5. Default → writes blocked

`spec.info.writesEnabled` is `true` when at least one account allows writes; `spec.info.accounts[].writesEnabled` is per account.

When writes are blocked, `POST`, `PUT`, `PATCH`, and `DELETE` requests are rejected with a clear error message.

Important behavior:

- Default read-only mirrors how Cloudflare's OAuth scope template defaults to read-only; Lexware API keys have no equivalent OAuth scopes, so the MCP server provides the safety boundary.
- Writes should only be enabled when the user explicitly needs a write operation.
- The API key remains in the host process and is never exposed to sandboxed code.
- `baseUrl` / `LEXWARE_OFFICE_API_BASE_URL` must be `https://` so the bearer token never travels in plaintext.

## Handling sensitive data

- Everything `execute` returns (customers, amounts, IBANs, documents) is sent to your LLM provider. Make sure your data-processing agreement (AVV / GDPR DPA) with that provider covers bookkeeping data.
- Text inside Lexware records (contact names, remarks, voucher notes) is untrusted input to the model. Keep writes disabled on accounts that don't need them and keep `LEXWARE_OFFICE_UPLOAD_DIR` narrow.
- Prefer `LEXWARE_OFFICE_CONFIG_FILE` with owner-only file permissions over API keys pasted into the MCP client config.
- Pin the GitHub package spec to a reviewed commit (`github:<owner>/mcp-lexware-office#<sha>`) instead of `#semver:^2` so a new push cannot change the code that handles your keys.

## Migrating from 1.x

Version 1.x shipped a second, legacy server with one MCP tool per Lexware operation (`get-contacts`, `create-invoice`, `upload-file`, ...). Version 2.0.0 removed it; Code Mode is the only server.

To migrate a 1.x config:

1. Point the package spec at `#semver:^2` (or the npm package once published).
2. Use the `lexware-office` binary. (`lexware-office-v2` still works as a deprecated alias and prints a deprecation warning on startup.)
3. Remove any `disabledTools` lists — permissioning is now env-based (see [Permissions](#permissions)).
4. Writes are now blocked by default. Set `LEXWARE_OFFICE_ALLOW_WRITES=true` if you need create/update/finalize/upload operations.

## Upgrading to multi-account hardening (breaking)

- `multipart` `contentPath` uploads are **off by default**. Set `LEXWARE_OFFICE_UPLOAD_DIR` and keep the files to upload inside it (see [Binary-safe file uploads](#binary-safe-file-uploads)); `contentBase64` keeps working without it.
- Boolean flags (`LEXWARE_OFFICE_READ_ONLY`, `LEXWARE_OFFICE_ALLOW_WRITES`, and their `_<ID>` variants) accept only `true`/`false`/`1`/`0` (any case); anything else stops the server instead of being ignored.
- `LEXWARE_OFFICE_API_KEY` can no longer be combined with other account sources; rename it to `LEXWARE_OFFICE_API_KEY_DEFAULT` when adding accounts.
- With two or more accounts, the global `LEXWARE_OFFICE_ALLOW_WRITES` no longer enables writes; opt in per account.

Interaction pattern changes for the model:

Read operations — instead of `get-contacts` with filters:

```js
async () => {
  return await lexware.json({
    path: '/v1/contacts',
    query: { name: 'Muster', page: 0, size: 10 }
  });
}
```

Detail operations — instead of `get-contact-details` with an id:

```js
async () => {
  const contactId = '00000000-0000-0000-0000-000000000000';
  return await lexware.json({ path: `/v1/contacts/${contactId}` });
}
```

Create/update operations — instead of `create-contact`/`update-contact`:

```js
async () => {
  const response = await lexware.request({
    method: 'POST',
    path: '/v1/contacts',
    body: {
      version: 0,
      roles: { customer: {} },
      company: { name: 'Muster GmbH' },
      addresses: {
        billing: [{ street: 'Musterstraße 1', zip: '12345', city: 'Musterstadt', countryCode: 'DE' }]
      }
    }
  });

  return { status: response.status, ok: response.ok, data: response.data };
}
```

Reporting and aggregation — pagination and aggregation now happen inside one sandboxed execution instead of several tool calls:

```js
async () => {
  const rows = await lexware.paginate({
    path: '/v1/voucherlist',
    query: { voucherType: 'invoice', voucherStatus: 'paid', size: 100 }
  }, { maxPages: 5 });

  return {
    count: rows.length,
    totalAmount: lexware.formatMoney(lexware.sumMoney(rows, 'totalAmount'))
  };
}
```

Users who still need the legacy tool-per-endpoint server can pin the final 1.x release: `github:JannikWempe/mcp-lexware-office#semver:^1`.
