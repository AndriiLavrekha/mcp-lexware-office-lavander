import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';
import {
	LexwareClientRegistry,
	loadAccountsFromEnv,
	type AccountConfig,
} from './lexware-client.js';

test('loadAccountsFromEnv: single legacy key maps to default account', () => {
	const originalEnv = { ...process.env };
	try {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith('LEXWARE_OFFICE_')) delete process.env[key];
		}
		process.env.LEXWARE_OFFICE_API_KEY = 'test-single-key';

		const { accounts, defaultAccountId } = loadAccountsFromEnv();
		assert.equal(accounts.length, 1);
		assert.equal(accounts[0].id, 'default');
		assert.equal(accounts[0].apiKey, 'test-single-key');
		assert.equal(defaultAccountId, 'default');
	} finally {
		process.env = originalEnv;
	}
});

test('loadAccountsFromEnv: discovers prefixed environment variables', () => {
	const originalEnv = { ...process.env };
	try {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith('LEXWARE_OFFICE_')) delete process.env[key];
		}
		process.env.LEXWARE_OFFICE_ACCOUNTS = 'freelance,gewerbe';
		process.env.LEXWARE_OFFICE_API_KEY_FREELANCE = 'key-freelance';
		process.env.LEXWARE_OFFICE_NAME_FREELANCE = 'Freelance Consultation';
		process.env.LEXWARE_OFFICE_ALLOW_WRITES_FREELANCE = 'true';

		process.env.LEXWARE_OFFICE_API_KEY_GEWERBE = 'key-gewerbe';
		process.env.LEXWARE_OFFICE_NAME_GEWERBE = 'SaaS & AdSense';
		process.env.LEXWARE_OFFICE_ALLOW_WRITES_GEWERBE = 'false';

		process.env.LEXWARE_OFFICE_DEFAULT_ACCOUNT = 'freelance';

		const { accounts, defaultAccountId } = loadAccountsFromEnv();
		assert.equal(accounts.length, 2);

		const freelance = accounts.find((a) => a.id === 'freelance');
		assert.ok(freelance);
		assert.equal(freelance.apiKey, 'key-freelance');
		assert.equal(freelance.name, 'Freelance Consultation');
		assert.equal(freelance.allowWrites, true);

		const gewerbe = accounts.find((a) => a.id === 'gewerbe');
		assert.ok(gewerbe);
		assert.equal(gewerbe.apiKey, 'key-gewerbe');
		assert.equal(gewerbe.name, 'SaaS & AdSense');
		assert.equal(gewerbe.allowWrites, false);

		assert.equal(defaultAccountId, 'freelance');
	} finally {
		process.env = originalEnv;
	}
});

test('loadAccountsFromEnv: parses LEXWARE_OFFICE_ACCOUNTS_JSON', () => {
	const originalEnv = { ...process.env };
	try {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith('LEXWARE_OFFICE_')) delete process.env[key];
		}
		process.env.LEXWARE_OFFICE_ACCOUNTS_JSON = JSON.stringify([
			{ id: 'freelance', name: 'Freelance', apiKey: 'key-1', allowWrites: true },
			{ id: 'saas', name: 'SaaS Products', apiKey: 'key-2', allowWrites: false },
			{ id: 'youtube', name: 'YouTube Media', apiKey: 'key-3', allowWrites: false },
		]);

		const { accounts, defaultAccountId } = loadAccountsFromEnv();
		assert.equal(accounts.length, 3);
		assert.equal(accounts[0].id, 'freelance');
		assert.equal(accounts[1].id, 'saas');
		assert.equal(accounts[2].id, 'youtube');
		assert.equal(defaultAccountId, 'freelance');
	} finally {
		process.env = originalEnv;
	}
});

test('LexwareClientRegistry: manages multiple accounts and routing', () => {
	const testAccounts: AccountConfig[] = [
		{ id: 'freelance', name: 'Freelance', apiKey: 'key-f', allowWrites: true },
		{ id: 'gewerbe', name: 'Gewerbe', apiKey: 'key-g', allowWrites: false },
	];

	const registry = new LexwareClientRegistry(testAccounts, 'freelance');
	assert.equal(registry.count, 2);
	assert.equal(registry.defaultAccountId, 'freelance');

	const freelanceClient = registry.get('freelance');
	assert.equal(freelanceClient.id, 'freelance');
	assert.equal(freelanceClient.writesEnabled(), true);

	const gewerbeClient = registry.get('gewerbe');
	assert.equal(gewerbeClient.id, 'gewerbe');
	assert.equal(gewerbeClient.writesEnabled(), false);

	const defaultClient = registry.get();
	assert.equal(defaultClient.id, 'freelance');

	assert.throws(
		() => registry.get('nonexistent'),
		/Unknown Lexware account 'nonexistent'/,
	);

	const list = registry.listAccounts();
	assert.equal(list.length, 2);
	assert.deepEqual(list, [
		{ id: 'freelance', name: 'Freelance', writesEnabled: true },
		{ id: 'gewerbe', name: 'Gewerbe', writesEnabled: false },
	]);
});

