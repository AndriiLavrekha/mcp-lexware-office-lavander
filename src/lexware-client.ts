import { createHash } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { lexwareSpec, type HttpMethod, type LexwareOperation } from './lexware-spec.js';
import { truncateText } from './truncate.js';
import { VERSION } from './version.js';

export type LexwareExecuteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type QueryScalar = string | number | boolean;
type QueryValue = QueryScalar | QueryScalar[] | null | undefined;

export interface MultipartPart {
	name: string;
	value?: string;
	filename?: string;
	contentType?: string;
	contentBase64?: string;
	contentPath?: string;
}

export interface LexwareRequestInput {
	account?: string;
	method?: LexwareExecuteMethod | Lowercase<LexwareExecuteMethod>;
	path: string;
	query?: Record<string, QueryValue>;
	body?: unknown;
	bodyBase64?: string;
	multipart?: MultipartPart[];
	contentType?: string;
	rawBody?: boolean;
	accept?: string;
}

export interface AccountConfig {
	id: string;
	name?: string;
	apiKey: string;
	allowWrites?: boolean;
	readOnly?: boolean;
	baseUrl?: string;
}

export interface AccountMetadata {
	id: string;
	name: string;
	writesEnabled: boolean;
}

export interface LexwareClientOptions {
	id?: string;
	name?: string;
	apiKey?: string;
	baseUrl?: string;
	userAgent?: string;
	fetchImpl?: typeof fetch;
	maxResponseChars?: number;
	requestTimeoutMs?: number;
	rateLimitIntervalMs?: number;
	allowWrites?: boolean;
	readOnly?: boolean;
}

export interface LexwareRequestOptions {}

export interface LexwareResponse {
	ok: boolean;
	status: number;
	statusText: string;
	operation?: {
		operationId: string;
		method: LexwareExecuteMethod;
		pathTemplate: string;
		summary: string;
	};
	request: {
		method: LexwareExecuteMethod;
		path: string;
		query: Record<string, string[]>;
	};
	contentType: string;
	headers: Record<string, string>;
	errorCategory?: 'auth' | 'permission' | 'validation' | 'not_found' | 'conflict' | 'rate_limit' | 'server' | 'network' | 'unknown';
	retryAfterSeconds?: number;
	data?: unknown;
	text?: string;
	truncated?: boolean;
	sent?: UploadEcho;
}

export interface UploadEcho {
	bytes: number;
	sha256?: string;
	parts?: Array<{ name: string; filename?: string; bytes: number; sha256: string }>;
}

interface MatchedOperation {
	pathTemplate: string;
	operation: LexwareOperation;
}

interface NormalizedRequest {
	method: LexwareExecuteMethod;
	path: string;
	query: URLSearchParams;
	body?: unknown;
	bodyBase64?: string;
	multipart?: MultipartPart[];
	contentType?: string;
	rawBody: boolean;
	accept: string;
	matched?: MatchedOperation;
}

const DEFAULT_BASE_URL = 'https://api.lexware.io';
const DEFAULT_USER_AGENT = `mcp-lexware-office/${VERSION}`;
const DEFAULT_MAX_RESPONSE_CHARS = 24_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 500;
const WRITE_METHODS = new Set<LexwareExecuteMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

export class LexwareApiClient {
	readonly id: string;
	readonly name: string;
	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxResponseChars: number;
	private readonly requestTimeoutMs: number;
	private readonly rateLimitIntervalMs: number;
	private readonly allowWrites?: boolean;
	private readonly readOnly?: boolean;
	private nextRequestAtMs = 0;
	private rateLimitQueue: Promise<void> = Promise.resolve();

	constructor(options: LexwareClientOptions = {}) {
		this.id = options.id ?? 'default';
		this.name = options.name ?? this.id;
		this.apiKey = options.apiKey ?? process.env.LEXWARE_OFFICE_API_KEY;
		this.baseUrl = validateBaseUrl(options.baseUrl ?? process.env.LEXWARE_OFFICE_API_BASE_URL ?? DEFAULT_BASE_URL, this.id);
		this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxResponseChars = options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.rateLimitIntervalMs = options.rateLimitIntervalMs ?? DEFAULT_RATE_LIMIT_INTERVAL_MS;
		this.allowWrites = options.allowWrites;
		this.readOnly = options.readOnly;
	}

	writesEnabled(): boolean {
		// Hard block: the global READ_ONLY wins over every per-account setting.
		if (readEnvFlag('LEXWARE_OFFICE_READ_ONLY') === true) return false;
		if (this.readOnly === true) return false;
		if (this.allowWrites !== undefined) return this.allowWrites;
		return readEnvFlag('LEXWARE_OFFICE_ALLOW_WRITES') === true;
	}

