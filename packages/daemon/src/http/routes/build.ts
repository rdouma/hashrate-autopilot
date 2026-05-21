/**
 * GET /api/build (#103)
 *
 * Returns the daemon's current build number, git short hash, and app
 * version. Polled by the dashboard every minute - when it diverges
 * from the dashboard's embedded `__BUILD_NUMBER__`, the dashboard
 * shows a "new version available, click to refresh" banner.
 *
 * Same source-of-truth as `vite.config.ts`'s `getBuildInfo()` so
 * dashboard + daemon report identical numbers when in sync.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

export interface BuildInfo {
  readonly build: number;
  readonly hash: string;
  readonly version: string;
}

function readBuildInfo(): BuildInfo {
  const here = dirname(fileURLToPath(import.meta.url));
  // routes/ → http/ → src/ → daemon/ → packages/ → repo root.
  const repoRoot = resolve(here, '../../../../..');

  let build = 0;
  try {
    build = parseInt(readFileSync(resolve(repoRoot, 'BUILD_NUMBER'), 'utf8').trim(), 10) || 0;
  } catch {
    // first build / packaged form without BUILD_NUMBER on disk
  }

  let hash = process.env['GIT_SHA']?.trim() ?? '';
  if (!hash) {
    try {
      hash = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      // not a git checkout (Docker image)
    }
  }

  let version = process.env['APP_VERSION']?.trim() ?? '';
  if (!version) {
    try {
      const manifest = readFileSync(
        resolve(repoRoot, 'rdouma-hashrate-autopilot/umbrel-app.yml'),
        'utf8',
      );
      const match = manifest.match(/^version:\s*"?([^"\s]+)"?\s*$/m);
      if (match?.[1]) version = match[1];
    } catch {
      // manifest unavailable
    }
  }

  return {
    build,
    hash: hash ? hash.slice(0, 7) : 'dev',
    version: version || 'unknown',
  };
}

export const BUILD: BuildInfo = readBuildInfo();
export const USER_AGENT = `hashrate-autopilot/${BUILD.version}`;

export async function registerBuildRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/build', async (): Promise<BuildInfo> => BUILD);
}