test('QuickJsExecutor: multi-account sandboxed API and consolidation', async () => {
	const executor = new QuickJsExecutor();

	const accounts = [
		{ id: 'freelance', name: 'Freelance Consulting', writesEnabled: true },
		{ id: 'gewerbe', name: 'SaaS Commercial', writesEnabled: false },
	];

	const requestedAccounts: string[] = [];

	const result = await executor.execute(
		`async () => {
			// Test account metadata
			const accountList = lexware.accounts.map(a => a.id);

			// Test allAccounts batch consolidation
			const data = await lexware.allAccounts(async (client, id) => {
				const response = await client.request({ path: '/v1/test' });
				return {
					name: client.name,
					items: response.data.items,
					total: lexware.sumMoney(response.data.items, 'amount')
				};
			});

			const grandTotal = data.freelance.total + data.gewerbe.total;

			return {
				accountList,
				freelanceTotal: lexware.formatMoney(data.freelance.total),
				gewerbeTotal: lexware.formatMoney(data.gewerbe.total),
				consolidated: lexware.formatMoney(grandTotal)
			};
		}`,
		{
			spec: { info: { title: 'Test Spec' } },
			accounts,
			defaultAccountId: 'freelance',
		},
		{
			filename: 'test-multi-account.js',
			hostFunctions: {
				__lexwareRequestJson: async (payloadStr) => {
					const payload = JSON.parse(payloadStr) as { account?: string; request: { path: string } };
					requestedAccounts.push(payload.account ?? 'unknown');

					if (payload.account === 'freelance') {
						return JSON.stringify({
							ok: true,
							status: 200,
							contentType: 'application/json',
							data: {
								items: [
									{ name: 'Consulting Dev', amount: '1500.00' },
									{ name: 'Architecture Review', amount: '800.50' },
								],
							},
						});
					}

					return JSON.stringify({
						ok: true,
						status: 200,
						contentType: 'application/json',
						data: {
							items: [
								{ name: 'SaaS Subscription Tier 1', amount: '299.00' },
								{ name: 'AdSense Revenue', amount: '120.50' },
							],
						},
					});
				},
			},
		},
	);

	assert.equal(result.error, undefined);
	assert.deepEqual(result.result, {
		accountList: ['freelance', 'gewerbe'],
		freelanceTotal: 'EUR 2300.50',
		gewerbeTotal: 'EUR 419.50',
		consolidated: 'EUR 2720.00',
	});

	assert.deepEqual(requestedAccounts.sort(), ['freelance', 'gewerbe']);
});

const withEnv = (vars: Record<string, string>, fn: () => void) => {
	const originalEnv = { ...process.env };
	try {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith('LEXWARE_OFFICE_')) delete process.env[key];
		}
		Object.assign(process.env, vars);
		fn();
	} finally {
		process.env = originalEnv;
	}
};

test('global LEXWARE_OFFICE_READ_ONLY=true wins over per-account readOnly=false and allowWrites=true', () => {
	withEnv({ LEXWARE_OFFICE_READ_ONLY: 'true' }, () => {
		const registry = new LexwareClientRegistry([
			{ id: 'a', apiKey: 'k1', allowWrites: true, readOnly: false },
			{ id: 'b', apiKey: 'k2', allowWrites: true },
		]);
		assert.equal(registry.get('a').writesEnabled(), false);
		assert.equal(registry.get('b').writesEnabled(), false);
		assert.equal(registry.anyWritesEnabled(), false);
	});

	withEnv({ LEXWARE_OFFICE_READ_ONLY: 'true', LEXWARE_OFFICE_API_KEY_A: 'k1', LEXWARE_OFFICE_ALLOW_WRITES_A: 'true', LEXWARE_OFFICE_READ_ONLY_A: 'false' }, () => {
		const { accounts } = loadAccountsFromEnv();
		const registry = new LexwareClientRegistry(accounts);
		assert.equal(registry.get('a').writesEnabled(), false);
	});
});

