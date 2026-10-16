import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Everything under /api is forwarded to the Express backend during dev, exactly
// as it is in production via the Vercel rewrite. Same-origin in both cases, so
// the session cookie and the signed guest cookie behave identically and no CORS
// configuration is needed anywhere.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BACKEND_ORIGIN || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
