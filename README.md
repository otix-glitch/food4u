# Drip District

A responsive streetwear storefront built with HTML, CSS, and vanilla JavaScript. Its Node.js backend serves the product catalog and provides self-hosted email/password accounts. The storefront includes search, category filters, sorting, saved products, and a cart with size selection.

## Run locally

Requirements: Node.js 20.19+.

Install the project dependencies:

```sh
npm install
```

Start the backend and storefront in separate terminals from the project directory:

```sh
npm run api
```

```sh
npm run dev
```

## Deploy a public preview

The Render Blueprint in `render.yaml` builds and serves the storefront and API from one web service. Connect the repository to Render and create a Blueprint instance. The preview disables customer accounts and PayPal checkout; do not add live payment credentials to this preview.

Render's free web service may spin down after inactivity, so it is suitable for a public preview but not an always-on store. Free instances can also have ephemeral storage. Accounts and checkout are disabled to avoid relying on that storage. Upgrade to an always-on plan and choose durable storage before enabling customer accounts or payments.

### Customer email accounts

The built-in account feature does not need Supabase or another identity provider. Customers can create an account and sign in using an email address and a password of at least 12 characters. The backend stores a salted scrypt password hash (never the raw password) and issues a random, `HttpOnly`, `SameSite=Strict` session cookie. Sessions last up to seven days and a new sign-in replaces the account's previous session.

Account data is stored in `data/auth.json`, which is git-ignored. This file-based store is intended for local testing, not a production deployment; use a durable, access-controlled database with backups before opening registration to customers. On production, set `APP_ORIGIN` to the exact public HTTPS origin of the storefront (for example, `https://shop.example.com`). Production mode requires this setting and marks session cookies `Secure`. Local development can leave it unset.

Email/password signup addresses are not verified. Password reset is supported when SMTP delivery is configured. Set `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM`, then either set both `SMTP_USER` and `SMTP_PASSWORD` or leave both blank for a trusted relay. Use `SMTP_SECURE=true` for implicit TLS (normally port 465); port 587 uses STARTTLS. Reset links are single-use, expire after 15 minutes, and invalidate existing sessions when used. Reset requests are rate-limited with other account mutations and return the same response whether or not an account exists. Password reset is unavailable in the public preview and when SMTP is not configured. For multi-instance production hosting, use shared rate limiting and persistent account storage.

Example SMTP configuration:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=Drip District <support@example.com>
```

Keep SMTP credentials private and configure them as deployment secrets in production. Delivery failures are logged by the API, and undelivered reset tokens are revoked.

### Google and Microsoft sign-in

Email/password sign-in remains available. To enable Google, create a Google OAuth **Web application** client and configure its authorized redirect URI as `${APP_ORIGIN}/api/auth/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

To enable Microsoft, register an application in the Microsoft Entra admin center. Choose the supported account types you want, add a **Web** redirect URI `${APP_ORIGIN}/api/auth/microsoft/callback`, and create a client secret. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. `MICROSOFT_TENANT_ID` defaults to `common` for work/school and personal Microsoft accounts; it can also be `organizations`, `consumers`, or a tenant GUID. Keep the client secret on the server.

Set `APP_ORIGIN` to the exact storefront origin used by customers and register callback URLs with the same scheme, host, and port. Local development defaults to `http://127.0.0.1:5173`; configure matching local redirect URLs in providers that allow them. OAuth uses authorization code flow with PKCE, state, and nonce checks. Google requires a verified email. Microsoft may not assert that its email claim is verified, so new accounts can sign in with that identity but are not automatically linked to an existing account by an unverified email. Provider settings are optional, and their buttons appear only when configured. Keep all provider secrets in ignored `.env` locally and deployment secrets in production. OAuth transaction state is held in the API process, so run one API instance unless that state is moved to shared storage.

### Configure PayPal sandbox payments

1. Create a PayPal developer account and a **sandbox REST app**. Copy its client ID and secret.
2. Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` in a POSIX shell).
3. Add the sandbox app credentials to `.env`:

   ```dotenv
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-secret
   PAYPAL_ENV=sandbox
   PAYPAL_CURRENCY=USD
   ```

4. Restart `npm run api`. Use a PayPal sandbox personal test account to complete checkout.

The PayPal JavaScript SDK collects payment details; the server creates the order from catalog prices and captures it only after approval. Secret credentials stay on the server. The current checkout charges the product subtotal in USD; it does not calculate shipping fees or tax. For production, set `PAYPAL_ENV=live` and use the **live** credentials from a PayPal Business account only after verifying that PayPal supports receiving merchant payments and payouts for the business's country and currency. The owner is in Nigeria; confirm eligibility and USD settlement/payout options directly with PayPal before switching to live mode. Do not use live credentials during development.

For production, configure a PayPal webhook at the public HTTPS URL `https://your-domain/api/paypal/webhook` and set its ID as `PAYPAL_WEBHOOK_ID`. The server verifies webhook signatures and records completed, reversed, and refunded captures. Local Vite development proxies `/api` to the backend; the API listens on `http://127.0.0.1:3001`.

Available API endpoints:

- `GET /api/health` — backend health check.
- `POST /api/auth/signup` — creates an account with a salted password hash.
- `POST /api/auth/login` — checks credentials and sets a server-managed session cookie.
- `GET /api/auth/google/start` and `GET /api/auth/google/callback` — Google OpenID Connect sign-in.
- `GET /api/auth/microsoft/start` and `GET /api/auth/microsoft/callback` — Microsoft OpenID Connect sign-in.
- `POST /api/auth/password-reset/request` — sends a single-use reset link when the email belongs to an account.
- `POST /api/auth/password-reset/complete` — changes the password using a valid reset token and revokes existing sessions.
- `GET /api/auth/me` — returns the profile for the current session.
- `POST /api/auth/logout` — invalidates the current session and clears its cookie.
- `GET /api/products` — catalog, optionally filtered with `category` or `search` query parameters.
- `GET /api/paypal/config` — public checkout configuration (never returns the secret).
- `POST /api/paypal/orders` — validates cart items and creates a PayPal order using server-side prices.
- `POST /api/paypal/orders/:id/capture` — captures an approved PayPal order and confirms the captured amount.
- `POST /api/paypal/webhook` — verifies PayPal webhook signatures and syncs payment events.

Orders are stored in `data/orders.json`, which is git-ignored and contains customer contact/shipping details and payment references. This file-based store is suitable for local testing only; before accepting live payments, replace it with a durable, access-controlled database and configure backups and retention. Keep `.env` and live credentials private.

Vite serves the app locally and refreshes the browser when files change. To create a production build:

```sh
npm run build
```

The build output is written to `dist/`.

## Images

Product photos are stored in `public/assets/products/` and included in the repository.

![Streetwear T-shirt](public/assets/products/photo-1521572163474-6864f9cf17ab.jpg)

![Streetwear denim](public/assets/products/photo-1542272604-787c3835535d.jpg)

![Streetwear cap](public/assets/products/photo-1521369909029-2afed882baee.jpg)

## Tests

```sh
npm test
```

## Notes

- Cart and saved products are stored in the browser's local storage.
- Account passwords are never stored in browser storage; authentication uses an `HttpOnly` session cookie.
- Sandbox payments are simulated by PayPal; live payments transfer real funds.