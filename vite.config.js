import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		allowedHosts: ['.trycloudflare.com'],
		proxy: {
			'/api': 'http://127.0.0.1:3001'
		}
	},
	preview: {
		proxy: {
			'/api': 'http://127.0.0.1:3001'
		}
	}
});
