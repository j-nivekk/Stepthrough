import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the TypeScript regression tests with Node's test runner, without leaving generated files in the repo.
const output = await mkdtemp(join(tmpdir(), 'stepthrough-tests-'));
try {
  const names = (await readdir('tests')).filter((name) => name.endsWith('.test.ts'));
  await build({
    entryPoints: names.map((name) => join('tests', name)),
    outdir: output, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' },
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, ['--test', ...names.map((name) => join(output, name.replace(/\.ts$/, '.cjs')))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