	async request(input: unknown, _options: LexwareRequestOptions = {}): Promise<LexwareResponse> {
		const apiKey = this.apiKey;
		if (!apiKey) {
			throw new Error(`API key is missing for Lexware account '${this.id}'`);
		}

		const normalized = normalizeRequest(input);
		if (WRITE_METHODS.has(normalized.method) && !this.writesEnabled()) {
			throw new Error(`${normalized.method} ${normalized.path} is blocked on account '${this.id}': writes are disabled by default. Enable them in this account's configuration: "allowWrites": true for accounts from LEXWARE_OFFICE_CONFIG_FILE / LEXWARE_OFFICE_ACCOUNTS_JSON, LEXWARE_OFFICE_ALLOW_WRITES_<ID>=true for accounts from LEXWARE_OFFICE_API_KEY_<ID>, or LEXWARE_OFFICE_ALLOW_WRITES=true in single-account setups. LEXWARE_OFFICE_READ_ONLY=true overrides all of these.`);
		}

		await this.waitForRateLimitTurn();

		const url = new URL(normalized.path, this.baseUrl);
		url.search = normalized.query.toString();

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		try {
			const headers: Record<string, string> = {
				'User-Agent': this.userAgent,
				Accept: normalized.accept,
				Authorization: `Bearer ${apiKey}`,
			};

			const { body, sent } = await serializeRequestBody(normalized, headers);

			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method: normalized.method,
					headers,
					body,
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted || isAbortError(error)) {
					throw new Error(`Lexware API request timed out after ${this.requestTimeoutMs}ms for ${normalized.method} ${normalized.path} (account '${this.id}')`);
				}
				throw new Error(`Lexware API network error for ${normalized.method} ${normalized.path}: ${sanitizeFetchErrorMessage(error, apiKey)} (account '${this.id}')`);
			}

			const parsed = await parseResponse(response, normalized, this.maxResponseChars);
			return sent !== undefined ? { ...parsed, sent } : parsed;
		} finally {
			clearTimeout(timeout);
		}
	}

	private waitForRateLimitTurn(): Promise<void> {
		if (this.rateLimitIntervalMs <= 0) return Promise.resolve();

		const wait = this.rateLimitQueue.then(async () => {
			const now = Date.now();
			const delayMs = Math.max(0, this.nextRequestAtMs - now);
			if (delayMs > 0) await delay(delayMs);
			this.nextRequestAtMs = Date.now() + this.rateLimitIntervalMs;
		});
		this.rateLimitQueue = wait.catch(() => undefined);
		return wait;
	}
}

export class LexwareClientRegistry {
	private readonly clients = new Map<string, LexwareApiClient>();
	readonly defaultAccountId?: string;

	constructor(
		accounts: AccountConfig[],
		defaultAccountId?: string,
		sharedOptions: Partial<LexwareClientOptions> = {},
	) {
		for (const acc of accounts) {
			assertValidAccountId(acc.id);
			if (this.clients.has(acc.id)) {
				throw new Error(`Duplicate Lexware account id '${acc.id}'`);
			}
			const client = new LexwareApiClient({
				...sharedOptions,
				id: acc.id,
				name: acc.name ?? acc.id,
				apiKey: acc.apiKey,
				baseUrl: acc.baseUrl,
				allowWrites: acc.allowWrites,
				readOnly: acc.readOnly,
			});
			this.clients.set(acc.id, client);
		}
		if (defaultAccountId !== undefined) {
			if (!this.clients.has(defaultAccountId)) {
				const available = Array.from(this.clients.keys()).join(', ');
				throw new Error(`LEXWARE_OFFICE_DEFAULT_ACCOUNT '${defaultAccountId}' does not match a configured account. Available accounts: [${available}]`);
			}
			this.defaultAccountId = defaultAccountId;
		} else if (accounts.length > 0) {
			this.defaultAccountId = accounts[0].id;
		}
	}

	get(accountId?: string | null): LexwareApiClient {
		const targetId = accountId ?? this.defaultAccountId;
		if (!targetId) {
			throw new Error('No Lexware accounts configured. Please provide LEXWARE_OFFICE_API_KEY or configure accounts via LEXWARE_OFFICE_ACCOUNTS_JSON / LEXWARE_OFFICE_ACCOUNTS.');
		}
		const client = this.clients.get(targetId);
		if (!client) {
			const available = Array.from(this.clients.keys()).join(', ');
			throw new Error(`Unknown Lexware account '${targetId}'. Available accounts: [${available}]`);
		}
		return client;
	}

	/**
	 * Resolves the client for a sandbox request. With 2+ accounts, writes must name
	 * their account explicitly so they never land in the default account by accident.
	 */
	resolve(accountId: string | null | undefined, request: unknown): LexwareApiClient {
		if (accountId == null && this.clients.size > 1) {
			const method = request && typeof request === 'object' ? (request as { method?: unknown }).method : undefined;
			if (typeof method === 'string' && WRITE_METHODS.has(method.toUpperCase() as LexwareExecuteMethod)) {
				const available = Array.from(this.clients.keys()).join(', ');
				throw new Error(`${method.toUpperCase()} requests must name the target account when multiple Lexware accounts are configured ([${available}]). Use lexware.account('id').request(...) or { account: 'id', ... }.`);
			}
		}
		return this.get(accountId);
	}

	has(accountId: string): boolean {
		return this.clients.has(accountId);
	}

	listAccounts(): AccountMetadata[] {
		return Array.from(this.clients.values()).map((client) => ({
			id: client.id,
			name: client.name,
			writesEnabled: client.writesEnabled(),
		}));
	}

