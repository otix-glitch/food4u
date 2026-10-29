import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from './server.js';

const credentials = {
	PAYPAL_CLIENT_ID: 'test-client-id',
	PAYPAL_CLIENT_SECRET: 'test-client-secret',
	PAYPAL_ENV: 'sandbox',
	PAYPAL_CURRENCY: 'USD',
	PAYPAL_WEBHOOK_ID: 'test-webhook-id'
};
async function withApi(t, run, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'dripdistrict-api-'));
	const server = createServer({
		ordersFile: join(directory, 'orders.json'),
		authFile: join(directory, 'auth.json'),
		databaseFile: join(directory, 'accounts.sqlite'),
		...options
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(async () => {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	const address = server.address();
	await run(`http://127.0.0.1:${address.port}`, directory);
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

test('serves static storefront files and disables accounts in preview mode', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'dripdistrict-preview-'));
	const staticDirectory = join(directory, 'static');
	await mkdir(staticDirectory, { recursive: true });
	await writeFile(join(staticDirectory, 'index.html'), '<!doctype html><title>Preview</title>');
	const server = createServer({
		ordersFile: join(directory, 'orders.json'),
		authFile: join(directory, 'auth.json'),
		databaseFile: join(directory, 'accounts.sqlite'),
		staticDirectory,
		env: {
			APP_MODE: 'preview',
			PAYPAL_CLIENT_ID: 'preview-client-id',
			PAYPAL_CLIENT_SECRET: 'preview-client-secret'
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(async () => {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const page = await fetch(baseUrl);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<title>Preview<\/title>/);
	assert.deepEqual(await (await fetch(`${baseUrl}/api/config`)).json(), { accountsEnabled: false });
	assert.equal((await (await fetch(`${baseUrl}/api/paypal/config`)).json()).enabled, false);
	assert.equal((await fetch(`${baseUrl}/api/account/orders`)).status, 503);
	const signup = await fetch(`${baseUrl}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'preview@example.com', password: 'StrongPassword!123' })
	});
	assert.equal(signup.status, 503);
});

function makePayPalFetch() {
	const requests = [];
	const fetchImpl = async (url, options) => {
		requests.push({ url, ...options });
		if (url.endsWith('/v1/oauth2/token')) {
			return jsonResponse({ access_token: 'test-access-token', expires_in: 3600 });
		}
		if (url.endsWith('/v2/checkout/orders') && options.method === 'POST') {
			return jsonResponse({ id: 'PAYPAL-ORDER-1', status: 'CREATED' });
		}
		if (url.endsWith('/v2/checkout/orders/PAYPAL-ORDER-1/capture')) {
			const request = requests.find((entry) => entry.url.endsWith('/v2/checkout/orders') && entry.method === 'POST');
			const amount = JSON.parse(request.body).purchase_units[0].amount;
			return jsonResponse({
				id: 'PAYPAL-ORDER-1',
				status: 'COMPLETED',
				payer: { email_address: 'payer@example.com' },
				purchase_units: [{
					amount,
					shipping: {
						name: { full_name: 'Test Customer' },
						address: {
							address_line_1: '1 Example Street',
							admin_area_2: 'Lagos',
							country_code: 'NG'
						}
					},
					payments: {
						captures: [{
							id: 'PAYPAL-CAPTURE-1',
							status: 'COMPLETED',
							amount
						}]
					}
				}]
			});
		}
		if (url.endsWith('/v1/notifications/verify-webhook-signature')) {
			return jsonResponse({ verification_status: 'SUCCESS' });
		}
		throw new Error(`Unexpected mocked PayPal request: ${options.method} ${url}`);
	};
	return { fetchImpl, requests };
}

async function createPayPalOrder(baseUrl, items = [{ id: '1', size: 'M', quantity: 2, unitPrice: 0.01 }]) {
	return fetch(`${baseUrl}/api/paypal/orders`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			customer: { name: 'Test Customer', email: 'customer@example.com' },
			items
		})
	});
}

test('serves the complete catalog and supports category and search filters', async (t) => {
	await withApi(t, async (baseUrl) => {
		const response = await fetch(`${baseUrl}/api/products`);
		const catalog = await response.json();
		assert.equal(response.status, 200);
		assert.equal(catalog.length, 58);

		const categoryResponse = await fetch(`${baseUrl}/api/products?category=bottoms`);
		const bottoms = await categoryResponse.json();
		assert.equal(bottoms.length, 18);
		assert.ok(bottoms.every((product) => product.category === 'bottoms'));

		const searchResponse = await fetch(`${baseUrl}/api/products?search=heavy%20tee`);
		const matches = await searchResponse.json();
		assert.ok(matches.some((product) => product.name === 'District Heavy Tee'));
	});
});

test('keeps PayPal checkout disabled until server credentials are configured', async (t) => {
	await withApi(t, async (baseUrl) => {
		const configResponse = await fetch(`${baseUrl}/api/paypal/config`);
		const config = await configResponse.json();
		assert.equal(config.enabled, false);
		assert.equal(config.clientId, null);

		const orderResponse = await createPayPalOrder(baseUrl);
		assert.equal(orderResponse.status, 503);
		assert.match((await orderResponse.json()).error, /not configured/i);
	});
});

test('creates accounts with scrypt hashes and manages secure cookie sessions', async (t) => {
	const password = 'StrongPassword!123';
	await withApi(t, async (baseUrl, directory) => {
		const signup = await fetch(`${baseUrl}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example.com' },
			body: JSON.stringify({ email: ' Customer@Example.com ', password })
		});
		assert.equal(signup.status, 201);
		assert.match((await signup.json()).message, /created/i);

		const login = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example.com' },
			body: JSON.stringify({ email: 'customer@example.com', password })
		});
		assert.equal(login.status, 200);
		const { user } = await login.json();
		assert.equal(user.email, 'customer@example.com');
		assert.equal('passwordHash' in user, false);
		const cookie = login.headers.get('set-cookie');
		assert.match(cookie, /^dd_session=[^;]+/);
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /SameSite=Strict/);
		assert.match(cookie, /Max-Age=604800/);
		assert.match(cookie, /Secure/);
		const sessionCookie = cookie.split(';', 1)[0];

		const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: sessionCookie } });
		assert.equal(me.status, 200);
		assert.equal((await me.json()).user.id, user.id);

		const restartedServer = createServer({
			ordersFile: join(directory, 'restarted-orders.json'),
			authFile: join(directory, 'auth.json'),
			databaseFile: join(directory, 'accounts.sqlite'),
			env: {}
		});
		await new Promise((resolve, reject) => {
			restartedServer.once('error', reject);
			restartedServer.listen(0, '127.0.0.1', resolve);
		});
		try {
			const address = restartedServer.address();
			const resumed = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, {
				headers: { Cookie: sessionCookie }
			});
			assert.equal(resumed.status, 200);
			assert.equal((await resumed.json()).user.id, user.id);
		} finally {
			await new Promise((resolve, reject) => restartedServer.close((error) => error ? reject(error) : resolve()));
		}

		const stored = await readFile(join(directory, 'auth.json'), 'utf8');
		assert.equal(stored.includes(password), false);
		const records = JSON.parse(stored);
		const savedUser = records.find((record) => record.type === 'user');
		const savedSession = records.find((record) => record.type === 'session');
		assert.match(savedUser.passwordHash, /^[0-9a-f]{128}$/);
		assert.notEqual(savedUser.passwordSalt, '');
		assert.equal('tokenHash' in savedSession, true);
		assert.equal(stored.includes(sessionCookie.split('=')[1]), false);

		const logout = await fetch(`${baseUrl}/api/auth/logout`, {
			method: 'POST',
			headers: { Origin: 'https://shop.example.com', Cookie: sessionCookie }
		});
		assert.equal(logout.status, 200);
		assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
		const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: sessionCookie } });
		assert.equal(afterLogout.status, 401);
	}, { env: { NODE_ENV: 'production', APP_ORIGIN: 'https://shop.example.com' } });
});

