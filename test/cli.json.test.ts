/**
 * Machine-readable output: `status --json`, `diff --json` and
 * `push --plan-only [--json]`, for scripts, CI and AI agents.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanonicalConfig } from '../src/types.js';
import { runCli } from './helpers/cli.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';

function fixture(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: ['Alpha', 'Beta'].map((name, i) => ({
      id: `c${i + 1}`, name, revision: 1, deployScript: 'return;', exportData: { metadata: { enabled: true } },
    })) },
  };
}

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-json-'));
  tree = path.join(dir, 'tree');
  mirth = await startFakeMirth(fixture());
  env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
  const pull = await runCli(['pull', tree, '--no-https'], env);
  expect(pull.status, pull.stderr).toBe(0);
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const edit = (name: string) => writeFile(path.join(tree, 'channels', name, 'scripts', 'deploy.js'), `// ${name} edited\nreturn;`);
const run = (...args: string[]) => runCli([...args, '--no-https'], env);
/** push, with its backups kept out of the repository. */
const push = (...args: string[]) => run('push', tree, '--backup-dir', path.join(dir, 'backups'), ...args);
/** stdout as the one JSON document `--json` promises. */
const json = (stdout: string): Record<string, unknown> => JSON.parse(stdout) as Record<string, unknown>;

describe('status --json', () => {
  it('reports the counts and where the tree came from', async () => {
    const r = await runCli(['status', tree, '--json']);
    expect(r.status, r.stderr).toBe(0);
    const out = json(r.stdout);
    expect(out['counts']).toEqual({ channels: 2, channelGroups: 0, codeTemplateLibraries: 0, codeTemplates: 0 });
    expect(out['source']).toBe(`http://127.0.0.1:${mirth.port}`);
    expect(out['engineVersion']).toBe('4.5.2');
  });
});

describe('diff --json', () => {
  it('reports a clean tree with exit 0', async () => {
    const r = await run('diff', tree, '--json');
    expect(r.status, r.stderr).toBe(0);
    expect(json(r.stdout)).toMatchObject({ clean: true, files: [], secretDrift: [], patch: '' });
  });

  it('lists each changed file and its kind, with exit 1', async () => {
    await edit('Alpha');
    await rm(path.join(tree, 'channels', 'Beta'), { recursive: true });
    const r = await run('diff', tree, '--json');
    expect(r.status).toBe(1);
    const out = json(r.stdout);
    expect(out['clean']).toBe(false);
    expect(out['files']).toEqual([
      { path: 'channels/Alpha/scripts/deploy.js', change: 'modified' },
      { path: 'channels/Beta/channel.json', change: 'only-on-server' },
      { path: 'channels/Beta/scripts/deploy.js', change: 'only-on-server' },
      // Its entry in the server configuration's channel list.
      { path: 'server/configuration.json', change: 'modified' },
    ]);
    expect(out['patch']).toContain('// Alpha edited');
    // Notes belong in the document, so stdout stays parseable and stderr quiet.
    expect(r.stderr).toBe('');
  });

  it('still exits 2 on an error, with the error on stderr', async () => {
    const r = await run('diff', path.join(dir, 'not-a-tree'), '--json');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not a channelvault tree');
  });
});

describe('push --plan-only', () => {
  it('prints the plan and changes nothing, without a terminal or --yes', async () => {
    await edit('Alpha');
    const r = await push('--plan-only');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/update\s+channel Alpha\n/);
    expect(r.stdout).toContain('plan only: nothing was changed');
    expect(mirth.writes).toEqual([]);
    expect(existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('reports the plan and what would stop a push as JSON', async () => {
    await edit('Alpha');
    await rm(path.join(tree, 'channels', 'Beta'), { recursive: true });
    const r = await push('--plan-only', '--json');
    expect(r.status, r.stderr).toBe(0);
    const out = json(r.stdout);
    expect(out).toMatchObject({ target: `http://127.0.0.1:${mirth.port}`, mode: 'scoped', conflicts: [], serverOnly: [] });
    expect(out['changes']).toEqual([
      { kind: 'channel', op: 'update', id: 'c1', label: 'Alpha' },
      { kind: 'channel', op: 'delete', id: 'c2', label: 'Beta' },
    ]);
    expect(out['wouldStop']).toEqual([expect.stringContaining('pass --allow-deletes')]);

    const allowed = json((await push('--plan-only', '--json', '--allow-deletes')).stdout);
    expect(allowed['wouldStop']).toEqual([]);
    expect(mirth.writes).toEqual([]);
  });

  it('reports which channels --deploy would redeploy', async () => {
    mirth.deployed.add('c1');
    await edit('Alpha');
    await edit('Beta');
    const out = json((await push('--plan-only', '--json', '--deploy')).stdout);
    expect(out).toMatchObject({ redeploy: ['Alpha'], notRedeployed: ['Beta'] });
  });

  it('covers --whole-server too', async () => {
    await edit('Alpha');
    const out = json((await push('--plan-only', '--json', '--whole-server')).stdout);
    expect(out).toMatchObject({ mode: 'whole-server', wouldStop: [] });
    expect(mirth.writes).toEqual([]);
  });

  it('refuses --json without --plan-only', async () => {
    const r = await push('--json', '--yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--json needs --plan-only');
  });
});
