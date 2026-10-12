#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuickJsExecutor } from './executor.js';
import { LexwareClientRegistry, loadAccountsFromEnv, writesEnabled } from './lexware-client.js';
import { lexwareSpec } from './lexware-spec.js';
import { stringifyForMcp } from './truncate.js';
import { VERSION } from './version.js';

const server = new McpServer({
	name: 'lexware-office',
	version: VERSION,
});

const searchExecutor = new QuickJsExecutor();
const executeExecutor = new QuickJsExecutor();

const { accounts, defaultAccountId } = loadAccountsFromEnv();
// Use a shorter per-request timeout than the executor timeout (30 s) so that
// slow Lexware requests fail with a clean error before the sandbox is torn down.
const registry = new LexwareClientRegistry(accounts, defaultAccountId, { requestTimeoutMs: 25_000 });

// Inject the current write mode and accounts metadata so callers can branch before attempting a write.
const sandboxSpec = () => ({
	...lexwareSpec,
	info: {
		...lexwareSpec.info,
		writesEnabled: writesEnabled(),
		accounts: registry.listAccounts(),
		defaultAccountId: registry.defaultAccountId,
	},
});

server.tool(
	'search',
	`Search the curated Lexware Office API catalog by running a JavaScript async arrow function.

Use this before execute to discover endpoints, request shapes, response notes, workflows, domain-specific caveats, and available accounts.

Available global:

declare const spec: LexwareApiCatalog;

Useful starting points:
- spec.info.accounts: list of configured Lexware accounts ({ id, name, writesEnabled })
- spec.info.domainIndex: compact map from business domains to endpoint lists
- spec.info.writesEnabled: whether this server currently allows POST/PUT/PATCH/DELETE — check before planning writes
- spec.paths: path -> method -> operation catalog with params, requestBody, responses, examples, capabilities, docsUrl
- spec.workflows: curated recipes for reporting, sales documents, files/uploads, webhooks, and API quirks
- spec.info.voucherStatusSemantics and financeReportingSemantics: finance/status guidance for revenue/Umsatz/profit questions

Sandbox: no network, filesystem, process, fetch, imports, or API key. Return JSON-serializable data; console logs are captured.

Examples:

async () => ({ accounts: spec.info.accounts, domains: Object.keys(spec.info.domainIndex) })

async () => {
  const op = spec.paths['/v1/voucherlist']?.get;
  return { summary: op?.summary, parameters: op?.parameters, notes: op?.notes, examples: op?.examples };
}`,
	{
		code: z.string().describe('JavaScript async arrow function to search the Lexware API catalog'),
	},
	async ({ code }) => {
		const execution = await searchExecutor.execute(
			code,
			{
				spec: sandboxSpec(),
				accounts: registry.listAccounts(),
				defaultAccountId: registry.defaultAccountId,
			},
			{ timeoutMs: 1_000, memoryLimitBytes: 32 * 1024 * 1024, maxStackSizeBytes: 1024 * 1024, filename: 'lexware-search.js' },
		);

		if (execution.error) {
			return {
				content: [
					{
						type: 'text',
						text: stringifyForMcp({ ok: false, error: execution.error, logs: execution.logs ?? [] }),
					},
				],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: stringifyForMcp({ ok: true, result: execution.result, logs: execution.logs ?? [] }),
				},
			],
		};
	},
);