test('rejects duplicate accounts and weak passwords, and does not reveal login account existence', async (t) => {
	await withApi(t, async (baseUrl) => {
		const signup = (email, password) => fetch(`${baseUrl}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
			body: JSON.stringify({ email, password })
		});
		assert.equal((await signup('customer@example.com', 'StrongPassword!123')).status, 201);
		assert.equal((await signup('customer@example.com', 'OtherStrongPass!2')).status, 409);
		assert.equal((await signup('new@example.com', 'short')).status, 400);

		const login = (email) => fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
			body: JSON.stringify({ email, password: 'WrongPassword!123' })
		});
		const known = await login('customer@example.com');
		const unknown = await login('unknown@example.com');
		assert.equal(known.status, 401);
		assert.equal(unknown.status, 401);
		assert.deepEqual(await known.json(), await unknown.json());
	}, { env: {} });
});

test('requires a trusted origin for account mutations and rate-limits login attempts', async (t) => {
	await withApi(t, async (baseUrl) => {
		const request = (origin) => fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
			body: JSON.stringify({ email: 'person@example.com', password: 'WrongPassword!123' })
		});
		assert.equal((await request('https://attacker.example')).status, 403);
		assert.equal((await request('null')).status, 403);
		assert.equal((await request(undefined)).status, 403);
		for (let attempt = 0; attempt < 10; attempt += 1) {
			assert.equal((await request('http://localhost:5173')).status, 401);
		}
		const limited = await request('http://localhost:5173');
		assert.equal(limited.status, 429);
		assert.ok(Number(limited.headers.get('retry-after')) > 0);
	}, { env: {} });
});

test('persists account data in SQLite and isolates it between accounts', async (t) => {
	await withApi(t, async (baseUrl) => {
		const origin = 'http://localhost:5173';
		const password = 'StrongPassword!123';
		const createAccount = async (email) => {
			const response = await fetch(`${baseUrl}/api/auth/signup`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: origin },
				body: JSON.stringify({ email, password })
			});
			assert.equal(response.status, 201);
		};
		const signIn = async (email) => {
			const response = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: origin },
				body: JSON.stringify({ email, password })
			});
			assert.equal(response.status, 200);
			return {
				user: (await response.json()).user,
				cookie: response.headers.get('set-cookie').split(';', 1)[0]
			};
		};
		await createAccount('first@example.com');
		await createAccount('second@example.com');
		const first = await signIn('first@example.com');
		const firstData = {
			userId: first.user.id,
			cart: [{ id: '1', size: 'M', quantity: 2 }],
			favorites: ['2', '3']
		};
		const saveResponse = await fetch(`${baseUrl}/api/account/data`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Origin: origin,
				Cookie: first.cookie
			},
			body: JSON.stringify(firstData)
		});
		assert.equal(saveResponse.status, 200);
		const savedData = await saveResponse.json();
		assert.deepEqual(savedData.cart, firstData.cart);

		const firstRead = await fetch(`${baseUrl}/api/account/data`, {
			headers: { Cookie: first.cookie }
		});
		assert.deepEqual(await firstRead.json(), {
			cart: firstData.cart,
			favorites: firstData.favorites,
			updatedAt: savedData.updatedAt
		});

		const second = await signIn('second@example.com');
		const secondRead = await fetch(`${baseUrl}/api/account/data`, {
			headers: { Cookie: second.cookie }
		});
		assert.deepEqual(await secondRead.json(), { cart: [], favorites: [], updatedAt: null });

		const crossAccountWrite = await fetch(`${baseUrl}/api/account/data`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Origin: origin,
				Cookie: second.cookie
			},
			body: JSON.stringify(firstData)
		});
		assert.equal(crossAccountWrite.status, 403);
		assert.deepEqual(await (await fetch(`${baseUrl}/api/account/data`, {
			headers: { Cookie: first.cookie }
		})).json(), {
			cart: firstData.cart,
			favorites: firstData.favorites,
			updatedAt: savedData.updatedAt
		});
	}, { env: {} });
});

test('creates and captures PayPal orders using catalog prices and persists shipping details', async (t) => {
	const paypal = makePayPalFetch();
	await withApi(t, async (baseUrl, directory) => {
		const configResponse = await fetch(`${baseUrl}/api/paypal/config`);
		const config = await configResponse.json();
		assert.equal(config.enabled, true);
		assert.equal(config.clientId, credentials.PAYPAL_CLIENT_ID);
		assert.equal(JSON.stringify(config).includes(credentials.PAYPAL_CLIENT_SECRET), false);

		const createResponse = await createPayPalOrder(baseUrl);
		const created = await createResponse.json();
		assert.equal(createResponse.status, 201);
		assert.equal(created.id, 'PAYPAL-ORDER-1');
		const remoteOrderRequest = paypal.requests.find((request) =>
			request.url.endsWith('/v2/checkout/orders') && request.method === 'POST');
		const remoteOrder = JSON.parse(remoteOrderRequest.body);
		assert.equal(remoteOrder.purchase_units[0].amount.value, '84.00');
		assert.equal(remoteOrder.purchase_units[0].items[0].unit_amount.value, '42.00');
		assert.equal(remoteOrder.application_context.shipping_preference, 'GET_FROM_FILE');
		assert.match(remoteOrderRequest.headers.Authorization, /^Bearer test-access-token$/);

		const captureResponse = await fetch(`${baseUrl}/api/paypal/orders/${created.id}/capture`, { method: 'POST' });
		const capture = await captureResponse.json();
		assert.equal(captureResponse.status, 200);
		assert.equal(capture.status, 'completed');
		assert.equal(capture.shippingAddressReceived, true);
		const duplicateCapture = await fetch(`${baseUrl}/api/paypal/orders/${created.id}/capture`, { method: 'POST' });
		assert.equal(duplicateCapture.status, 200);
		assert.equal((await duplicateCapture.json()).status, 'completed');
		assert.equal(paypal.requests.filter((request) =>
			request.url.endsWith('/v2/checkout/orders/PAYPAL-ORDER-1/capture')).length, 1);

		const storedOrders = JSON.parse(await readFile(join(directory, 'orders.json'), 'utf8'));
		assert.equal(storedOrders.length, 1);
		assert.equal(storedOrders[0].status, 'completed');
		assert.equal(storedOrders[0].total, 84);
		assert.equal(storedOrders[0].paypalCaptureId, 'PAYPAL-CAPTURE-1');
		assert.equal(storedOrders[0].customer.address, '1 Example Street, Lagos, NG');
		assert.equal(storedOrders[0].customer.email, 'payer@example.com');
	}, { env: credentials, fetchImpl: paypal.fetchImpl });
});

test('shows only the signed-in account its own order history', async (t) => {
	const paypal = makePayPalFetch();
	await withApi(t, async (baseUrl) => {
		const origin = 'http://localhost:5173';
		const password = 'StrongPassword!123';
		const createAndSignIn = async (email) => {
			const signup = await fetch(`${baseUrl}/api/auth/signup`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: origin },
				body: JSON.stringify({ email, password })
			});
			assert.equal(signup.status, 201);
			const login = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: origin },
				body: JSON.stringify({ email, password })
			});
			assert.equal(login.status, 200);
			return login.headers.get('set-cookie').split(';', 1)[0];
		};
		const firstCookie = await createAndSignIn('buyer@example.com');
		const orderResponse = await fetch(`${baseUrl}/api/paypal/orders`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: firstCookie },
			body: JSON.stringify({
				customer: { name: 'Buyer', email: 'buyer@example.com' },
				items: [{ id: '1', size: 'M', quantity: 1 }]
			})
		});
		assert.equal(orderResponse.status, 201);
		const captureResponse = await fetch(`${baseUrl}/api/paypal/orders/PAYPAL-ORDER-1/capture`, { method: 'POST' });
		assert.equal(captureResponse.status, 200);

		const ownOrders = await fetch(`${baseUrl}/api/account/orders`, {
			headers: { Cookie: firstCookie }
		});
		const { orders } = await ownOrders.json();
		assert.equal(orders.length, 1);
		assert.equal(orders[0].status, 'completed');
		assert.equal(orders[0].total, 42);
		assert.equal('paypalOrderId' in orders[0], false);

		const secondCookie = await createAndSignIn('other@example.com');
		const otherOrders = await fetch(`${baseUrl}/api/account/orders`, {
			headers: { Cookie: secondCookie }
		});
		assert.deepEqual((await otherOrders.json()).orders, []);
	}, { env: credentials, fetchImpl: paypal.fetchImpl });
});

test('rejects invalid cart items before contacting PayPal', async (t) => {
	const paypal = makePayPalFetch();
	await withApi(t, async (baseUrl) => {
		const response = await createPayPalOrder(baseUrl, [{ id: 'missing', size: 'M', quantity: 1 }]);
		assert.equal(response.status, 400);
		assert.match((await response.json()).error, /unknown product/i);
		assert.equal(paypal.requests.length, 0);
	}, { env: credentials, fetchImpl: paypal.fetchImpl });
});

test('verifies PayPal webhooks and applies refund notifications idempotently', async (t) => {
	const paypal = makePayPalFetch();
	await withApi(t, async (baseUrl, directory) => {
		const createResponse = await createPayPalOrder(baseUrl, [{ id: '1', size: 'M', quantity: 1 }]);
		assert.equal(createResponse.status, 201);
		const captureResponse = await fetch(`${baseUrl}/api/paypal/orders/PAYPAL-ORDER-1/capture`, { method: 'POST' });
		assert.equal(captureResponse.status, 200);

		const event = {
			id: 'REFUND-EVENT-1',
			event_type: 'PAYMENT.CAPTURE.REFUNDED',
			resource: {
				id: 'PAYPAL-CAPTURE-1',
				amount: { currency_code: 'USD', value: '10.00' },
				supplementary_data: { related_ids: { order_id: 'PAYPAL-ORDER-1' } }
			}
		};
		for (let index = 0; index < 2; index += 1) {
			const webhookResponse = await fetch(`${baseUrl}/api/paypal/webhook`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'paypal-auth-algo': 'test',
					'paypal-cert-url': 'https://api.paypal.com/cert',
					'paypal-transmission-id': 'test-transmission',
					'paypal-transmission-sig': 'test-signature',
					'paypal-transmission-time': '2026-01-01T00:00:00Z'
				},
				body: JSON.stringify(event)
			});
			assert.equal(webhookResponse.status, 200);
		}
		const storedOrders = JSON.parse(await readFile(join(directory, 'orders.json'), 'utf8'));
		assert.equal(storedOrders[0].status, 'partially_refunded');
		assert.equal(storedOrders[0].refunds.length, 1);
		assert.equal(storedOrders[0].refunds[0].amount, 10);
		const verificationRequest = paypal.requests.find((request) =>
			request.url.endsWith('/v1/notifications/verify-webhook-signature'));
		assert.equal(JSON.parse(verificationRequest.body).webhook_id, credentials.PAYPAL_WEBHOOK_ID);
	}, { env: credentials, fetchImpl: paypal.fetchImpl });
});

test('reports malformed JSON and unknown routes as client errors', async (t) => {
	const paypal = makePayPalFetch();
	await withApi(t, async (baseUrl) => {
		const malformedResponse = await fetch(`${baseUrl}/api/paypal/orders`, {
			method: 'POST',
			body: '{'
		});
		assert.equal(malformedResponse.status, 400);
		assert.match((await malformedResponse.json()).error, /valid JSON/);

		const missingResponse = await fetch(`${baseUrl}/api/missing`);
		assert.equal(missingResponse.status, 404);
	}, { env: credentials, fetchImpl: paypal.fetchImpl });
});
