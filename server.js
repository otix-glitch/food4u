import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { importPKCS8, SignJWT } from 'jose';
import nodemailer from 'nodemailer';
import * as oidc from 'openid-client';
import { products } from './server/catalog.js';

const defaultOrdersFile = resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'orders.json');
const defaultAuthFile = resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'auth.json');
const defaultDatabaseFile = resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'accounts.sqlite');
const defaultStaticDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const validSizes = new Set(['XS', 'S', 'M', 'L', 'XL']);
const maxRequestBytes = 16 * 1024;
const maxQuantity = 99;
const sessionCookieName = 'dd_session';
const sessionLifetimeSeconds = 60 * 60 * 24 * 7;
const passwordResetLifetimeMilliseconds = 15 * 60 * 1000;
const minimumPasswordLength = 12;
const scrypt = promisify(scryptCallback);

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function sendJson(response, status, body) {
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(JSON.stringify(body));
}

async function readJson(request) {
	let body = '';
	for await (const chunk of request) {
		body += chunk;
		if (Buffer.byteLength(body) > maxRequestBytes) {
			throw new ApiError(413, 'Request body is too large.');
		}
	}

	try {
		return JSON.parse(body);
	} catch {
		throw new ApiError(400, 'Request body must be valid JSON.');
	}
}

async function serveStaticFile(request, response, staticDirectory, pathname) {
	if (!['GET', 'HEAD'].includes(request.method)) return false;
	let relativePath;
	try {
		relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
	} catch {
		response.writeHead(400).end();
		return true;
	}
	const filePath = resolve(staticDirectory, relativePath);
	if (!filePath.startsWith(`${staticDirectory}${sep}`)) {
		response.writeHead(404).end();
		return true;
	}
	let contents;
	try {
		contents = await readFile(filePath);
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
		throw error;
	}
	const contentType = new Map([
		['.css', 'text/css; charset=utf-8'],
		['.html', 'text/html; charset=utf-8'],
		['.ico', 'image/x-icon'],
		['.jpeg', 'image/jpeg'],
		['.jpg', 'image/jpeg'],
		['.js', 'text/javascript; charset=utf-8'],
		['.json', 'application/json; charset=utf-8'],
		['.png', 'image/png'],
		['.svg', 'image/svg+xml'],
		['.webp', 'image/webp'],
		['.woff2', 'font/woff2']
	]).get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
	response.writeHead(200, {
		'Content-Type': contentType,
		'Cache-Control': 'no-cache',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(request.method === 'HEAD' ? undefined : contents);
	return true;
}

function validateAccountData(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ApiError(400, 'Account data is required.');
	}
	if (!Array.isArray(payload.cart) || payload.cart.length > products.length * validSizes.size) {
		throw new ApiError(400, 'Cart data must be an array with a valid number of items.');
	}
	if (!Array.isArray(payload.favorites) || payload.favorites.length > products.length) {
		throw new ApiError(400, 'Saved products must be an array with a valid number of items.');
	}

	const cartItems = new Map();
	for (const item of payload.cart) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new ApiError(400, 'Each cart item must include a product, size, and quantity.');
		}
		const product = products.find((entry) => entry.id === String(item.id));
		if (!product) throw new ApiError(400, 'The cart contains an unknown product.');
		if (!validSizes.has(item.size)) throw new ApiError(400, 'The cart contains an invalid size.');
		if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > maxQuantity) {
			throw new ApiError(400, `Item quantity must be between 1 and ${maxQuantity}.`);
		}
		const key = `${product.id}:${item.size}`;
		if (cartItems.has(key)) throw new ApiError(400, 'The cart contains duplicate items.');
		cartItems.set(key, { id: product.id, size: item.size, quantity: item.quantity });
	}

	const favorites = new Set();
	for (const productId of payload.favorites) {
		const id = String(productId);
		if (!products.some((product) => product.id === id)) {
			throw new ApiError(400, 'Saved products contain an unknown product.');
		}
		favorites.add(id);
	}
	if (favorites.size !== payload.favorites.length) {
		throw new ApiError(400, 'Saved products cannot contain duplicates.');
	}

	return { cart: [...cartItems.values()], favorites: [...favorites] };
}

function validateOrder(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ApiError(400, 'Order details are required.');
	}
	const customer = payload.customer;
	if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
		throw new ApiError(400, 'Customer details are required.');
	}

	const name = typeof customer.name === 'string' ? customer.name.trim() : '';
	const email = typeof customer.email === 'string' ? customer.email.trim() : '';
	if (!name || name.length > 120) throw new ApiError(400, 'Name is required and must be at most 120 characters.');
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new ApiError(400, 'A valid email address is required.');
	}
	if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > 100) {
		throw new ApiError(400, 'An order must contain between 1 and 100 items.');
	}

	const normalizedItems = new Map();
	for (const item of payload.items) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new ApiError(400, 'Each order item must include a product, size, and quantity.');
		}
		const product = products.find((entry) => entry.id === String(item.id));
		if (!product) throw new ApiError(400, 'An order contains an unknown product.');
		if (!validSizes.has(item.size)) throw new ApiError(400, 'An order contains an invalid size.');
		if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > maxQuantity) {
			throw new ApiError(400, `Item quantity must be between 1 and ${maxQuantity}.`);
		}

		const key = `${product.id}:${item.size}`;
		const previous = normalizedItems.get(key);
		const quantity = (previous?.quantity ?? 0) + item.quantity;
		if (quantity > maxQuantity) throw new ApiError(400, `Combined item quantity cannot exceed ${maxQuantity}.`);
		normalizedItems.set(key, {
			productId: product.id,
			name: product.name,
			size: item.size,
			quantity,
			unitPrice: product.price
		});
	}

	const items = [...normalizedItems.values()];
	const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
	return {
		customer: { name, email },
		items,
		total
	};
}

