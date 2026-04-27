import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function getBuildInfo(): { build: number; hash: string; version: string } {
  const buildFile = resolve(__dirname, '../../BUILD_NUMBER');
  let build = 0;
  try {
    build = parseInt(readFileSync(buildFile, 'utf8').trim(), 10) || 0;
  } catch { /* first build */ }
  // Prefer an explicit GIT_SHA env var (set by Docker build-arg in CI
  // and locally injected when needed) over running git, because the
  // Docker build context excludes .git/ - without the env override
  // every Docker-baked dashboard would footer "dev". Fall back to a
  // live git call for bare-metal/dev builds, then to "dev" if we
  // really cannot determine it. Truncate to 7 chars to match the
  // short-SHA convention regardless of whether the env var carries
  // the full 40-char form (GitHub Actions sets `github.sha` long).
  let hash = process.env.GIT_SHA?.trim() || '';
  if (!hash) {
    try {
      hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch { /* not a git repo */ }
  }
  // App version: pulled out of umbrel-app.yml's `version:` line. Same
  // source the Umbrel community store reads, so the footer cannot
  // drift from the published release - they share one canonical
  // file. Falls back to "unknown" if the manifest is missing or
  // unparseable; footer chrome must never break the build (#74).
  let version = 'unknown';
  try {
    const manifestPath = resolve(__dirname, '../../rdouma-hashrate-autopilot/umbrel-app.yml');
    const manifest = readFileSync(manifestPath, 'utf8');
    const match = manifest.match(/^version:\s*"?([^"\s]+)"?\s*$/m);
    if (match?.[1]) version = match[1];
  } catch { /* manifest unavailable */ }
  return { build, hash: hash ? hash.slice(0, 7) : 'dev', version };
}

const info = getBuildInfo();

export default defineConfig({
  plugins: [
    react({
      // Enable babel-plugin-macros so @lingui/macro's <Trans> + `t`
      // template tag transform at compile time. Without this the
      // macros stay as-is in the output and Lingui throws at runtime.
      babel: {
        plugins: ['macros'],
      },
    }),
    // Pin Lingui's config search to the dashboard package dir so
    // pnpm-r and vitest invocations from the workspace root (whose
    // process.cwd() is the repo root, not packages/dashboard) still
    // find lingui.config.js. Without this, root-level test runs fail
    // with "No Lingui config found".
    lingui({ cwd: __dirname }),
    tailwindcss(),
  ],
  define: {
    __BUILD_NUMBER__: JSON.stringify(info.build),
    __BUILD_HASH__: JSON.stringify(info.hash),
    __APP_VERSION__: JSON.stringify(info.version),
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
