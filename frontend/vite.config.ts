import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/viewer/' : '/',
  server: {
    port: 3000,
    proxy: { '/api': { target: 'http://localhost:8421', changeOrigin: true } },
  },
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
}));
