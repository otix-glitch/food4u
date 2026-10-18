# Drip District

A responsive streetwear storefront built with HTML, CSS, and vanilla JavaScript. The catalog includes search, category filters, sorting, saved products, and a cart with size selection and a demo checkout.

## Run locally

Requirements: Node.js 20.19+.

```sh
npm install
npm run dev
```

Vite serves the app locally and refreshes the browser when `index.html` changes. To create a production build:

```sh
npm run build
```

The build output is written to `dist/`.

## Images

Product photos are stored in `public/assets/products/` and included in the repository.

![Streetwear T-shirt](public/assets/products/photo-1521572163474-6864f9cf17ab.jpg)

![Streetwear denim](public/assets/products/photo-1542272604-787c3835535d.jpg)

![Streetwear cap](public/assets/products/photo-1521369909029-2afed882baee.jpg)

## Notes

- Cart and saved products are stored in the browser's local storage.
- Checkout is a frontend demo. It does not process payments or submit orders to a server.
- The app is a single-page static frontend; no backend is included.