import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelsOf } from '../src/push/index.js';
import type { CanonicalConfig } from '../src/types.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';
import { runCli, startCli } from './helpers/cli.js';

function fixture(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: ['Alpha', 'Beta', 'Gamma'].map((name, i) => ({
      id: `c${i + 1}`, name, revision: 1, deployScript: 'return;', exportData: { metadata: { enabled: true } },
    })) },
  };
}

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-cli-'));
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
const edit = async (name: string) => writeFile(path.join(tree, 'channels', name, 'scripts', 'deploy.js'), `// ${name} edited\nreturn;`);
const pushArgs = (...flags: string[]) => ['push', tree, '--no-https', ...flags];
const writes = () => mirth.writes.map(w => `${w.method} ${w.path}`);
const meta = async () => JSON.parse(await readFile(path.join(tree, 'channelvault.json'), 'utf8')) as { resources: { channels: Record<string, number> } };

describe('CLI partial pushes', () => {
  it('compares secret-bearing global scripts against the actual pulled server content', async () => {
    mirth.config['globalScripts'] = { entry: [{ string: ['Deploy', "var password = 'fixture-password';"] }] };
    const pulled = await runCli(['pull', tree, '--no-https', '--extract-secrets'], env);
    expect(pulled.status, pulled.stderr).toBe(0);
    const file = path.join(tree, 'server', 'configuration.json');
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('fixture-password');
    expect(text).toContain('{{env:');
    const config = JSON.parse(text) as { globalScripts: { entry: Array<{ string: string[] }> } };
    config.globalScripts.entry[0]!.string[1] += '\n// local edit';
    await writeFile(file, JSON.stringify(config));
    const pushed = await runCli(pushArgs('--yes', '--global-scripts'), env);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(writes()).toEqual(['PUT /api/server/globalScripts']);
    expect(mirth.config['globalScripts']).toEqual({ entry: [{ string: ['Deploy', "var password = 'fixture-password';\n// local edit"] }] });
    expect(pushed.stdout + pushed.stderr).not.toContain('fixture-password');
  });

  it('stops at a failed save, records only completed revisions, and retries only remaining changes', async () => {
    await Promise.all(['Alpha', 'Beta', 'Gamma'].map(edit));
    mirth.onRequest = req => req.method === 'PUT' && req.path === '/api/channels/c2' ? { status: 503, body: 'synthetic failure' } : undefined;
    const failed = await runCli(pushArgs('--yes'), env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('applied 1 of 3; update Beta failed');
    expect(writes()).toEqual(['PUT /api/channels/c1', 'PUT /api/channels/c2']);
    expect(channelsOf(mirth.config).map(c => c['deployScript'])).toEqual(['// Alpha edited\nreturn;', 'return;', 'return;']);
    expect((await meta()).resources.channels).toEqual({ c1: 2, c2: 1, c3: 1 });
    mirth.onRequest = undefined;
    mirth.writes.length = 0;
    const retry = await runCli(pushArgs('--yes'), env);
    expect(retry.status, retry.stderr).toBe(0);
    expect(writes()).toEqual(['PUT /api/channels/c2', 'PUT /api/channels/c3']);
    expect(channelsOf(mirth.config).map(c => c['deployScript'])).toEqual(['// Alpha edited\nreturn;', '// Beta edited\nreturn;', '// Gamma edited\nreturn;']);
  });

  it('reports the failed save even when the subsequent refresh also fails', async () => {
    await edit('Alpha');
    mirth.onRequest = req => {
      if (req.method === 'PUT') return { status: 503, body: 'save refused' };
      if (req.path === '/api/server/configuration' && mirth.writes.length) return { status: 502, body: 'refresh unavailable' };
    };
    const failed = await runCli(pushArgs('--yes'), env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('applied 0 of 1; update Alpha failed');
    expect(failed.stderr).toContain('save refused');
    expect((await meta()).resources.channels).toEqual({ c1: 1, c2: 1, c3: 1 });
  });

  it('treats a boolean false response as failure and never attempts later resources', async () => {
    await Promise.all(['Alpha', 'Beta'].map(edit));
    mirth.onRequest = req => req.method === 'PUT' ? { status: 200, body: { boolean: false } } : undefined;
    const failed = await runCli(pushArgs('--yes'), env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('server refused the update');
    expect(writes()).toEqual(['PUT /api/channels/c1']);
    expect(channelsOf(mirth.config).map(c => c['revision'])).toEqual([1, 1, 1]);
  });

  it.each(['scoped', 'whole-server'])('does not adopt a concurrent edit during the %s post-save refresh', async mode => {
    await edit('Alpha');
    let injected = false;
    mirth.onRequest = req => {
      if (!injected && req.method === 'GET' && req.path === '/api/server/configuration' && mirth.writes.length) {
        injected = true;
        channelsOf(mirth.config)[0]!['revision'] = 3;
        channelsOf(mirth.config)[0]!['deployScript'] = 'colleagueAfterSave();';
      }
    };
    const result = await runCli(pushArgs('--yes', ...(mode === 'whole-server' ? ['--whole-server'] : [])), env);
    expect(injected).toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed again after saving');
    expect((await meta()).resources.channels.c1).toBe(1);
    mirth.writes.length = 0;
    const retry = await runCli(pushArgs('--yes'), env);
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain('server revision 3');
    expect(mirth.writes).toEqual([]);
    expect(channelsOf(mirth.config)[0]!['deployScript']).toBe('colleagueAfterSave();');
  });

  it('reports deployment failure after saving and leaves an undeployed channel stopped', async () => {
    await Promise.all(['Alpha', 'Beta', 'Gamma'].map(edit));
    mirth.deployed = new Set(['c1', 'c2']);
    mirth.onRequest = req => req.path === '/api/channels/c1/_deploy' ? { status: 500, body: 'compile failed' } : undefined;
    const failed = await runCli(pushArgs('--yes', '--deploy'), env);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('pushed 3 change(s)');
    expect(failed.stdout).toContain('deployed 1 of 2');
    expect(failed.stderr).toContain('deploy failed: Alpha');
    expect(writes()).toEqual(['PUT /api/channels/c1', 'PUT /api/channels/c2', 'PUT /api/channels/c3', 'POST /api/channels/c1/_deploy', 'POST /api/channels/c2/_deploy']);
    expect(mirth.deployed.has('c3')).toBe(false);
    expect((await meta()).resources.channels).toEqual({ c1: 2, c2: 2, c3: 2 });
  });
});

describe('CLI confirmation', () => {
  it.each(['scoped', 'whole-server'])('refuses a concurrent edit after the %s prompt', async mode => {
    await edit('Alpha');
    const running = startCli(pushArgs(...(mode === 'whole-server' ? ['--whole-server'] : [])), env, true);
    try {
      await running.waitFor('Continue?');
      channelsOf(mirth.config)[0]!['revision'] = 2;
      channelsOf(mirth.config)[0]!['deployScript'] = 'colleague();';
      running.child.stdin.end('y\n');
      const result = await running.finished;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('while this push was being confirmed');
      expect(mirth.writes).toEqual([]);
      expect(channelsOf(mirth.config)[0]!['deployScript']).toBe('colleague();');
    } finally { running.child.kill(); }
  });

  it('requires deletion consent for resources appearing after a forced whole-server preview', async () => {
    await edit('Alpha');
    const running = startCli(pushArgs('--whole-server', '--force'), env, true);
    try {
      await running.waitFor('Continue?');
      mirth.config['channels'] = { channel: [...channelsOf(mirth.config), { id: 'c4', name: 'New while confirming', revision: 1 }] };
      expect(channelsOf(mirth.config)).toHaveLength(4);
      running.child.stdin.end('y\n');
      const result = await running.finished;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--allow-deletes');
      expect(mirth.writes).toEqual([]);
    } finally { running.child.kill(); }
  });

  it('cancels cleanly when the answer is no', async () => {
    await edit('Alpha');
    const running = startCli(pushArgs(), env, true);
    try {
      await running.waitFor('Continue?');
      running.child.stdin.end('n\n');
      const result = await running.finished;
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('aborted.');
      expect(mirth.writes).toEqual([]);
      expect(mirth.requests.at(-1)?.path).toBe('/api/users/_logout');
    } finally { running.child.kill(); }
  });

  it('exits unsuccessfully and logs out when input closes before an answer', async () => {
    await edit('Alpha');
    const before = await readFile(path.join(tree, 'channelvault.json'), 'utf8');
    const running = startCli(pushArgs(), env, true);
    try {
      await running.waitFor('Continue?');
      running.child.stdin.end();
      const result = await running.finished;
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('confirmation interrupted');
      expect(mirth.writes).toEqual([]);
      expect(mirth.requests.at(-1)?.path).toBe('/api/users/_logout');
      expect(await readFile(path.join(tree, 'channelvault.json'), 'utf8')).toBe(before);
    } finally { running.child.kill(); }
  });
});
