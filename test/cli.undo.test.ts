import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CanonicalConfig, Json } from '../src/types.js';
import { list } from '../src/push/index.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';
import { printedUndoArgs, runCli } from './helpers/cli.js';

type Obj = Record<string, Json>;
const configurationMap = (value: string): Json => ({ entry: { string: 'mode', 'com.mirth.connect.util.ConfigurationProperty': { value, comment: '' } } });
let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-undo-'));
  tree = path.join(dir, 'tree');
  mirth = await startFakeMirth({ '@version': '4.5.2',
    channels: { channel: { id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;' } },
    configurationMap: configurationMap('original'),
  });
  env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
  expect((await runCli(['pull', tree, '--no-https'], env)).status).toBe(0);
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const mapValue = (config: CanonicalConfig): string => String((list((config.configurationMap as Obj).entry)[0]!['com.mirth.connect.util.ConfigurationProperty'] as Obj).value);
const push = (...flags: string[]) => runCli(['push', tree, '--no-https', '--backup-dir', path.join(dir, 'undo backups'), '--yes', ...flags], env);
async function changeTree() {
  const file = path.join(tree, 'server', 'configuration.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.configurationMap = configurationMap('replacement');
  await writeFile(file, JSON.stringify(config));
  await writeFile(path.join(tree, 'channels', 'Alpha', 'scripts', 'deploy.js'), 'edited();');
}

it.each([false, true])('the complete printed undo restores the map only when the push overwrote it (%s)', async overwrite => {
  await changeTree();
  const result = await push('--whole-server', ...(overwrite ? ['--overwrite-config-map'] : []));
  expect(result.status, result.stderr).toBe(0);
  expect(mapValue(mirth.config)).toBe(overwrite ? 'replacement' : 'original');
  const args = printedUndoArgs(result.stdout);
  expect(args.includes('--overwrite-config-map')).toBe(overwrite);
  expect(args).toContain('--backup-dir');
  expect(args).toContain(path.join(dir, 'undo backups'));
  expect(args).toContain('--no-https');
  // Carry the original target explicitly, even if the shell's defaults changed.
  const undo = await runCli([...args, '--yes'], { ...env, MIRTH_HOST: '127.0.0.2', MIRTH_PORT: '1' });
  expect(undo.status, undo.stderr).toBe(0);
  expect(undo.stderr).not.toContain('cannot be checked');
  expect(mapValue(mirth.config)).toBe('original');
  expect(mirth.writes.at(-1)!.query.overwriteConfigMap).toBe(String(overwrite));
});

it('prints another complete map-restoring undo when undoing the first replacement', async () => {
  await changeTree();
  const pushResult = await push('--whole-server', '--overwrite-config-map');
  const firstUndo = await runCli([...printedUndoArgs(pushResult.stdout), '--yes'], env);
  expect(firstUndo.status, firstUndo.stderr).toBe(0);
  expect(mapValue(mirth.config)).toBe('original');
  const secondArgs = printedUndoArgs(firstUndo.stdout);
  expect(secondArgs).toContain('--overwrite-config-map');
  const secondUndo = await runCli([...secondArgs, '--yes'], env);
  expect(secondUndo.status, secondUndo.stderr).toBe(0);
  expect(mapValue(mirth.config)).toBe('replacement');
});

it('does not replace an operator map edit when the push never overwrote the map', async () => {
  await changeTree();
  const result = await push('--whole-server');
  mirth.config.configurationMap = configurationMap('operator-edit');
  const undo = await runCli([...printedUndoArgs(result.stdout), '--yes'], env);
  expect(undo.status, undo.stderr).toBe(0);
  expect(mapValue(mirth.config)).toBe('operator-edit');
});

it('distinguishes saved configuration undo from runtime recovery and omits a flag-only password', async () => {
  await changeTree();
  mirth.deployed.add('c1');
  const result = await push('--deploy', '--pass', 'password-supplied-through-flag');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('runtime deployment state is not in the backup');
  expect(result.stdout).toContain('supply this server\'s password through MIRTH_PASS');
  expect(result.stdout).not.toContain('password-supplied-through-flag');
  expect(printedUndoArgs(result.stdout)).not.toContain('--deploy');
});

it('refuses a map-overwrite flag on scoped push before any server mutation', async () => {
  const result = await push('--overwrite-config-map');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--overwrite-config-map needs --whole-server');
  expect(mirth.writes).toEqual([]);
});