	anyWritesEnabled(): boolean {
		return Array.from(this.clients.values()).some((client) => client.writesEnabled());
	}

	get count(): number {
		return this.clients.size;
	}
}

/**
 * Host side of the sandbox's `__lexwareRequestJson` global. Sandbox code can call that
 * global directly, so the envelope is validated strictly here rather than trusted.
 */
export function createSandboxRequestHandler(registry: LexwareClientRegistry, maxRequests: number) {
	let requestCount = 0;
	const handler = async (payload: string): Promise<string> => {
		requestCount += 1;
		if (requestCount > maxRequests) {
			throw new Error(`Execution exceeded maxRequests=${maxRequests}`);
		}
		const { accountId, request } = parseSandboxRequestEnvelope(payload);
		const client = registry.resolve(accountId, request);
		const response = await client.request(request);
		return JSON.stringify(response);
	};
	return { handler, requestCount: () => requestCount };
}

export function parseSandboxRequestEnvelope(payload: string): { accountId?: string; request: unknown } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error('lexware request payload must be JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('request' in parsed)) {
		throw new Error('lexware request payload must be an object of the form { account?, request }');
	}
	const envelope = parsed as { account?: unknown; request: unknown };
	const readAccount = (value: unknown, where: string): string | undefined => {
		if (value === undefined) return undefined;
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error(`${where} must be a non-empty account id string when provided`);
		}
		return value;
	};
	const outer = readAccount(envelope.account, 'account');
	const inner = envelope.request && typeof envelope.request === 'object' && !Array.isArray(envelope.request)
		? readAccount((envelope.request as { account?: unknown }).account, 'request.account')
		: undefined;
	if (outer !== undefined && inner !== undefined && outer !== inner) {
		throw new Error(`Conflicting account selection: '${outer}' vs request.account '${inner}'`);
	}
	return { accountId: outer ?? inner, request: envelope.request };
}

const FLAG_TRUE = new Set(['true', '1']);
const FLAG_FALSE = new Set(['false', '0']);

function parseFlag(raw: string | undefined, name: string): boolean | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	if (value.length === 0) return undefined;
	if (FLAG_TRUE.has(value)) return true;
	if (FLAG_FALSE.has(value)) return false;
	throw new Error(`${name} must be "true" or "false"`);
}

/**
 * Environment lookup that ignores case, matching Windows semantics everywhere.
 * Throws if several spellings with different values exist (possible on Linux/macOS).
 */
function readEnv(name: string): string | undefined {
	const upper = name.toUpperCase();
	const keys = Object.keys(process.env).filter((key) => key.toUpperCase() === upper);
	const values = new Set(keys.map((key) => process.env[key]));
	if (values.size > 1) {
		throw new Error(`Environment variables ${keys.join(', ')} differ only in letter case; keep exactly one`);
	}
	return keys.length > 0 ? process.env[keys[0]] : undefined;
}

/** Strictly parsed boolean environment flag: "true"/"1", "false"/"0", unset or empty; anything else throws. */
export function readEnvFlag(name: string): boolean | undefined {
	return parseFlag(readEnv(name), name);
}

// Ids that would collide with built-in members of the sandbox `lexware` object or object prototypes.
const RESERVED_ACCOUNT_IDS = new Set(['accounts', 'account', 'request', 'json', 'paginate', 'constructor', 'prototype', 'then']);
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function assertValidAccountId(id: string): void {
	if (!ACCOUNT_ID_PATTERN.test(id) || RESERVED_ACCOUNT_IDS.has(id)) {
		throw new Error(`Invalid Lexware account id '${id}': use lowercase letters, digits, '_' or '-', starting with a letter or digit, and not one of [${Array.from(RESERVED_ACCOUNT_IDS).join(', ')}]`);
	}
}

/**
 * Loads account configuration from the environment. Throws on any misconfiguration
 * instead of falling back to another source, and never includes config contents
 * (which may hold API keys) in error messages.
 */
