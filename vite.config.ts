import { defineConfig } from 'vite';

// GitHub Pages liegt unter https://trapanotto.github.io/ski/
export default defineConfig({
  base: './',
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
