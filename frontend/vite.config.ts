import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';

/**
 * The commit this build was made from, shown under about: from the Docker build (which has no .git), or else from
 * git, marked `modified` when tracked files differ from it. Empty outside a git checkout.
 */
function buildCommit(): string {
  const given = (process.env.VITE_BUILD_REVISION ?? '').trim();
  if (given && given !== 'unknown') return given.slice(0, 7);
  const git = (...args: string[]) =>
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const commit = git('rev-parse', '--short=7', 'HEAD');
    return git('status', '--porcelain', '--untracked-files=no') ? `${commit} modified` : commit;
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react()],
  // The version from package.json, shown in the app (see src/lib/buildInfo.ts).
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_COMMIT__: JSON.stringify(buildCommit()),
  },
  server: {
    port: 5173,
  },
});