export function loadAccountsFromEnv(): { accounts: AccountConfig[]; defaultAccountId?: string } {
	const accounts: AccountConfig[] = [];
	const addAccount = (account: AccountConfig, source: string) => {
		assertValidAccountId(account.id);
		if (accounts.some((existing) => existing.id === account.id)) {
			throw new Error(`Duplicate Lexware account id '${account.id}' (from ${source}). Account ids must be unique after normalization.`);
		}
		accounts.push(account);
	};

	// 1. Config file (LEXWARE_OFFICE_CONFIG_FILE)
	const configFilePath = process.env.LEXWARE_OFFICE_CONFIG_FILE;
	if (configFilePath !== undefined && configFilePath.trim().length > 0) {
		let content: string;
		try {
			content = readFileSync(configFilePath, 'utf8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? 'read error';
			throw new Error(`Failed to read LEXWARE_OFFICE_CONFIG_FILE (${code})`);
		}
		for (const account of parseAccountList(content, 'LEXWARE_OFFICE_CONFIG_FILE')) {
			addAccount(account, 'LEXWARE_OFFICE_CONFIG_FILE');
		}
	}

	// 2. JSON in environment variable (LEXWARE_OFFICE_ACCOUNTS_JSON)
	const accountsJson = process.env.LEXWARE_OFFICE_ACCOUNTS_JSON;
	if (accountsJson !== undefined && accountsJson.trim().length > 0) {
		for (const account of parseAccountList(accountsJson, 'LEXWARE_OFFICE_ACCOUNTS_JSON')) {
			addAccount(account, 'LEXWARE_OFFICE_ACCOUNTS_JSON');
		}
	}

	// 3. Named environment variables: LEXWARE_OFFICE_API_KEY_<ID> (+ optional explicit LEXWARE_OFFICE_ACCOUNTS list)
	const prefix = 'LEXWARE_OFFICE_API_KEY_';
	const envSuffixById = new Map<string, string>();
	for (const key of Object.keys(process.env)) {
		if (!key.startsWith(prefix) || key.length === prefix.length) continue;
		const suffix = key.slice(prefix.length);
		const id = normalizeAccountId(suffix);
		const existing = envSuffixById.get(id);
		if (existing !== undefined && existing !== suffix) {
			throw new Error(`Environment variables ${prefix}${existing} and ${prefix}${suffix} both normalize to account id '${id}'`);
		}
		envSuffixById.set(id, suffix);
	}
	const explicitList = (process.env.LEXWARE_OFFICE_ACCOUNTS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(normalizeAccountId);
	for (const id of explicitList) {
		if (!envSuffixById.has(id) && !accounts.some((existing) => existing.id === id)) {
			throw new Error(`Account '${id}' is listed in LEXWARE_OFFICE_ACCOUNTS but ${prefix}${id.toUpperCase()} is not set`);
		}
	}
	// Order: as listed in LEXWARE_OFFICE_ACCOUNTS, then the rest sorted by id. Never rely on
	// process.env key order, which differs between platforms.
	const envIds = [
		...explicitList.filter((id, index) => envSuffixById.has(id) && explicitList.indexOf(id) === index),
		...Array.from(envSuffixById.keys()).filter((id) => !explicitList.includes(id)).sort(),
	];
	for (const id of envIds) {
		const suffix = envSuffixById.get(id) as string;
		const upperSuffix = suffix.toUpperCase();
		const apiKey = readEnv(`${prefix}${suffix}`)?.trim();
		if (!apiKey) {
			throw new Error(`${prefix}${suffix} is empty`);
		}
		addAccount({
			id,
			name: readEnv(`LEXWARE_OFFICE_NAME_${upperSuffix}`) ?? id,
			apiKey,
			allowWrites: readEnvFlag(`LEXWARE_OFFICE_ALLOW_WRITES_${upperSuffix}`),
			readOnly: readEnvFlag(`LEXWARE_OFFICE_READ_ONLY_${upperSuffix}`),
		}, `${prefix}${suffix}`);
	}

	// 4. Single-account legacy fallback
	const legacyApiKey = process.env.LEXWARE_OFFICE_API_KEY?.trim();
	if (legacyApiKey && accounts.length > 0) {
		throw new Error('LEXWARE_OFFICE_API_KEY cannot be combined with other account sources. Rename it to LEXWARE_OFFICE_API_KEY_DEFAULT (or add it to your account JSON) to keep it as account \'default\'.');
	}
	if (legacyApiKey) {
		addAccount({
			id: 'default',
			name: process.env.LEXWARE_OFFICE_ACCOUNT_NAME ?? 'Default Account',
			apiKey: legacyApiKey,
		}, 'LEXWARE_OFFICE_API_KEY');
	}

	// Fail at startup on malformed global flags instead of silently ignoring them.
	readEnvFlag('LEXWARE_OFFICE_READ_ONLY');
	readEnvFlag('LEXWARE_OFFICE_ALLOW_WRITES');

	// The global LEXWARE_OFFICE_ALLOW_WRITES only applies to single-account setups.
	// With 2+ accounts every account must opt in to writes on its own.
	if (accounts.length > 1) {
		for (const account of accounts) {
			if (account.allowWrites === undefined) account.allowWrites = false;
		}
	}

	const rawDefault = process.env.LEXWARE_OFFICE_DEFAULT_ACCOUNT?.trim();
	const defaultAccountId = rawDefault ? normalizeAccountId(rawDefault) : accounts[0]?.id;
	if (defaultAccountId !== undefined && !accounts.some((account) => account.id === defaultAccountId)) {
		throw new Error(`LEXWARE_OFFICE_DEFAULT_ACCOUNT '${defaultAccountId}' does not match a configured account. Available accounts: [${accounts.map((a) => a.id).join(', ')}]`);
	}

	return { accounts, defaultAccountId };
}

function parseAccountList(json: string, source: string): AccountConfig[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		// Deliberately omit the parser message: it can quote config contents, including API keys.
		throw new Error(`${source} is not valid JSON`);
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).accounts)
			? (parsed as Record<string, unknown>).accounts as unknown[]
			: undefined;
	if (list === undefined) {
		throw new Error(`${source} must be a JSON array of accounts or an object with an "accounts" array`);
	}
	return list.map((item, index) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new Error(`${source} entry #${index + 1} must be an object`);
		}
		const entry = item as Record<string, unknown>;
		for (const flag of ['allowWrites', 'readOnly']) {
			if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
				throw new Error(`${source} entry #${index + 1}: ${flag} must be true or false (JSON boolean, not a string)`);
			}
		}
		if (entry.baseUrl !== undefined && typeof entry.baseUrl !== 'string') {
			throw new Error(`${source} entry #${index + 1}: baseUrl must be a string`);
		}
		if (typeof entry.apiKey !== 'string' || entry.apiKey.trim().length === 0) {
			throw new Error(`${source} entry #${index + 1} is missing a non-empty string apiKey`);
		}
		const rawId = typeof entry.id === 'string' && entry.id.trim().length > 0
			? entry.id
			: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name : undefined;
		if (rawId === undefined) {
			throw new Error(`${source} entry #${index + 1} needs an id`);
		}
		return {
			id: normalizeAccountId(rawId),
			name: typeof entry.name === 'string' ? entry.name : normalizeAccountId(rawId),
			apiKey: entry.apiKey.trim(),
			allowWrites: typeof entry.allowWrites === 'boolean' ? entry.allowWrites : undefined,
			readOnly: typeof entry.readOnly === 'boolean' ? entry.readOnly : undefined,
			baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined,
		};
	});
}

