import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.FAMILIAR_API ?? 'http://127.0.0.1:4400';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
