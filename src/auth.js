const authDialog = document.querySelector('#auth-dialog');
const authForm = document.querySelector('#auth-form');
const authTrigger = document.querySelector('#auth-trigger');
const authMessage = document.querySelector('#auth-message');
const authSubmit = document.querySelector('#auth-submit');
const authModeToggle = document.querySelector('#auth-mode-toggle');
const authModeDescription = document.querySelector('#auth-mode-description');
const authTitle = document.querySelector('#auth-title');
const authDescription = document.querySelector('#auth-description');
const authSignedIn = document.querySelector('#auth-signed-in');
const authEmail = document.querySelector('#auth-email');
const authModeActions = document.querySelector('#auth-mode-actions');
const authPassword = document.querySelector('#auth-password-input');
const authWarning = document.querySelector('#auth-warning');
let currentUser = null;
let mode = 'sign_in';

function updateCurrentUser(user) {
	currentUser = user;
	window.dripDistrictAccount = user;
	window.dispatchEvent(new CustomEvent('dripdistrict:account', { detail: { user } }));
	renderAuth();
	if (user) void loadAccountOrders(user);
	else {
		document.querySelector('#account-orders').replaceChildren();
		document.querySelector('#account-orders-message').textContent = 'Sign in to see your orders.';
	}
}

function showMessage(element, text, isError = false) {
	element.textContent = text;
	element.dataset.error = String(isError);
}

async function loadAccountOrders(user) {
	const orderList = document.querySelector('#account-orders');
	const message = document.querySelector('#account-orders-message');
	orderList.replaceChildren();
	message.textContent = 'Loading your orders…';
	try {
		const response = await fetch('/api/account/orders');
		let result;
		try {
			result = await response.json();
		} catch {
			throw new Error('The account service returned an invalid order-history response.');
		}
		if (!response.ok) throw new Error(result.error || 'Could not load your order history.');
		if (currentUser?.id !== user.id) return;
		if (!Array.isArray(result.orders) || result.orders.length === 0) {
			message.textContent = 'You have not placed any orders yet.';
			return;
		}
		message.textContent = '';
		for (const order of result.orders) {
			const item = document.createElement('li');
			const summary = document.createElement('p');
			const date = new Date(order.createdAt);
			const dateText = Number.isNaN(date.valueOf()) ? 'Date unavailable' : date.toLocaleDateString();
			const amount = Number(order.total);
			summary.textContent = `${dateText} · ${order.status} · ${order.currency} ${amount.toFixed(2)}`;
			const details = document.createElement('p');
			details.textContent = Array.isArray(order.items)
				? order.items.map((entry) => `${entry.name} (${entry.size}) × ${entry.quantity}`).join(', ')
				: 'Order details unavailable.';
			item.append(summary, details);
			orderList.append(item);
		}
	} catch (error) {
		if (currentUser?.id !== user.id) return;
		console.error('Could not load order history:', error);
		message.textContent = error instanceof Error ? error.message : 'Could not load your order history.';
		message.dataset.error = 'true';
	}
}

window.addEventListener('dripdistrict:account-data-status', (event) => {
	const message = document.querySelector('#account-data-message');
	message.textContent = event.detail.message;
	message.dataset.error = String(event.detail.isError);
});

async function authRequest(path, { method = 'GET', body } = {}) {
	let response;
	try {
		response = await fetch(`/api/auth/${path}`, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : {},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(15000)
		});
	} catch {
		throw new Error('Could not reach the account service. Please try again.');
	}

	let result;
	try {
		result = await response.json();
	} catch {
		throw new Error('The account service returned an invalid response.');
	}
	if (!response.ok) throw new Error(result.error || 'The account request failed. Please try again.');
	return result;
}