function normalizeAccountId(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function validateBaseUrl(raw: string, accountId: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid Lexware API base URL for account '${accountId}'`);
	}
	// The API key is sent as a bearer token; never allow it over plaintext HTTP.
	if (url.protocol !== 'https:') {
		throw new Error(`Lexware API base URL for account '${accountId}' must use https://`);
	}
	if (url.username || url.password) {
		throw new Error(`Lexware API base URL for account '${accountId}' must not contain credentials`);
	}
	return url.origin;
}

function normalizeRequest(input: unknown): NormalizedRequest {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('lexware.request expects an object: { method?, path, query?, body?, contentType?, rawBody?, accept? }');
	}

	const request = input as LexwareRequestInput;
	const method = normalizeMethod(request.method ?? 'GET');
	const rawPath = normalizePath(request.path);
	const accept = normalizeHeaderValue(request.accept ?? 'application/json', 'accept');
	const contentType = request.contentType === undefined ? undefined : normalizeHeaderValue(request.contentType, 'contentType');
	const rawBody = normalizeRawBody(request.rawBody ?? false);
	const url = new URL(rawPath, DEFAULT_BASE_URL);
	if (!url.pathname.startsWith('/v1/')) {
		throw new Error('path must resolve to /v1/ and must not escape that prefix');
	}
	const matched = matchOperation(url.pathname, method);

	if (method === 'GET' && request.body !== undefined) {
		throw new Error('GET requests must not include a body');
	}

	if (method === 'GET' && request.bodyBase64 !== undefined) {
		throw new Error('GET requests must not include a body');
	}

	if (method === 'GET' && request.multipart !== undefined) {
		throw new Error('GET requests must not include a body');
	}

	if (rawBody && request.body !== undefined && typeof request.body !== 'string') {
		throw new Error('rawBody=true requires body to be a string, and strings are UTF-8 encoded on the wire (not binary-safe). For file uploads use multipart: [{ name, filename, contentType, contentPath | contentBase64 }, ...] or bodyBase64 instead.');
	}

	// Mutual exclusion: bodyBase64, multipart, and body/rawBody are distinct modes.
	const bodyModesSet = [
		request.body !== undefined,
		request.bodyBase64 !== undefined,
		request.multipart !== undefined,
	].filter(Boolean).length;
	if (bodyModesSet > 1) {
		throw new Error('At most one of body, bodyBase64, or multipart may be set on a single request.');
	}

	const bodyBase64 = request.bodyBase64 === undefined ? undefined : normalizeBase64Field(request.bodyBase64, 'bodyBase64');
	const multipart = request.multipart === undefined ? undefined : normalizeMultipart(request.multipart);

	// Fail fast on multipart endpoints instead of letting the Lexware API return an opaque 500:
	// body/bodyBase64 only make sense there when the caller hand-rolls the multipart encoding
	// and says so via an explicit multipart/* contentType with boundary.
	if (
		matched?.operation.requestBody?.contentType === 'multipart/form-data'
		&& multipart === undefined
		&& (request.body !== undefined || bodyBase64 !== undefined)
		&& !(contentType?.toLowerCase().includes('multipart/'))
	) {
		throw new Error(`${method} ${url.pathname} expects multipart/form-data. Use the multipart request field, e.g. multipart: [{ name: 'file', filename: 'doc.pdf', contentType: 'application/pdf', contentPath: '/absolute/path/doc.pdf' }, { name: 'type', value: 'voucher' }]. body/bodyBase64 are only allowed here with an explicit contentType containing 'multipart/' and a boundary.`);
	}

	const query = new URLSearchParams(url.search);
	appendQueryObject(query, request.query);

	return {
		method,
		path: url.pathname,
		query,
		body: request.body,
		bodyBase64,
		multipart,
		contentType,
		rawBody,
		accept,
		matched,
	};
}

function normalizeMethod(method: unknown): LexwareExecuteMethod {
	if (typeof method !== 'string') throw new Error('method must be a string');
	const normalized = method.toUpperCase();
	if (normalized !== 'GET' && normalized !== 'POST' && normalized !== 'PUT' && normalized !== 'PATCH' && normalized !== 'DELETE') {
		throw new Error(`Unsupported method: ${method}`);
	}
	return normalized;
}

