import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiPort = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
});