function renderAuth() {
	const isSignedIn = Boolean(currentUser);
	authTrigger.textContent = isSignedIn ? 'Account' : 'Sign in';
	authTrigger.setAttribute('aria-label', isSignedIn ? `Account for ${currentUser.email}` : 'Sign in to your account');
	authForm.hidden = isSignedIn;
	authModeActions.hidden = isSignedIn;
	authSignedIn.hidden = !isSignedIn;
	if (isSignedIn) authEmail.textContent = currentUser.email;
	authTitle.textContent = isSignedIn ? 'Your account' : mode === 'sign_up' ? 'Create account' : 'Sign in';
	authDescription.textContent = isSignedIn
		? 'Your Drip District account.'
		: mode === 'sign_up' ? 'Create an account with your email and password.' : 'Sign in to your Drip District account.';
	authModeDescription.textContent = mode === 'sign_up' ? 'Already have an account?' : 'New here?';
	authModeToggle.textContent = mode === 'sign_up' ? 'Sign in' : 'Create account';
	authSubmit.textContent = mode === 'sign_up' ? 'Create account' : 'Sign in';
	authPassword.autocomplete = mode === 'sign_up' ? 'new-password' : 'current-password';
	authWarning.hidden = false;
}

async function loadCurrentUser() {
	try {
		const response = await fetch('/api/config');
		const config = await response.json();
		if (!response.ok) throw new Error('Could not load account settings.');
		if (!config.accountsEnabled) {
			authTrigger.hidden = true;
			return;
		}
	} catch (error) {
		console.error('Could not load account settings:', error);
	}
	try {
		const result = await authRequest('me');
		updateCurrentUser(result.user);
	} catch (error) {
		if (error.message !== 'Sign in to continue.' && error.message !== 'Your sign-in has expired. Please sign in again.') {
			console.error('Could not load the current account:', error);
		}
		updateCurrentUser(null);
	}
	if (!currentUser && !authDialog.open) {
		authDialog.showModal();
		authForm.elements.email.focus();
	}
}

authTrigger.addEventListener('click', () => {
	showMessage(authMessage, '');
	renderAuth();
	if (currentUser) void loadAccountOrders(currentUser);
	authDialog.showModal();
});

document.querySelector('#auth-close').addEventListener('click', () => authDialog.close());
authDialog.addEventListener('click', (event) => {
	if (event.target === authDialog) authDialog.close();
});

authModeToggle.addEventListener('click', () => {
	mode = mode === 'sign_in' ? 'sign_up' : 'sign_in';
	authForm.reset();
	showMessage(authMessage, '');
	renderAuth();
});

authForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	authSubmit.disabled = true;
	authModeToggle.disabled = true;
	showMessage(authMessage, '');
	const email = authForm.elements.email.value.trim();
	const password = authPassword.value;
	try {
		if (mode === 'sign_up') {
			const result = await authRequest('signup', {
				method: 'POST',
				body: { email, password }
			});
			authForm.reset();
			mode = 'sign_in';
			renderAuth();
			showMessage(authMessage, result.message);
			return;
		}

		const result = await authRequest('login', {
			method: 'POST',
			body: { email, password }
		});
		updateCurrentUser(result.user);
		authForm.reset();
		renderAuth();
		authDialog.close();
	} catch (error) {
		console.error('Email sign-in failed:', error);
		showMessage(authMessage, error instanceof Error ? error.message : 'Sign-in failed. Please try again.', true);
	} finally {
		authSubmit.disabled = false;
		authModeToggle.disabled = false;
	}
});

document.querySelector('#auth-sign-out').addEventListener('click', async () => {
	const button = document.querySelector('#auth-sign-out');
	button.disabled = true;
	try {
		await authRequest('logout', { method: 'POST', body: {} });
		updateCurrentUser(null);
		authForm.reset();
		showMessage(authMessage, 'You have signed out.');
	} catch (error) {
		console.error('Could not sign out:', error);
		showMessage(authMessage, error instanceof Error ? error.message : 'Could not sign out. Please try again.', true);
	} finally {
		button.disabled = false;
	}
});

loadCurrentUser();