function normalizePath(path: unknown): string {
	if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string');
	if (!path.startsWith('/')) throw new Error('path must start with / and must not include a host');
	if (path.startsWith('//') || path.includes('://')) throw new Error('path must be relative to the Lexware API host');
	if (!path.startsWith('/v1/')) throw new Error('path must start with /v1/');
	return path;
}

function normalizeRawBody(rawBody: unknown): boolean {
	if (typeof rawBody !== 'boolean') throw new Error('rawBody must be a boolean when provided');
	return rawBody;
}

function normalizeHeaderValue(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	if (/\r|\n/.test(value)) throw new Error(`${field} must not contain newlines`);
	if (value.length > 500) throw new Error(`${field} is too long`);
	return value.trim();
}

function normalizeBase64Field(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`${field} must be a string`);
	// Validate that it is base64 (standard or URL-safe alphabet, with optional padding).
	if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(value)) {
		throw new Error(`${field} must be a valid base64-encoded string`);
	}
	return value;
}

function normalizeMultipart(parts: unknown): MultipartPart[] {
	if (!Array.isArray(parts)) throw new Error('multipart must be an array');
	return parts.map((part, index) => {
		if (!part || typeof part !== 'object' || Array.isArray(part)) {
			throw new Error(`multipart[${index}] must be an object`);
		}
		const p = part as Record<string, unknown>;
		if (typeof p.name !== 'string' || p.name.trim().length === 0) {
			throw new Error(`multipart[${index}].name must be a non-empty string`);
		}
		if (p.value !== undefined && typeof p.value !== 'string') {
			throw new Error(`multipart[${index}].value must be a string when provided`);
		}
		if (p.filename !== undefined && typeof p.filename !== 'string') {
			throw new Error(`multipart[${index}].filename must be a string when provided`);
		}
		if (p.contentType !== undefined && typeof p.contentType !== 'string') {
			throw new Error(`multipart[${index}].contentType must be a string when provided`);
		}
		if (p.contentBase64 !== undefined) {
			normalizeBase64Field(p.contentBase64, `multipart[${index}].contentBase64`);
		}
		if (p.contentPath !== undefined) {
			if (typeof p.contentPath !== 'string' || p.contentPath.trim().length === 0) {
				throw new Error(`multipart[${index}].contentPath must be a non-empty string`);
			}
			if (!isAbsolute(p.contentPath)) {
				throw new Error(`multipart[${index}].contentPath must be an absolute path on the MCP server machine`);
			}
		}
		const contentModes = [p.value !== undefined, p.contentBase64 !== undefined, p.contentPath !== undefined].filter(Boolean).length;
		if (contentModes !== 1) {
			throw new Error(`multipart[${index}] must have exactly one of value, contentBase64, or contentPath`);
		}
		return {
			name: p.name as string,
			...(p.value !== undefined && { value: p.value as string }),
			...(p.filename !== undefined && { filename: p.filename as string }),
			...(p.contentType !== undefined && { contentType: p.contentType as string }),
			...(p.contentBase64 !== undefined && { contentBase64: p.contentBase64 as string }),
			...(p.contentPath !== undefined && { contentPath: p.contentPath as string }),
		};
	});
}

function appendQueryObject(query: URLSearchParams, queryObject: unknown): void {
	if (queryObject === undefined) return;
	if (!queryObject || typeof queryObject !== 'object' || Array.isArray(queryObject)) {
		throw new Error('query must be an object of string, number, boolean, or array values');
	}

	for (const [key, value] of Object.entries(queryObject as Record<string, QueryValue>)) {
		if (value === undefined || value === null) continue;
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) {
			if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
				throw new Error(`query.${key} must be a string, number, boolean, or an array of those values`);
			}
			query.append(key, String(item));
		}
	}
}

function matchOperation(pathname: string, method: LexwareExecuteMethod): MatchedOperation | undefined {
	const methodKey = method.toLowerCase() as HttpMethod;
	for (const [pathTemplate, methods] of Object.entries(lexwareSpec.paths)) {
		const operation = methods[methodKey];
		if (!operation) continue;
		if (pathTemplateToRegex(pathTemplate).test(pathname)) {
			return { pathTemplate, operation };
		}
	}
	return undefined;
}