test('per-account readOnly=true blocks writes even with allowWrites=true', () => {
	withEnv({}, () => {
		const registry = new LexwareClientRegistry([{ id: 'a', apiKey: 'k1', allowWrites: true, readOnly: true }]);
		assert.equal(registry.get('a').writesEnabled(), false);
	});
});

test('global LEXWARE_OFFICE_ALLOW_WRITES only applies to single-account setups', () => {
	withEnv({
		LEXWARE_OFFICE_ALLOW_WRITES: 'true',
		LEXWARE_OFFICE_API_KEY_A: 'k1',
		LEXWARE_OFFICE_API_KEY_B: 'k2',
		LEXWARE_OFFICE_ALLOW_WRITES_B: 'true',
	}, () => {
		const { accounts } = loadAccountsFromEnv();
		const registry = new LexwareClientRegistry(accounts);
		assert.deepEqual(registry.listAccounts().map((a) => [a.id, a.writesEnabled]), [['a', false], ['b', true]]);
	});

	withEnv({ LEXWARE_OFFICE_ALLOW_WRITES: 'true', LEXWARE_OFFICE_API_KEY_SOLO: 'k1' }, () => {
		const { accounts } = loadAccountsFromEnv();
		assert.equal(new LexwareClientRegistry(accounts).get('solo').writesEnabled(), true);
	});

	withEnv({ LEXWARE_OFFICE_ALLOW_WRITES: 'true', LEXWARE_OFFICE_API_KEY: 'legacy' }, () => {
		const { accounts } = loadAccountsFromEnv();
		assert.equal(new LexwareClientRegistry(accounts).get().writesEnabled(), true);
	});
});

test('registry.resolve: writes need an explicit account when 2+ accounts exist', () => {
	withEnv({}, () => {
		const registry = new LexwareClientRegistry([
			{ id: 'a', apiKey: 'k1', allowWrites: true },
			{ id: 'b', apiKey: 'k2', allowWrites: true },
		], 'a');
		assert.equal(registry.resolve(undefined, { path: '/v1/contacts' }).id, 'a');
		assert.equal(registry.resolve(undefined, { method: 'get', path: '/v1/contacts' }).id, 'a');
		for (const method of ['POST', 'put', 'PATCH', 'delete']) {
			assert.throws(() => registry.resolve(undefined, { method, path: '/v1/contacts' }), /must name the target account/);
		}
		assert.equal(registry.resolve('b', { method: 'POST', path: '/v1/contacts' }).id, 'b');

		const single = new LexwareClientRegistry([{ id: 'a', apiKey: 'k1', allowWrites: true }]);
		assert.equal(single.resolve(undefined, { method: 'POST', path: '/v1/contacts' }).id, 'a');
	});
});

test('unknown LEXWARE_OFFICE_DEFAULT_ACCOUNT fails instead of falling back to the first account', () => {
	withEnv({ LEXWARE_OFFICE_API_KEY_A: 'k1', LEXWARE_OFFICE_API_KEY_B: 'k2', LEXWARE_OFFICE_DEFAULT_ACCOUNT: 'typo' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /LEXWARE_OFFICE_DEFAULT_ACCOUNT 'typo' does not match/);
	});
	assert.throws(() => new LexwareClientRegistry([{ id: 'a', apiKey: 'k1' }], 'typo'), /does not match a configured account/);
});

test('invalid account config fails hard without echoing its contents', () => {
	withEnv({ LEXWARE_OFFICE_ACCOUNTS_JSON: '[{"id":"a","apiKey":"super-secret-key"' }, () => {
		assert.throws(() => loadAccountsFromEnv(), (error: Error) => {
			assert.match(error.message, /LEXWARE_OFFICE_ACCOUNTS_JSON is not valid JSON/);
			assert.doesNotMatch(error.message, /super-secret-key/);
			return true;
		});
	});
	withEnv({ LEXWARE_OFFICE_ACCOUNTS_JSON: '{"foo":1}' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /must be a JSON array/);
	});
	withEnv({ LEXWARE_OFFICE_ACCOUNTS_JSON: '[{"id":"a"}]', LEXWARE_OFFICE_API_KEY: 'legacy' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /missing a non-empty string apiKey/);
	});
	withEnv({ LEXWARE_OFFICE_CONFIG_FILE: '/definitely/not/a/real/config.json', LEXWARE_OFFICE_API_KEY: 'legacy' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /Failed to read LEXWARE_OFFICE_CONFIG_FILE \(ENOENT\)/);
	});
});

