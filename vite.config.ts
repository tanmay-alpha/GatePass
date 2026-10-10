import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/qr': 'http://127.0.0.1:3000',
      '/uploads': 'http://127.0.0.1:3000',
      '/l': 'http://127.0.0.1:3000',
      '/r': 'http://127.0.0.1:3000'
    }
  },
  build: {
    outDir: 'dist/client'
  }
});
