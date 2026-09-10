import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.HOST || '0.0.0.0';
  const port = Number(env.PORT || env.VITE_PORT || 5173);
  const apiBase = env.VITE_API_BASE_URL || env.API_BASE_URL || '';

  return {
    plugins: [react()],
    server: {
      host,
      port,
      strictPort: true,
      proxy: apiBase ? undefined : {
        '/api': 'http://127.0.0.1:8787',
      },
    },
    preview: {
      host,
      port,
      strictPort: true,
      proxy: apiBase ? undefined : {
        '/api': 'http://127.0.0.1:8787',
      },
    },
    define: {
      __APP_API_BASE__: JSON.stringify(apiBase),
    },
  };
});
