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
