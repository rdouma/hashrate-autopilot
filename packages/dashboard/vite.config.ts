import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function getBuildInfo(): { build: number; hash: string } {
  const buildFile = resolve(__dirname, '../../BUILD_NUMBER');
  let build = 0;
  try {
    build = parseInt(readFileSync(buildFile, 'utf8').trim(), 10) || 0;
  } catch { /* first build */ }
  let hash = 'dev';
  try {
    hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* not a git repo */ }
  return { build, hash };
}

const info = getBuildInfo();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_NUMBER__: JSON.stringify(info.build),
    __BUILD_HASH__: JSON.stringify(info.hash),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
