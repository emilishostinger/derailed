import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverOrigin = process.env.DERAILED_SERVER_ORIGIN ?? 'http://localhost:31337';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The dashboard answers on 1337 in production, so it answers on 1337 here too;
    // the API server takes 31337 in dev to leave this port free. See `config.ts`.
    port: Number(process.env.DERAILED_WEB_PORT ?? 1337),
    strictPort: true,
    // Vite alone would bind ::1, but the server this replaces on 1337 binds 0.0.0.0,
    // and things that address it by literal 127.0.0.1 (the MCP server's default URL,
    // Caddy dialling back through the host gateway) get a refused connection on an
    // IPv6-only listener. Match what they expect.
    host: true,
    proxy: {
      '/api': {
        target: serverOrigin,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