test('account ids: duplicates, reserved names, and unlisted accounts are rejected', () => {
	withEnv({ LEXWARE_OFFICE_ACCOUNTS_JSON: JSON.stringify([{ id: 'Shop', apiKey: 'k1' }, { id: 'shop', apiKey: 'k2' }]) }, () => {
		assert.throws(() => loadAccountsFromEnv(), /Duplicate Lexware account id 'shop'/);
	});
	withEnv({ LEXWARE_OFFICE_ACCOUNTS_JSON: JSON.stringify([{ id: 'shop', apiKey: 'k1' }]), LEXWARE_OFFICE_API_KEY_SHOP: 'k2' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /Duplicate Lexware account id 'shop'/);
	});
	withEnv({ 'LEXWARE_OFFICE_API_KEY_MY.SHOP': 'k1', LEXWARE_OFFICE_API_KEY_MY_SHOP: 'k2' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /both normalize to account id 'my_shop'/);
	});
	withEnv({ 'LEXWARE_OFFICE_API_KEY_MY.SHOP': 'k1', 'LEXWARE_OFFICE_NAME_MY.SHOP': 'My Shop' }, () => {
		const { accounts } = loadAccountsFromEnv();
		assert.deepEqual(accounts.map((a) => [a.id, a.name]), [['my_shop', 'My Shop']]);
	});
	for (const id of ['__proto__', 'constructor', 'request', 'accounts', '_hidden']) {
		withEnv({ LEXWARE_OFFICE_ACCOUNTS_JSON: JSON.stringify([{ id, apiKey: 'k1' }]) }, () => {
			assert.throws(() => loadAccountsFromEnv(), /Invalid Lexware account id/, id);
		});
		assert.throws(() => new LexwareClientRegistry([{ id, apiKey: 'k1' }]), /Invalid Lexware account id/, id);
	}
	withEnv({ LEXWARE_OFFICE_ACCOUNTS: 'a,b', LEXWARE_OFFICE_API_KEY_A: 'k1' }, () => {
		assert.throws(() => loadAccountsFromEnv(), /'b' is listed in LEXWARE_OFFICE_ACCOUNTS/);
	});
});

test('base URLs must use https and carry no credentials', () => {
	assert.throws(() => new LexwareClientRegistry([{ id: 'a', apiKey: 'k1', baseUrl: 'http://api.lexware.io' }]), /must use https/);
	assert.throws(() => new LexwareClientRegistry([{ id: 'a', apiKey: 'k1', baseUrl: 'https://user:pw@api.lexware.io' }]), /must not contain credentials/);
	assert.throws(() => new LexwareClientRegistry([{ id: 'a', apiKey: 'k1', baseUrl: 'not a url' }]), /Invalid Lexware API base URL/);
	assert.equal(new LexwareClientRegistry([{ id: 'a', apiKey: 'k1', baseUrl: 'https://api.lexware.io' }]).count, 1);
});

test('QuickJsExecutor: only explicit account selections reach the host; prototype ids never resolve', async () => {
	const executor = new QuickJsExecutor();
	const seen: Array<string | null> = [];
	const result = await executor.execute(
		`async () => {
			await lexware.request({ path: '/v1/a' });
			await lexware.request({ account: 'gewerbe', path: '/v1/b' });
			await lexware.freelance.request({ account: 'gewerbe', path: '/v1/c' });
			await lexware.account('gewerbe').json({ path: '/v1/d' });
			const errors = [];
			for (const id of ['constructor', '__proto__', 'toString', 'missing']) {
				try { lexware.account(id); errors.push(id + ':resolved'); } catch (e) { errors.push(id + ':' + /not found/.test(e.message)); }
			}
			return { errors, shorthand: typeof lexware.gewerbe.request, keys: Object.keys(lexware).filter(k => k === 'freelance' || k === 'gewerbe') };
		}`,
		{
			spec: { info: {} },
			accounts: [
				{ id: 'freelance', name: 'Freelance', writesEnabled: true },
				{ id: 'gewerbe', name: 'Gewerbe', writesEnabled: false },
			],
		},
		{
			filename: 'test-account-routing.js',
			hostFunctions: {
				__lexwareRequestJson: async (payloadStr) => {
					const payload = JSON.parse(payloadStr) as { account?: string };
					seen.push(payload.account ?? null);
					return JSON.stringify({ ok: true, status: 200, contentType: 'application/json', data: {} });
				},
			},
		},
	);

	assert.equal(result.error, undefined);
	assert.deepEqual(seen, [null, 'gewerbe', 'freelance', 'gewerbe']);
	assert.deepEqual(result.result, {
		errors: ['constructor:true', '__proto__:true', 'toString:true', 'missing:true'],
		shorthand: 'function',
		keys: ['freelance', 'gewerbe'],
	});
});