function pathTemplateToRegex(template: string): RegExp {
	const pattern = template
		.split('/')
		.map((segment) => (segment.startsWith('{') && segment.endsWith('}') ? '[^/]+' : escapeRegex(segment)))
		.join('/');
	return new RegExp(`^${pattern}$`);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

interface SerializedBody {
	body: BodyInit | undefined;
	sent?: UploadEcho;
}

async function serializeRequestBody(request: NormalizedRequest, headers: Record<string, string>): Promise<SerializedBody> {
	// Binary body: decode base64 on the host, send raw bytes.
	if (request.bodyBase64 !== undefined) {
		headers['Content-Type'] = request.contentType ?? 'application/octet-stream';
		const buffer = Buffer.from(request.bodyBase64, 'base64');
		return { body: buffer, sent: { bytes: buffer.length, sha256: sha256Hex(buffer) } };
	}

	// Multipart body: build FormData on the host with binary-safe parts.
	if (request.multipart !== undefined) {
		const formData = new FormData();
		const sentParts: NonNullable<UploadEcho['parts']> = [];
		for (const part of request.multipart) {
			let buffer: Buffer<ArrayBuffer> | undefined;
			let defaultFilename = part.name;
			if (part.contentBase64 !== undefined) {
				buffer = Buffer.from(part.contentBase64, 'base64');
			} else if (part.contentPath !== undefined) {
				buffer = await readUploadFile(part.contentPath);
				defaultFilename = basename(part.contentPath);
			}
			if (buffer !== undefined) {
				const blob = new Blob([buffer], { type: part.contentType ?? 'application/octet-stream' });
				const filename = part.filename ?? defaultFilename;
				formData.append(part.name, blob, filename);
				sentParts.push({ name: part.name, filename, bytes: buffer.length, sha256: sha256Hex(buffer) });
			} else {
				formData.append(part.name, part.value ?? '');
			}
		}
		// Do NOT set Content-Type manually; the Fetch API sets it with the correct boundary.
		const sent = sentParts.length > 0
			? { bytes: sentParts.reduce((sum, part) => sum + part.bytes, 0), parts: sentParts }
			: undefined;
		return { body: formData, ...(sent !== undefined && { sent }) };
	}

	if (request.body === undefined) return { body: undefined };

	if (request.rawBody) {
		headers['Content-Type'] = request.contentType ?? 'application/octet-stream';
		return { body: request.body as string };
	}

	const contentType = request.contentType ?? 'application/json';
	headers['Content-Type'] = contentType;
	if (isJsonContentType(contentType)) {
		return { body: JSON.stringify(request.body) };
	}
	if (typeof request.body === 'string') {
		return { body: request.body };
	}
	throw new Error('Non-JSON request bodies must be strings or use rawBody=true with an explicit contentType.');
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.xml']);

function isInsideDirectory(directory: string, candidate: string): boolean {
	const rel = relative(directory, candidate);
	return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Host file reads are confined to LEXWARE_OFFICE_UPLOAD_DIR so sandbox code cannot
 * read arbitrary files (e.g. the account config holding API keys). The lexical check
 * runs before any filesystem access so paths outside the directory reveal nothing.
 */
async function resolveUploadPath(contentPath: string): Promise<string> {
	const uploadDir = process.env.LEXWARE_OFFICE_UPLOAD_DIR?.trim();
	if (!uploadDir) {
		throw new Error('multipart contentPath uploads are disabled. Set LEXWARE_OFFICE_UPLOAD_DIR to a directory containing the files to upload, or use contentBase64.');
	}
	const resolvedDir = resolve(uploadDir);
	const requested = resolve(contentPath);
	if (!isInsideDirectory(resolvedDir, requested)) {
		throw new Error(`multipart contentPath must be inside LEXWARE_OFFICE_UPLOAD_DIR (${resolvedDir})`);
	}
	if (!ALLOWED_UPLOAD_EXTENSIONS.has(extname(requested).toLowerCase())) {
		throw new Error(`multipart contentPath must have one of the extensions ${Array.from(ALLOWED_UPLOAD_EXTENSIONS).join(', ')}`);
	}

	let realDir: string;
	let realFile: string;
	try {
		realDir = await realpath(resolvedDir);
		realFile = await realpath(requested);
	} catch {
		throw new Error(`multipart contentPath not found or not readable: ${contentPath}`);
	}
	// Re-check after resolving symlinks so a link inside the directory cannot point elsewhere.
	if (!isInsideDirectory(realDir, realFile) || !ALLOWED_UPLOAD_EXTENSIONS.has(extname(realFile).toLowerCase())) {
		throw new Error(`multipart contentPath must be inside LEXWARE_OFFICE_UPLOAD_DIR (${resolvedDir})`);
	}
	const configFile = process.env.LEXWARE_OFFICE_CONFIG_FILE?.trim();
	if (configFile) {
		const realConfig = await realpath(configFile).catch(() => resolve(configFile));
		if (realConfig === realFile) {
			throw new Error('multipart contentPath must not point at the Lexware account configuration file');
		}
	}
	return realFile;
}

async function readUploadFile(requestedPath: string): Promise<Buffer<ArrayBuffer>> {
	const contentPath = await resolveUploadPath(requestedPath);
	// Open once and read through the handle; O_NOFOLLOW where the platform supports it.
	let handle: FileHandle;
	try {
		handle = await open(contentPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	} catch {
		throw new Error(`multipart contentPath not found or not readable: ${requestedPath}`);
	}
	try {
		const stats = await handle.stat({ bigint: true });
		if (!stats.isFile()) {
			throw new Error(`multipart contentPath must be a regular file: ${contentPath}`);
		}
		if (stats.nlink > 1n) {
			// realpath cannot see hard links, so a link to a file outside the directory would pass the containment check.
			throw new Error(`multipart contentPath must not be a hard-linked file: ${contentPath}`);
		}
		if (stats.size > BigInt(MAX_UPLOAD_FILE_BYTES)) {
			throw new Error(`multipart contentPath file is ${stats.size} bytes, exceeding the ${MAX_UPLOAD_FILE_BYTES} byte upload limit: ${contentPath}`);
		}
		// Re-resolve after opening and make sure the opened file is still the one inside the upload directory.
		const recheckedPath = await resolveUploadPath(requestedPath);
		const current = await stat(recheckedPath, { bigint: true });
		if (current.dev !== stats.dev || current.ino !== stats.ino) {
			throw new Error(`multipart contentPath changed while it was being read: ${requestedPath}`);
		}
		return await handle.readFile() as Buffer<ArrayBuffer>;
	} finally {
		await handle.close();
	}
}

function sha256Hex(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function isJsonContentType(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower === 'application/json' || lower.endsWith('+json') || lower.includes('/json');
}

async function parseResponse(response: Response, request: NormalizedRequest, maxResponseChars: number): Promise<LexwareResponse> {
	const contentType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
	const headers = headersToObject(response.headers);
	const base: Omit<LexwareResponse, 'data' | 'text' | 'truncated'> = {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		...(request.matched ? {
			operation: {
				operationId: request.matched.operation.operationId,
				method: request.method,
				pathTemplate: request.matched.pathTemplate,
				summary: request.matched.operation.summary,
			},
		} : {}),
		request: {
			method: request.method,
			path: request.path,
			query: queryToObject(request.query),
		},
		contentType,
		headers,
	};

	if (!response.ok) {
		base.errorCategory = categorizeStatus(response.status) ?? 'unknown';
		if (response.status === 429) {
			const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
			if (retryAfterSeconds !== undefined) base.retryAfterSeconds = retryAfterSeconds;
		}
	}

	if (response.status === 204) return base;

	const isTextual = isTextualResponse(contentType, request.accept);
	if (!isTextual) {
		// Avoid buffering the full binary body — use Content-Length if available.
		response.body?.cancel();
		const contentLengthHeader = response.headers.get('content-length');
		const contentLengthBytes = contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
		const binaryMeta = Number.isFinite(contentLengthBytes) && contentLengthBytes >= 0
			? { binary: true, contentType: contentType || 'application/octet-stream', bytes: contentLengthBytes, bytesSource: 'content-length' as const, omitted: true }
			: { binary: true, contentType: contentType || 'application/octet-stream', omitted: true, bytesUnknown: true };
		return { ...base, data: binaryMeta };
	}

	const rawText = await response.text();
	// Strip UTF-8 BOM (﻿) that some servers prepend; JSON.parse rejects it.
	const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

	if (isJsonResponse(contentType, request.accept)) {
		try {
			return { ...base, data: text.length > 0 ? JSON.parse(text) : null };
		} catch {
			// Fall through to compact text handling for malformed JSON responses.
		}
	}

	const truncated = text.length > maxResponseChars;
	const safeText = truncated ? truncateText(text, { maxChars: maxResponseChars }) : text;
	return { ...base, text: safeText, truncated };
}

function isTextualResponse(contentType: string, accept: string): boolean {
	const lowerContentType = contentType.toLowerCase();
	if (lowerContentType) {
		return lowerContentType.includes('json') || lowerContentType.startsWith('text/') || lowerContentType.includes('xml');
	}

	const lowerAccept = accept.toLowerCase();
	return lowerAccept.includes('json') || lowerAccept.includes('text/') || lowerAccept.includes('xml');
}

function isJsonResponse(contentType: string, accept: string): boolean {
	const lowerContentType = contentType.toLowerCase();
	if (lowerContentType) return lowerContentType.includes('json');
	return accept.toLowerCase().includes('json');
}

function categorizeStatus(status: number): LexwareResponse['errorCategory'] | undefined {
	if (status === 400 || status === 422) return 'validation';
	if (status === 401) return 'auth';
	if (status === 403) return 'permission';
	if (status === 404) return 'not_found';
	if (status === 409) return 'conflict';
	if (status === 429) return 'rate_limit';
	if (status >= 500 && status <= 599) return 'server';
	if (status < 200 || status >= 300) return 'unknown';
	return undefined;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);

	const retryDateMs = Date.parse(trimmed);
	if (!Number.isFinite(retryDateMs)) return undefined;
	const seconds = Math.ceil((retryDateMs - Date.now()) / 1000);
	return seconds > 0 ? seconds : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function sanitizeFetchErrorMessage(error: unknown, apiKey: string): string {
	const rawMessage = error instanceof Error ? error.message : String(error);
	const message = rawMessage.length > 0 ? rawMessage : 'unknown error';
	return message
		.replaceAll(apiKey, '[redacted]')
		.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
		.replace(/https?:\/\/[^\s)]+/gi, '[url omitted]');
}


function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersToObject(headers: Headers): Record<string, string> {
	const object: Record<string, string> = {};
	headers.forEach((value, key) => {
		object[key] = value;
	});
	return object;
}

function queryToObject(query: URLSearchParams): Record<string, string[]> {
	const object: Record<string, string[]> = {};
	query.forEach((value, key) => {
		object[key] ??= [];
		object[key].push(value);
	});
	return object;
}