function formatAddress(address) {
	if (!address) return '';
	return [
		address.address_line_1,
		address.address_line_2,
		address.admin_area_2,
		address.admin_area_1,
		address.postal_code,
		address.country_code
	].filter((part) => typeof part === 'string' && part.trim()).join(', ');
}

function getCapture(orderDetails, orderId) {
	if (orderDetails?.id !== orderId || orderDetails.status !== 'COMPLETED') return null;
	const purchaseUnit = orderDetails.purchase_units?.[0];
	const capture = purchaseUnit?.payments?.captures?.find((item) => item.status === 'COMPLETED');
	if (!capture || capture.amount?.currency_code !== purchaseUnit.amount?.currency_code) return null;
	return { orderDetails, purchaseUnit, capture };
}

async function loadJsonArray(filePath, description) {
	try {
		const contents = await readFile(filePath, 'utf8');
		const records = JSON.parse(contents);
		if (!Array.isArray(records)) throw new Error(`${description} store must contain a JSON array.`);
		return records;
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}

async function persistJsonArray(filePath, records) {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryFile, JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 });
		await rename(temporaryFile, filePath);
	} catch (error) {
		await rm(temporaryFile, { force: true });
		throw error;
	}
}

function getCookie(request, name) {
	for (const part of (request.headers.cookie ?? '').split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return '';
}

export function createServer({ ordersFile = defaultOrdersFile, authFile = defaultAuthFile, databaseFile = defaultDatabaseFile, staticDirectory = defaultStaticDirectory, env = process.env, fetchImpl = globalThis.fetch, deliverPasswordResetEmail, oauthClient = oidc } = {}) {
	mkdirSync(dirname(databaseFile), { recursive: true });
	const databaseFileDescriptor = openSync(databaseFile, 'a', 0o600);
	closeSync(databaseFileDescriptor);
	const accountDatabase = new Database(databaseFile);
	accountDatabase.pragma('journal_mode = WAL');
	accountDatabase.pragma('synchronous = FULL');
	accountDatabase.exec(`
		CREATE TABLE IF NOT EXISTS account_data (
			user_id TEXT PRIMARY KEY,
			cart_json TEXT NOT NULL DEFAULT '[]',
			favorites_json TEXT NOT NULL DEFAULT '[]',
			updated_at TEXT
		)
	`);
	chmodSync(databaseFile, 0o600);
	const getAccountDataStatement = accountDatabase.prepare(
		'SELECT cart_json, favorites_json, updated_at FROM account_data WHERE user_id = ?'
	);
	const createAccountDataStatement = accountDatabase.prepare(
		'INSERT OR IGNORE INTO account_data (user_id) VALUES (?)'
	);
	const saveAccountDataStatement = accountDatabase.prepare(`
		INSERT INTO account_data (user_id, cart_json, favorites_json, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			cart_json = excluded.cart_json,
			favorites_json = excluded.favorites_json,
			updated_at = excluded.updated_at
	`);
	const ensureAccountData = (userId) => createAccountDataStatement.run(userId);
	const loadAccountData = (userId) => {
		ensureAccountData(userId);
		const data = getAccountDataStatement.get(userId);
		return {
			cart: JSON.parse(data.cart_json),
			favorites: JSON.parse(data.favorites_json),
			updatedAt: data.updated_at
		};
	};
	const paypalClientId = env.PAYPAL_CLIENT_ID?.trim() ?? '';
	const paypalClientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? '';
	const paypalEnvironment = env.PAYPAL_ENV?.trim() || 'sandbox';
	const paypalCurrency = env.PAYPAL_CURRENCY?.trim().toUpperCase() || 'USD';
	const paypalWebhookId = env.PAYPAL_WEBHOOK_ID?.trim() ?? '';
	if (!['sandbox', 'live'].includes(paypalEnvironment)) {
		throw new Error('PAYPAL_ENV must be either sandbox or live.');
	}
	if (!/^[A-Z]{3}$/.test(paypalCurrency)) {
		throw new Error('PAYPAL_CURRENCY must be a three-letter currency code.');
	}
	const paypalApiUrl = paypalEnvironment === 'live'
		? 'https://api-m.paypal.com'
		: 'https://api-m.sandbox.paypal.com';
	const paypalEnabled = env.APP_MODE !== 'preview' && Boolean(paypalClientId && paypalClientSecret);
	const smtpHost = env.SMTP_HOST?.trim() ?? '';
	const smtpFrom = env.SMTP_FROM?.trim() ?? '';
	const smtpUser = env.SMTP_USER?.trim() ?? '';
	const smtpPassword = env.SMTP_PASSWORD ?? '';
	const smtpPort = Number(env.SMTP_PORT || 587);
	const smtpSecure = env.SMTP_SECURE === 'true' || smtpPort === 465;
	const smtpConfigured = Boolean(smtpHost && smtpFrom && ((smtpUser && smtpPassword) || (!smtpUser && !smtpPassword)));
	if ((smtpHost || smtpFrom || smtpUser || smtpPassword) && !smtpConfigured) {
		throw new Error('Configure SMTP_HOST and SMTP_FROM, and set both SMTP_USER and SMTP_PASSWORD or neither.');
	}
	if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
		throw new Error('SMTP_PORT must be an integer between 1 and 65535.');
	}
	const smtpTransport = smtpConfigured
		? nodemailer.createTransport({
			host: smtpHost,
			port: smtpPort,
			secure: smtpSecure,
			...(smtpUser ? {
				auth: {
					user: smtpUser,
					pass: smtpHost === 'smtp.gmail.com' ? smtpPassword.replace(/\s/g, '') : smtpPassword
				}
			} : {})
		})
		: null;
	const passwordResetEnabled = env.APP_MODE !== 'preview' && Boolean(deliverPasswordResetEmail || smtpTransport);
	const cookieSecure = env.NODE_ENV === 'production' || env.AUTH_COOKIE_SECURE === 'true';
	let allowedAppOrigin = '';
	const appOrigin = env.APP_ORIGIN?.trim() || env.RENDER_EXTERNAL_URL?.trim() || '';
	if (appOrigin) {
		const configuredOrigin = new URL(appOrigin);
		const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(configuredOrigin.hostname);
		if (configuredOrigin.origin !== appOrigin || (configuredOrigin.protocol !== 'https:' && !(configuredOrigin.protocol === 'http:' && isLocalHost))) {
			throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP is allowed for local development).');
		}
		allowedAppOrigin = configuredOrigin.origin;
	}
	if (env.NODE_ENV === 'production' && !allowedAppOrigin) {
		throw new Error('APP_ORIGIN must be configured with the production HTTPS website origin.');
	}
	const authAppOrigin = allowedAppOrigin || (env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:5173');
	const googleClientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
	const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
	const appleClientId = env.APPLE_CLIENT_ID?.trim() ?? '';
	const appleTeamId = env.APPLE_TEAM_ID?.trim() ?? '';
	const appleKeyId = env.APPLE_KEY_ID?.trim() ?? '';
	const applePrivateKey = env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
	if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
		throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in.');
	}
	const appleSettings = [appleClientId, appleTeamId, appleKeyId, applePrivateKey];
	if (appleSettings.some(Boolean) && !appleSettings.every(Boolean)) {
		throw new Error('Set APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY to enable Apple sign-in.');
	}
	const socialProviders = {
		google: env.APP_MODE !== 'preview' && Boolean(authAppOrigin && googleClientId && googleClientSecret),
		apple: env.APP_MODE !== 'preview' && Boolean(authAppOrigin && appleClientId && appleTeamId && appleKeyId && applePrivateKey)
	};
	const authRateLimits = new Map();
	const oauthTransactions = new Map();
	let writeQueue = Promise.resolve();
	let accessToken = '';
	let accessTokenExpiresAt = 0;
	let accessTokenRequest = null;

	async function mutateJsonArray(filePath, update, description) {
		const previousWrite = writeQueue;
		let releaseWrite;
		writeQueue = new Promise((resolveWrite) => { releaseWrite = resolveWrite; });
		await previousWrite;
		try {
			const records = await loadJsonArray(filePath, description);
			const result = await update(records);
			if (result?.changed) await persistJsonArray(filePath, records);
			return result?.value;
		} finally {
			releaseWrite();
		}
	}

	async function mutateOrders(update) {
		return mutateJsonArray(ordersFile, update, 'Order');
	}

	async function mutateUsers(update) {
		return mutateJsonArray(authFile, update, 'Account');
	}

	function validateSameOrigin(request) {
		const originHeader = request.headers.origin;
		if (!originHeader) throw new ApiError(403, 'The request origin could not be verified.');
		let origin;
		try {
			const parsedOrigin = new URL(originHeader);
			origin = parsedOrigin.origin;
			if (!['http:', 'https:'].includes(parsedOrigin.protocol) || origin !== originHeader) {
				throw new Error('Invalid origin.');
			}
		} catch {
			throw new ApiError(403, 'The request origin could not be verified.');
		}
		if (allowedAppOrigin) {
			if (origin !== allowedAppOrigin) throw new ApiError(403, 'The request origin is not allowed.');
			return;
		}
		if (env.NODE_ENV === 'production') throw new ApiError(403, 'The request origin is not configured.');
		const hostname = new URL(origin).hostname;
		if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
			throw new ApiError(403, 'The request origin is not allowed.');
		}
	}

	function enforceAuthRateLimit(request, response) {
		const now = Date.now();
		const key = request.socket.remoteAddress ?? 'unknown';
		let state = authRateLimits.get(key);
		if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + 15 * 60 * 1000 };
		state.count += 1;
		authRateLimits.set(key, state);
		if (authRateLimits.size > 10000) {
			for (const [ip, entry] of authRateLimits) {
				if (entry.resetAt <= now || authRateLimits.size > 10000) authRateLimits.delete(ip);
			}
		}
		if (state.count > 10) {
			response.setHeader('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
			throw new ApiError(429, 'Too many sign-in attempts. Please wait and try again.');
		}
	}

	async function getOAuthConfiguration(provider) {
		const isGoogle = provider === 'google';
		const clientId = isGoogle ? googleClientId : appleClientId;
		let clientSecret = isGoogle ? googleClientSecret : '';
		if (!isGoogle) {
			const now = Math.floor(Date.now() / 1000);
			const privateKey = await importPKCS8(applePrivateKey, 'ES256');
			clientSecret = await new SignJWT({})
				.setProtectedHeader({ alg: 'ES256', kid: appleKeyId })
				.setIssuer(appleTeamId)
				.setSubject(appleClientId)
				.setAudience('https://appleid.apple.com')
				.setIssuedAt(now)
				.setExpirationTime(now + 5 * 60)
				.sign(privateKey);
		}
		const issuer = isGoogle ? 'https://accounts.google.com' : 'https://appleid.apple.com';
		return oauthClient.discovery(
			new URL(issuer),
			clientId,
			{ client_secret: clientSecret },
			oauthClient.ClientSecretPost(clientSecret)
		);
	}

	function redirectToStore(response, parameters = {}) {
		const destination = new URL('/', authAppOrigin);
		for (const [key, value] of Object.entries(parameters)) destination.searchParams.set(key, value);
		response.writeHead(303, {
			Location: destination.toString(),
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer'
		});
		response.end();
	}

	function clearOAuthStateCookie(response, provider) {
		const cookies = response.getHeader('Set-Cookie');
		const cookieList = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
		const parts = [
			`dd_oauth_${provider}=`,
			'Path=/api/auth',
			'HttpOnly',
			'SameSite=Lax',
			'Max-Age=0'
		];
		if (cookieSecure) parts.push('Secure');
		response.setHeader('Set-Cookie', [...cookieList, parts.join('; ')]);
	}

	async function findOrCreateOAuthUser(provider, claims) {
		const subject = typeof claims.sub === 'string' ? claims.sub : '';
		const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
		const verified = claims.email_verified === true || claims.email_verified === 'true';
		if (!subject || !verified || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new ApiError(403, 'The identity provider did not return a verified email address.');
		}
		return mutateUsers(async (records) => {
			const linked = records.find((record) => record.type === 'user'
				&& record.providerIdentities?.some((identity) =>
					identity.provider === provider && identity.subject === subject));
			if (linked) return { value: linked };

			const user = records.find((record) => record.type === 'user' && record.email === email);
			const identity = { provider, subject };
			if (user) {
				user.providerIdentities = [...(user.providerIdentities ?? []), identity];
				user.emailVerified = true;
				return { changed: true, value: user };
			}

			const created = {
				id: randomUUID(),
				type: 'user',
				email,
				emailVerified: true,
				providerIdentities: [identity],
				createdAt: new Date().toISOString()
			};
			records.push(created);
			ensureAccountData(created.id);
			return { changed: true, value: created };
		});
	}

	async function issueSession(user, response) {
		const now = Date.now();
		const secret = randomBytes(32).toString('base64url');
		const salt = randomBytes(16).toString('hex');
		const session = {
			id: randomUUID(),
			type: 'session',
			userId: user.id,
			tokenHash: (await scrypt(secret, Buffer.from(salt, 'hex'), 32)).toString('hex'),
			salt,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + sessionLifetimeSeconds * 1000).toISOString()
		};
		await mutateUsers(async (records) => {
			for (let index = records.length - 1; index >= 0; index -= 1) {
				if (records[index].type === 'session'
					&& (records[index].expiresAt <= new Date(now).toISOString() || records[index].userId === user.id)) {
					records.splice(index, 1);
				}
			}
			records.push(session);
			return { changed: true };
		});
		const token = `${session.id}.${secret}`;
		const cookieParts = [
			`${sessionCookieName}=${token}`,
			'Path=/',
			'HttpOnly',
			'SameSite=Strict',
			`Max-Age=${sessionLifetimeSeconds}`
		];
		if (cookieSecure) cookieParts.push('Secure');
		response.setHeader('Set-Cookie', cookieParts.join('; '));
	}

	async function getAuthenticatedUser(request) {
		const token = getCookie(request, sessionCookieName);
		const tokenMatch = token.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,60})$/);
		if (!tokenMatch) throw new ApiError(401, 'Sign in to continue.');
		const [, sessionId, secret] = tokenMatch;
		const session = await mutateUsers(async (records) => {
			const now = new Date().toISOString();
			let changed = false;
			for (let index = records.length - 1; index >= 0; index -= 1) {
				if (records[index].type === 'session' && records[index].expiresAt <= now) {
					records.splice(index, 1);
					changed = true;
				}
			}
			const activeSession = records.find((record) =>
				record.type === 'session' && record.id === sessionId && record.expiresAt > now);
			return {
				changed,
				value: activeSession ?? null
			};
		});
		if (!session) throw new ApiError(401, 'Your sign-in has expired. Please sign in again.');
		const tokenHash = Buffer.from(await scrypt(secret, Buffer.from(session.salt, 'hex'), 32));
		const savedHash = Buffer.from(session.tokenHash, 'hex');
		if (savedHash.length !== tokenHash.length || !timingSafeEqual(savedHash, tokenHash)) {
			throw new ApiError(401, 'Your sign-in has expired. Please sign in again.');
		}
		const user = await mutateUsers(async (records) => ({
			value: records.find((record) => record.type === 'user' && record.id === session.userId) ?? null
		}));
		if (!user) throw new ApiError(401, 'Your sign-in has expired. Please sign in again.');
		return { user, session };
	}

	function publicUser(user) {
		return { id: user.id, email: user.email, createdAt: user.createdAt };
	}

	async function getAccessToken() {
		if (!paypalEnabled) throw new ApiError(503, 'PayPal is not configured on the server.');
		if (accessToken && accessTokenExpiresAt > Date.now() + 30000) return accessToken;
		if (accessTokenRequest) return accessTokenRequest;

		accessTokenRequest = (async () => {
			let response;
			try {
				response = await fetchImpl(`${paypalApiUrl}/v1/oauth2/token`, {
					method: 'POST',
					signal: AbortSignal.timeout(15000),
					headers: {
						Authorization: `Basic ${Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString('base64')}`,
						'Content-Type': 'application/x-www-form-urlencoded'
					},
					body: 'grant_type=client_credentials'
				});
			} catch (error) {
				console.error('Could not connect to PayPal while requesting an access token:', error);
				throw new ApiError(502, 'Could not connect to PayPal. Please try again.');
			}
			if (!response.ok) {
				console.error(`PayPal access-token request failed with status ${response.status}.`);
				throw new ApiError(502, 'PayPal authentication failed. Check the server credentials.');
			}
			const result = await response.json();
			if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) {
				throw new ApiError(502, 'PayPal returned an invalid authentication response.');
			}
			accessToken = result.access_token;
			accessTokenExpiresAt = Date.now() + result.expires_in * 1000;
			return accessToken;
		})();
		try {
			return await accessTokenRequest;
		} finally {
			accessTokenRequest = null;
		}
	}

	async function paypalRequest(path, { method = 'GET', body, requestId } = {}) {
		const token = await getAccessToken();
		let response;
		try {
			response = await fetchImpl(`${paypalApiUrl}${path}`, {
				method,
				signal: AbortSignal.timeout(15000),
				headers: {
					Authorization: `Bearer ${token}`,
					...(body ? { 'Content-Type': 'application/json' } : {}),
					...(requestId ? { 'PayPal-Request-Id': requestId } : {})
				},
				...(body ? { body: JSON.stringify(body) } : {})
			});
		} catch (error) {
			console.error('Could not connect to PayPal API:', error);
			throw new ApiError(502, 'Could not connect to PayPal. Please try again.');
		}
		if (!response.ok) {
			console.error(`PayPal API request ${method} ${path} failed with status ${response.status}.`);
			throw new ApiError(502, 'PayPal could not complete the payment request.');
		}
		return response.json();
	}

	async function capturePayPalOrder(order) {
		let captured;
		try {
			captured = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId)}/capture`, {
				method: 'POST',
				body: {},
				requestId: order.id
			});
		} catch (error) {
			if (!(error instanceof ApiError) || error.status !== 502) throw error;
			captured = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId)}`);
		}
		const result = getCapture(captured, order.paypalOrderId);
		if (!result) {
			throw new ApiError(409, 'PayPal has not confirmed this payment. Please check your PayPal account before trying again.');
		}
		if (result.capture.amount.value !== order.total.toFixed(2)
			|| result.capture.amount.currency_code !== order.currency) {
			console.error(`PayPal capture amount did not match order ${order.id}.`);
			throw new ApiError(409, 'The confirmed payment amount did not match this order. Please contact the shop.');
		}
		return result;
	}

	async function verifyWebhook(headers, event) {
		if (!paypalWebhookId) throw new ApiError(503, 'PayPal webhook verification is not configured.');
		const verification = await paypalRequest('/v1/notifications/verify-webhook-signature', {
			method: 'POST',
			body: {
				auth_algo: headers['paypal-auth-algo'],
				cert_url: headers['paypal-cert-url'],
				transmission_id: headers['paypal-transmission-id'],
				transmission_sig: headers['paypal-transmission-sig'],
				transmission_time: headers['paypal-transmission-time'],
				webhook_id: paypalWebhookId,
				webhook_event: event
			}
		});
		if (verification.verification_status !== 'SUCCESS') {
			throw new ApiError(400, 'PayPal webhook signature verification failed.');
		}
	}

	const server = createHttpServer(async (request, response) => {
		try {
			const url = new URL(request.url, 'http://localhost');
			if (request.method === 'GET' && url.pathname === '/api/health') {
				sendJson(response, 200, { status: 'ok' });
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/config') {
				sendJson(response, 200, {
					accountsEnabled: env.APP_MODE !== 'preview',
					passwordResetEnabled,
					socialProviders
				});
				return;
			}
			if (env.APP_MODE === 'preview' && (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/account/'))) {
				throw new ApiError(503, 'Accounts are disabled for this public preview.');
			}
			const oauthStartMatch = url.pathname.match(/^\/api\/auth\/(google|apple)\/start$/);
			if (request.method === 'GET' && oauthStartMatch) {
				const provider = oauthStartMatch[1];
				if (!socialProviders[provider]) throw new ApiError(503, `${provider} sign-in is not configured.`);
				enforceAuthRateLimit(request, response);
				const state = oauthClient.randomState();
				const nonce = oauthClient.randomNonce();
				const codeVerifier = oauthClient.randomPKCECodeVerifier();
				const codeChallenge = await oauthClient.calculatePKCECodeChallenge(codeVerifier);
				const now = Date.now();
				for (const [savedState, transaction] of oauthTransactions) {
					if (transaction.createdAt < now - 10 * 60 * 1000) oauthTransactions.delete(savedState);
				}
				oauthTransactions.set(state, { provider, nonce, codeVerifier, createdAt: now });
				let authorizationUrl;
				try {
					const configuration = await getOAuthConfiguration(provider);
					const redirectUri = new URL(`/api/auth/${provider}/callback`, authAppOrigin).toString();
					authorizationUrl = oauthClient.buildAuthorizationUrl(configuration, {
						redirect_uri: redirectUri,
						response_type: 'code',
						response_mode: 'query',
						scope: 'openid email',
						state,
						nonce,
						code_challenge: codeChallenge,
						code_challenge_method: 'S256',
						prompt: 'select_account'
					});
				} catch (error) {
					oauthTransactions.delete(state);
					console.error('Could not initialize OAuth sign-in:', { provider, code: error.code });
					redirectToStore(response, { authError: 'oauth_failed' });
					return;
				}
				const cookieParts = [
					`dd_oauth_${provider}=${state}`,
					'Path=/api/auth',
					'HttpOnly',
					'SameSite=Lax',
					'Max-Age=600'
				];
				if (cookieSecure) cookieParts.push('Secure');
				response.writeHead(302, {
					Location: authorizationUrl.toString(),
					'Set-Cookie': cookieParts.join('; '),
					'Cache-Control': 'no-store',
					'Referrer-Policy': 'no-referrer'
				});
				response.end();
				return;
			}
			const oauthCallbackMatch = url.pathname.match(/^\/api\/auth\/(google|apple)\/callback$/);
			if (request.method === 'GET' && oauthCallbackMatch) {
				const provider = oauthCallbackMatch[1];
				const state = url.searchParams.get('state') ?? '';
				const cookieState = getCookie(request, `dd_oauth_${provider}`);
				const transaction = oauthTransactions.get(state);
				const statesMatch = state.length === cookieState.length
					&& state.length > 0
					&& timingSafeEqual(Buffer.from(state), Buffer.from(cookieState));
				if (!statesMatch || !transaction || transaction.provider !== provider) {
					clearOAuthStateCookie(response, provider);
					redirectToStore(response, { authError: 'oauth_failed' });
					return;
				}
				oauthTransactions.delete(state);
				if (url.searchParams.has('error')) {
					clearOAuthStateCookie(response, provider);
					redirectToStore(response, { authError: 'oauth_cancelled' });
					return;
				}
				try {
					const configuration = await getOAuthConfiguration(provider);
					const redirectUri = new URL(`/api/auth/${provider}/callback`, authAppOrigin).toString();
					const tokens = await oauthClient.authorizationCodeGrant(
						configuration,
						new URL(request.url, authAppOrigin),
						{
							expectedState: state,
							expectedNonce: transaction.nonce,
							pkceCodeVerifier: transaction.codeVerifier,
							idTokenExpected: true
						},
						{ redirect_uri: redirectUri }
					);
					const claims = tokens.claims();
					const user = await findOrCreateOAuthUser(provider, claims);
					await issueSession(user, response);
					clearOAuthStateCookie(response, provider);
					redirectToStore(response, { auth: provider });
				} catch (error) {
					console.error('OAuth sign-in failed:', { provider, code: error.code, status: error.status });
					clearOAuthStateCookie(response, provider);
					redirectToStore(response, {
						authError: error instanceof ApiError && error.status === 403
							? 'unverified_email'
							: 'oauth_failed'
					});
				}
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/auth/me') {
				const { user } = await getAuthenticatedUser(request);
				sendJson(response, 200, { user: publicUser(user) });
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/password-reset/request') {
				validateSameOrigin(request);
				enforceAuthRateLimit(request, response);
				if (!passwordResetEnabled) throw new ApiError(503, 'Password reset email is not configured. Please contact the shop.');
				const payload = await readJson(request);
				if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
					throw new ApiError(400, 'A valid email address is required.');
				}
				const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
				if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
					throw new ApiError(400, 'Enter a valid email address.');
				}

				const now = Date.now();
				const user = await mutateUsers(async (records) => ({
					value: records.find((record) => record.type === 'user' && record.email === email) ?? null
				}));
				if (user) {
					const token = randomBytes(32).toString('base64url');
					const tokenHash = createHash('sha256').update(token).digest('hex');
					const expiresAt = new Date(now + passwordResetLifetimeMilliseconds).toISOString();
					const resetRecord = {
						id: randomUUID(),
						type: 'password_reset',
						userId: user.id,
						tokenHash,
						createdAt: new Date(now).toISOString(),
						expiresAt
					};
					await mutateUsers(async (records) => {
						for (let index = records.length - 1; index >= 0; index -= 1) {
							const record = records[index];
							if (record.type === 'password_reset'
								&& (record.userId === user.id || record.expiresAt <= new Date(now).toISOString())) {
								records.splice(index, 1);
							}
						}
						records.push(resetRecord);
						return { changed: true };
					});
					const origin = allowedAppOrigin || new URL(request.headers.origin).origin;
					const resetUrl = new URL('/', origin);
					resetUrl.hash = new URLSearchParams({ resetToken: token }).toString();
					sendJson(response, 200, {
						message: 'If that email belongs to an account, you may receive a password reset link shortly.'
					});
					setImmediate(() => {
						void (async () => {
							try {
								if (deliverPasswordResetEmail) {
									await deliverPasswordResetEmail({
										to: user.email,
										resetUrl: resetUrl.toString(),
										expiresAt
									});
								} else {
									await smtpTransport.sendMail({
										from: smtpFrom,
										to: user.email,
										subject: 'Reset your Drip District password',
										text: `Use this link to reset your Drip District password. It expires in 15 minutes and can only be used once:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`
									});
								}
							} catch (error) {
								try {
									await mutateUsers(async (records) => {
										const index = records.findIndex((record) =>
											record.type === 'password_reset' && record.id === resetRecord.id);
										if (index < 0) return { value: null };
										records.splice(index, 1);
										return { changed: true };
									});
								} catch (error) {
									console.error('Could not revoke an undelivered password reset token:', error);
								}
								console.error('Could not deliver a password reset email:', {
									code: error.code,
									command: error.command,
									responseCode: error.responseCode
								});
							}
						})();
					});
					return;
				}
				sendJson(response, 200, {
					message: 'If that email belongs to an account, you may receive a password reset link shortly.'
				});
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/password-reset/complete') {
				validateSameOrigin(request);
				enforceAuthRateLimit(request, response);
				const payload = await readJson(request);
				if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
					throw new ApiError(400, 'A reset token and new password are required.');
				}
				const token = typeof payload.token === 'string' ? payload.token : '';
				const password = typeof payload.password === 'string' ? payload.password : '';
				if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
					throw new ApiError(400, 'This password reset link is invalid or has expired.');
				}
				if (password.length < minimumPasswordLength || password.length > 128
					|| Buffer.byteLength(password, 'utf8') > 512) {
					throw new ApiError(400, `Password must be between ${minimumPasswordLength} and 128 characters.`);
				}
				const tokenHash = createHash('sha256').update(token).digest('hex');
				const now = new Date().toISOString();
				const updated = await mutateUsers(async (records) => {
					const reset = records.find((record) =>
						record.type === 'password_reset'
						&& record.tokenHash === tokenHash
						&& record.expiresAt > now);
					if (!reset) return { value: false };
					const user = records.find((record) => record.type === 'user' && record.id === reset.userId);
					if (!user) return { value: false };
					const salt = randomBytes(16);
					user.passwordSalt = salt.toString('hex');
					user.passwordHash = (await scrypt(password, salt, 64)).toString('hex');
					for (let index = records.length - 1; index >= 0; index -= 1) {
						const record = records[index];
						if (record.type === 'session' && record.userId === user.id) records.splice(index, 1);
						if (record.type === 'password_reset' && record.userId === user.id) records.splice(index, 1);
					}
					return { changed: true, value: true };
				});
				if (!updated) throw new ApiError(400, 'This password reset link is invalid or has expired.');
				sendJson(response, 200, { message: 'Your password has been reset. Please sign in with your new password.' });
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/signup') {
				validateSameOrigin(request);
				enforceAuthRateLimit(request, response);
				const payload = await readJson(request);
				if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
					throw new ApiError(400, 'Email and password are required.');
				}
				const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
				const password = typeof payload.password === 'string' ? payload.password : '';
				if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
					throw new ApiError(400, 'Enter a valid email address.');
				}
				if (password.length < minimumPasswordLength || password.length > 128
					|| Buffer.byteLength(password, 'utf8') > 512) {
					throw new ApiError(400, `Password must be between ${minimumPasswordLength} and 128 characters.`);
				}
				const salt = randomBytes(16);
				const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
				const created = await mutateUsers(async (records) => {
					if (records.some((record) => record.type === 'user' && record.email === email)) {
						return { value: false };
					}
					const userId = randomUUID();
					records.push({
						id: userId,
						type: 'user',
						email,
						passwordSalt: salt.toString('hex'),
						passwordHash,
						createdAt: new Date().toISOString()
					});
					ensureAccountData(userId);
					return { changed: true, value: true };
				});
				if (!created) throw new ApiError(409, 'An account with this email already exists.');
				sendJson(response, 201, { message: 'Account created. You can sign in now.' });
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/login') {
				validateSameOrigin(request);
				enforceAuthRateLimit(request, response);
				const payload = await readJson(request);
				if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
					throw new ApiError(400, 'Email and password are required.');
				}
				const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
				const password = typeof payload.password === 'string' ? payload.password : '';
				if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
					|| password.length < 1 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 512) {
					throw new ApiError(401, 'Email or password is incorrect.');
				}
				const user = await mutateUsers(async (records) => ({
					value: records.find((record) => record.type === 'user' && record.email === email) ?? null
				}));
				const hasPassword = Boolean(user?.passwordSalt && user.passwordHash);
				const salt = hasPassword ? Buffer.from(user.passwordSalt, 'hex') : Buffer.alloc(16);
				const expectedHash = hasPassword ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
				const suppliedHash = Buffer.from(await scrypt(password, salt, 64));
				const passwordMatches = expectedHash.length === suppliedHash.length
					&& timingSafeEqual(expectedHash, suppliedHash);
				if (!user || !hasPassword || !passwordMatches) throw new ApiError(401, 'Email or password is incorrect.');
				await issueSession(user, response);
				sendJson(response, 200, { user: publicUser(user) });
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
				validateSameOrigin(request);
				const { session } = await getAuthenticatedUser(request);
				await mutateUsers(async (records) => {
					const index = records.findIndex((record) => record.type === 'session' && record.id === session.id);
					if (index < 0) return { value: null };
					records.splice(index, 1);
					return { changed: true };
				});
				const clearCookie = [`${sessionCookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
				if (cookieSecure) clearCookie.push('Secure');
				response.setHeader('Set-Cookie', clearCookie.join('; '));
				sendJson(response, 200, { message: 'You have signed out.' });
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/account/data') {
				const { user } = await getAuthenticatedUser(request);
				sendJson(response, 200, loadAccountData(user.id));
				return;
			}
			if (request.method === 'PUT' && url.pathname === '/api/account/data') {
				validateSameOrigin(request);
				const { user } = await getAuthenticatedUser(request);
				const payload = await readJson(request);
				if (payload?.userId !== user.id) throw new ApiError(403, 'Account data does not match the signed-in account.');
				const data = validateAccountData(payload);
				const updatedAt = new Date().toISOString();
				saveAccountDataStatement.run(user.id, JSON.stringify(data.cart), JSON.stringify(data.favorites), updatedAt);
				sendJson(response, 200, { ...data, updatedAt });
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/account/orders') {
				const { user } = await getAuthenticatedUser(request);
				const orders = await mutateOrders(async (records) => ({
					value: records
						.filter((order) => order.userId === user.id)
						.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
						.map((order) => ({
							id: order.id,
							createdAt: order.createdAt,
							completedAt: order.completedAt ?? null,
							status: order.status,
							currency: order.currency,
							total: order.total,
							items: order.items
						}))
				}));
				sendJson(response, 200, { orders });
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/products') {
				const category = url.searchParams.get('category');
				const search = url.searchParams.get('search')?.trim().toLowerCase();
				if (category && category !== 'all' && !['tops', 'bottoms', 'extras'].includes(category)) {
					throw new ApiError(400, 'Category must be tops, bottoms, extras, or all.');
				}
				const result = products.filter((product) => {
					const matchesCategory = !category || category === 'all' || product.category === category;
					const matchesSearch = !search || `${product.name} ${product.detail}`.toLowerCase().includes(search);
					return matchesCategory && matchesSearch;
				});
				sendJson(response, 200, result);
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/paypal/config') {
				sendJson(response, 200, {
					enabled: paypalEnabled,
					clientId: paypalEnabled ? paypalClientId : null,
					currency: paypalCurrency,
					environment: paypalEnvironment
				});
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/paypal/orders') {
				if (!paypalEnabled) throw new ApiError(503, 'PayPal checkout is not configured.');
				const validated = validateOrder(await readJson(request));
				const user = getCookie(request, sessionCookieName)
					? (await getAuthenticatedUser(request)).user
					: null;
				const order = {
					id: randomUUID(),
					createdAt: new Date().toISOString(),
					status: 'created',
					userId: user?.id ?? null,
					paypalOrderId: '',
					paypalCaptureId: '',
					currency: paypalCurrency,
					...validated
				};
				const amount = order.total.toFixed(2);
				const paypalOrder = await paypalRequest('/v2/checkout/orders', {
					method: 'POST',
					requestId: order.id,
					body: {
						intent: 'CAPTURE',
						purchase_units: [{
							reference_id: order.id,
							custom_id: order.id,
							items: order.items.map((item) => ({
								name: item.name.slice(0, 127),
								sku: `${item.productId}-${item.size}`,
								quantity: String(item.quantity),
								unit_amount: { currency_code: order.currency, value: item.unitPrice.toFixed(2) },
								category: 'PHYSICAL_GOODS'
							})),
							amount: {
								currency_code: order.currency,
								value: amount,
								breakdown: { item_total: { currency_code: order.currency, value: amount } }
							}
						}],
						application_context: {
							brand_name: 'Drip District',
							shipping_preference: 'GET_FROM_FILE',
							user_action: 'PAY_NOW'
						}
					}
				});
				if (typeof paypalOrder.id !== 'string' || paypalOrder.status !== 'CREATED') {
					console.error('PayPal returned an invalid create-order response.');
					throw new ApiError(502, 'PayPal could not create a checkout session.');
				}
				order.paypalOrderId = paypalOrder.id;
				await mutateOrders(async (orders) => {
					orders.push(order);
					return { changed: true };
				});
				sendJson(response, 201, { id: paypalOrder.id });
				return;
			}
			const captureMatch = url.pathname.match(/^\/api\/paypal\/orders\/([^/]+)\/capture$/);
			if (request.method === 'POST' && captureMatch) {
				if (!paypalEnabled) throw new ApiError(503, 'PayPal checkout is not configured.');
				const paypalOrderId = captureMatch[1];
				const order = await mutateOrders(async (orders) => ({
					value: orders.find((entry) => entry.paypalOrderId === paypalOrderId)
				}));
				if (!order) throw new ApiError(404, 'Order not found.');
				if (order.status === 'completed') {
					sendJson(response, 200, {
						status: order.status,
						orderId: order.id,
						shippingAddressReceived: Boolean(order.customer.address)
					});
					return;
				}
				if (order.status !== 'created') throw new ApiError(409, 'This order cannot be captured.');
				const { orderDetails, purchaseUnit, capture } = await capturePayPalOrder(order);
				const shippingAddress = formatAddress(purchaseUnit.shipping?.address);
				const customerName = purchaseUnit.shipping?.name?.full_name || order.customer.name;
				const customerEmail = orderDetails.payer?.email_address || order.customer.email;
				const updatedOrder = await mutateOrders(async (orders) => {
					const current = orders.find((entry) => entry.id === order.id);
					if (!current) throw new ApiError(404, 'Order not found.');
					if (current.status === 'created') {
						current.status = 'completed';
						current.completedAt = new Date().toISOString();
						current.paypalCaptureId = capture.id;
						current.customer.name = customerName;
						current.customer.email = customerEmail;
						current.customer.address = shippingAddress;
						return { changed: true, value: current };
					}
					return { value: current };
				});
				sendJson(response, 200, {
					status: updatedOrder.status,
					orderId: updatedOrder.id,
					shippingAddressReceived: Boolean(updatedOrder.customer.address)
				});
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/paypal/webhook') {
				if (!paypalEnabled) throw new ApiError(503, 'PayPal is not configured on the server.');
				const event = await readJson(request);
				await verifyWebhook(request.headers, event);
				const resource = event.resource;
				const paypalOrderId = resource?.supplementary_data?.related_ids?.order_id;
				const captureId = resource?.id;
				if (typeof paypalOrderId === 'string' && typeof captureId === 'string') {
					const updatedOrder = await mutateOrders(async (orders) => {
						const order = orders.find((entry) =>
							entry.paypalOrderId === paypalOrderId || entry.paypalCaptureId === captureId);
						if (!order) return { value: null };
						if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED'
							&& resource.amount?.value === order.total.toFixed(2)
							&& resource.amount?.currency_code === order.currency) {
							order.status = 'completed';
							order.completedAt ||= new Date().toISOString();
							order.paypalCaptureId = captureId;
							return { changed: true, value: order };
						}
						if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED'
							&& order.paypalCaptureId === captureId
							&& ['completed', 'partially_refunded'].includes(order.status)) {
							const refundEventId = typeof event.id === 'string' ? event.id : '';
							const refundAmount = Number(resource.amount?.value);
							if (!refundEventId || !Number.isFinite(refundAmount) || refundAmount <= 0
								|| resource.amount?.currency_code !== order.currency) {
								return { value: order };
							}
							order.refunds ??= [];
							if (order.refunds.some((refund) => refund.eventId === refundEventId)) {
								return { value: order };
							}
							order.refunds.push({
								eventId: refundEventId,
								amount: refundAmount,
								createdAt: new Date().toISOString()
							});
							const refundedCents = order.refunds.reduce((sum, refund) => sum + Math.round(refund.amount * 100), 0);
							order.status = refundedCents >= Math.round(order.total * 100) ? 'refunded' : 'partially_refunded';
							return { changed: true, value: order };
						}
						if (event.event_type === 'PAYMENT.CAPTURE.REVERSED'
							&& order.paypalCaptureId === captureId
							&& ['completed', 'partially_refunded'].includes(order.status)) {
							order.status = 'reversed';
							order.reversedAt = new Date().toISOString();
							return { changed: true, value: order };
						}
						return { value: order };
					});
					if (!updatedOrder && event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
						console.error(`Verified PayPal webhook refers to an unknown order ${paypalOrderId}.`);
					}
				}
				sendJson(response, 200, { received: true });
				return;
			}
			if (!url.pathname.startsWith('/api') && await serveStaticFile(request, response, staticDirectory, url.pathname)) return;
			sendJson(response, 404, { error: 'Route not found.' });
		} catch (error) {
			if (error instanceof ApiError) {
				sendJson(response, error.status, { error: error.message });
				return;
			}
			console.error('API request failed:', error);
			if (!response.headersSent) sendJson(response, 500, { error: 'The server could not complete the request.' });
			else response.destroy(error);
		}
	});
	server.on('close', () => accountDatabase.close());
	return server;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
	const port = Number(process.env.PORT ?? 3001);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535.');
	}
	const server = createServer();
	server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
		console.log(`Drip District API listening on http://127.0.0.1:${port}`);
	});
}
