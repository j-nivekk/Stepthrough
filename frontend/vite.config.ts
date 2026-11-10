import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';

export default defineConfig({
  plugins: [react()],
  // The version from package.json, shown in the app (see src/lib/buildInfo.ts).
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    port: 5173,
  },
});
