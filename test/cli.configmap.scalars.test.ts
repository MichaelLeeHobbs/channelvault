/** Mirth's JSON answers a configuration-map value such as `true` or `1234` as a boolean or number; it is still a secret. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readEnvFile, updateEnvFile } from '../src/secrets/envfile.js';
import type { CanonicalConfig, Json } from '../src/types.js';
import { runCli } from './helpers/cli.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';

type Obj = Record<string, Json>;
const PROPERTY = 'com.mirth.connect.util.ConfigurationProperty';
const entry = (key: string, value: Json): Obj => ({ string: key, [PROPERTY]: { value, comment: null } });

function fixture(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: [{ id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;', exportData: { metadata: { enabled: true } } }] },
    configurationMap: { entry: [entry('FEATURE_ON', true), entry('PIN', 918273), entry('TEXT', 'plain-text-value')] },
  };
}

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-configmap-scalars-'));
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

const configFile = () => path.join(tree, 'server', 'configuration.json');
const serverMap = (): Obj[] => (mirth.config['configurationMap'] as { entry: Obj[] }).entry;
const diff = () => runCli(['diff', tree, '--no-https'], env);

function treeFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const p = path.join(root, name);
    if (name === '.env') return [];
    return statSync(p).isDirectory() ? treeFiles(p) : [p];
  });
}

async function treeMap(): Promise<Obj[]> {
  const config = JSON.parse(await readFile(configFile(), 'utf8')) as Obj;
  return (config['configurationMap'] as { entry: Obj[] }).entry;
}
const valueOf = (entries: Obj[], key: string) => (entries.find((e) => e['string'] === key)?.[PROPERTY] as Obj)['value'];

describe('configuration-map values that are not JSON strings', () => {
  it('moves booleans and numbers to the env file, leaving no literal in the tree, and diff is clean', async () => {
    const entries = await treeMap();
    expect(valueOf(entries, 'FEATURE_ON')).toBe('{{env:CONFIG_MAP__FEATURE_ON}}');
    expect(valueOf(entries, 'PIN')).toBe('{{env:CONFIG_MAP__PIN}}');
    for (const file of treeFiles(tree)) expect(readFileSync(file, 'utf8'), file).not.toContain('918273');
    expect(await readEnvFile(path.join(tree, '.env'))).toMatchObject({ CONFIG_MAP__FEATURE_ON: 'true', CONFIG_MAP__PIN: '918273' });

    const result = await diff();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('never prints a number or boolean value in diff, from either side', async () => {
    (serverMap()[1]![PROPERTY] as Obj)['value'] = 192837;
    const config = JSON.parse(await readFile(configFile(), 'utf8')) as Obj;
    const entries = (config['configurationMap'] as { entry: Obj[] }).entry;
    (entries[0]![PROPERTY] as Obj)['value'] = 564738;
    await writeFile(configFile(), JSON.stringify(config, null, 2));

    const result = await diff();
    for (const literal of ['192837', '564738', '918273']) {
      expect(result.stdout + result.stderr).not.toContain(literal);
    }
  });

  it('leaves diff clean after a key push that Mirth reads back as a boolean', async () => {
    await updateEnvFile(path.join(tree, '.env'), { CONFIG_MAP__FEATURE_ON: 'false' });
    const pushed = await runCli(['push', tree, '--no-https', '--backup-dir', path.join(dir, 'backups'), '--config-map-key', 'FEATURE_ON', '--yes'], env);
    expect(pushed.status, pushed.stderr).toBe(0);
    const stored = serverMap().find((e) => e['string'] === 'FEATURE_ON')![PROPERTY] as Obj;
    expect(stored['value']).toBe('false');
    stored['value'] = false;

    const result = await diff();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