server.tool(
	'execute',
	`Execute a constrained Lexware Office API workflow by running a JavaScript async arrow function.

Use search first when you need endpoint/domain guidance; do not guess Lexware paths from memory. The sandbox exposes no API key, filesystem, process, imports, fetch, or arbitrary network access. Supports multiple connected Lexware accounts.

Available globals:

declare const spec: LexwareApiCatalog;
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

  // Financial math helpers:
  requireNumber(row: unknown, fieldPath: string): number;
  requireMoney(row: unknown, fieldPath: string): number;
  sumMoney(rows: unknown[], fieldPath: string): number;
  formatMoney(cents: number, currency?: string): string;
};

interface LexwareAccountClient {
  id: string;
  name: string;
  writesEnabled: boolean;
  request<T = unknown>(input: LexwareRequest): Promise<LexwareResponse<T>>;
  json(input: LexwareRequest): Promise<unknown>;
  paginate<T = unknown>(input: LexwareRequest, options?: { maxPages?: number }): Promise<T[]>;
}

type LexwareRequest = {
  account?: string; // target account ID (e.g. 'freelance', 'gewerbe'); defaults to primary account if omitted
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // relative /v1/... only; no absolute URLs or // hosts
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;
  body?: unknown; // JSON by default; string when rawBody=true (UTF-8 encoded, NOT binary-safe)
  bodyBase64?: string; // raw binary body as base64; the host decodes it outside the sandbox
  multipart?: MultipartPart[]; // multipart/form-data uploads (e.g. POST /v1/files); host builds FormData
  contentType?: string;
  rawBody?: boolean;
  accept?: string;
};
// At most one of body, bodyBase64, or multipart per request.

type MultipartPart = {
  name: string;
  value?: string; // plain text form field
  contentBase64?: string; // binary part content as base64; host decodes it
  contentPath?: string; // absolute file path on the MCP server machine; host reads the file directly — preferred for local files (no base64, no size blowup)
  filename?: string; // defaults to the contentPath basename
  contentType?: string;
};
// Exactly one of value, contentBase64, or contentPath per part.

type LexwareResponse<T = unknown> = {
  ok: boolean;
  status: number;
  statusText: string;
  data?: T;
  text?: string;
  truncated?: boolean;
  contentType: string;
  headers: Record<string, string>;
  errorCategory?: string;
  retryAfterSeconds?: number;
  operation?: { operationId: string; method: string; pathTemplate: string; summary: string };
  request: { method: string; path: string; query: Record<string, string[]> };
  sent?: { bytes: number; sha256?: string; parts?: Array<{ name: string; filename?: string; bytes: number; sha256: string }> }; // echo of uploaded binary payloads for integrity checks
};

lexware.request returns all HTTP responses, including non-OK, as LexwareResponse. Check response.ok/status for recovery logic, or use lexware.json(...) / lexware.paginate(...) when you want non-OK or non-JSON responses to throw.

This server is read-only by default. POST, PUT, PATCH, and DELETE are blocked unless permitted for the account. Check client.writesEnabled or spec.info.writesEnabled to branch before attempting a write.

Multi-account consolidation example (e.g. combining revenue across accounts):

async () => {
  const totals = await lexware.allAccounts(async (client) => {
    const invoices = await client.paginate({
      path: '/v1/voucherlist',
      query: { voucherType: 'invoice', voucherStatus: 'paid' }
    });
    return { count: invoices.length, revenueCents: lexware.sumMoney(invoices, 'totalAmount') };
  });

  const grandTotalCents = Object.values(totals).reduce((sum, item) => sum + item.revenueCents, 0);
  return { accounts: totals, grandTotal: lexware.formatMoney(grandTotalCents) };
}`,
	{
		code: z.string().describe('JavaScript async arrow function to execute a constrained Lexware API workflow'),
		maxRequests: z
			.number()
			.int()
			.min(1)
			.max(50)
			.optional()
			.default(10)
			.describe('Maximum number of Lexware API requests this execution may perform.'),
	},
	async ({ code, maxRequests }) => {
		let requestCount = 0;
		const execution = await executeExecutor.execute(
			code,
			{
				spec: sandboxSpec(),
				accounts: registry.listAccounts(),
				defaultAccountId: registry.defaultAccountId,
			},
			{
				timeoutMs: 30_000,
				memoryLimitBytes: 32 * 1024 * 1024,
				maxStackSizeBytes: 1024 * 1024,
				filename: 'lexware-execute.js',
				hostFunctions: {
					__lexwareRequestJson: async (payload) => {
						requestCount += 1;
						if (requestCount > maxRequests) {
							throw new Error(`Execution exceeded maxRequests=${maxRequests}`);
						}
						const parsed = JSON.parse(payload) as unknown;
						let accountId: string | undefined;
						let requestData: unknown;
						if (parsed && typeof parsed === 'object' && 'request' in parsed) {
							const envelope = parsed as { account?: string; request: unknown };
							accountId = envelope.account;
							requestData = envelope.request;
						} else {
							accountId = (parsed as { account?: string })?.account;
							requestData = parsed;
						}
						const client = registry.get(accountId);
						const response = await client.request(requestData);
						return JSON.stringify(response);
					},
				},
			},
		);

		if (execution.error) {
			return {
				content: [
					{
						type: 'text',
						text: stringifyForMcp({ ok: false, error: execution.error, logs: execution.logs ?? [], requestCount }),
					},
				],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: stringifyForMcp({ ok: true, result: execution.result, logs: execution.logs ?? [], requestCount }),
				},
			],
		};
	},
);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error('Fatal error in Lexware Office MCP server:', error);
	process.exit(1);
});
