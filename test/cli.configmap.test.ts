/** `push --config-map-key`: a read-modify-write of Mirth's configuration map, scoped to named keys. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BASELINES_DIR } from '../src/configMapBaselines.js';
import { updateEnvFile } from '../src/secrets/envfile.js';
import type { CanonicalConfig, Json } from '../src/types.js';
import { runCli } from './helpers/cli.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';

type Obj = Record<string, Json>;
const PROPERTY = 'com.mirth.connect.util.ConfigurationProperty';
const entry = (key: string, value: string, comment: string | null = null): Obj => ({ string: key, [PROPERTY]: { value, comment } });

function fixture(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: [{ id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;', exportData: { metadata: { enabled: true } } }] },
    configurationMap: { entry: [entry('KILL_SWITCH', 'old-switch-value'), entry('OTHER', 'other-value', 'kept')] },
  };
}

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-configmap-'));
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

const push = (...flags: string[]) => runCli(['push', tree, '--no-https', '--backup-dir', path.join(dir, 'backups'), ...flags], env);
const writes = () => mirth.writes.map((w) => `${w.method} ${w.path}`);
const serverMap = (): Obj[] => (mirth.config['configurationMap'] as { entry: Obj[] }).entry;
const serverValue = (key: string) => (serverMap().find((e) => e['string'] === key)?.[PROPERTY] as Obj | undefined)?.['value'];
const setEnv = (updates: Record<string, string>) => updateEnvFile(path.join(tree, '.env'), updates);
const configFile = () => path.join(tree, 'server', 'configuration.json');
async function editTreeMap(change: (entries: Obj[]) => Obj[]): Promise<void> {
  const config = JSON.parse(await readFile(configFile(), 'utf8')) as Obj;
  const map = config['configurationMap'] as { entry: Obj[] | Obj };
  map.entry = change(Array.isArray(map.entry) ? map.entry : [map.entry]);
  await writeFile(configFile(), JSON.stringify(config, null, 2));
}
const editChannel = () => writeFile(path.join(tree, 'channels', 'Alpha', 'scripts', 'deploy.js'), '// edited\nreturn;');

describe('push --config-map-key', () => {
  it('plans, backs up and saves only the named key, never printing its value', async () => {
    await setEnv({ CONFIG_MAP__KILL_SWITCH: 'new-switch-value' });
    await editChannel();

    const plan = await push('--config-map-key', 'KILL_SWITCH', '--plan-only', '--json');
    expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      changes: [{ kind: 'configMapKey', op: 'update', id: 'KILL_SWITCH', label: 'KILL_SWITCH' }],
      wouldStop: [],
    });

    const result = await push('--config-map-key', 'KILL_SWITCH', '--yes');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('update  configuration-map key KILL_SWITCH');
    expect(result.stdout).toMatch(/undo with: channelvault restore .*--overwrite-config-map/);
    for (const text of [plan.stdout, plan.stderr, result.stdout, result.stderr]) {
      expect(text).not.toContain('new-switch-value');
      expect(text).not.toContain('old-switch-value');
    }
    // Alone, the flag pushes only the keys: the edited channel stays as it is.
    expect(writes()).toEqual(['PUT /api/server/configurationMap']);
    expect(serverValue('KILL_SWITCH')).toBe('new-switch-value');
    expect(serverMap().map((e) => e['string'])).toEqual(['KILL_SWITCH', 'OTHER']);
    expect(serverMap()[1]).toEqual(entry('OTHER', 'other-value', 'kept'));

    mirth.writes.length = 0;
    const again = await push('--config-map-key', 'KILL_SWITCH', '--yes');
    expect(again.stdout).toContain('configuration-map keys already as in the tree: KILL_SWITCH');
    expect(writes()).toEqual([]);
  });

  it('pushes keys alongside --channel when both are given', async () => {
    await setEnv({ CONFIG_MAP__KILL_SWITCH: 'new-switch-value' });
    await editChannel();
    const result = await push('--config-map-key', 'KILL_SWITCH', '--channel', 'Alpha', '--yes');
    expect(result.status, result.stderr).toBe(0);
    expect(writes()).toEqual(['PUT /api/server/configurationMap', 'PUT /api/channels/c1']);
  });

  it('refuses a key the server changed since the last pull, unless --force', async () => {
    await setEnv({ CONFIG_MAP__KILL_SWITCH: 'new-switch-value' });
    (serverMap()[0]![PROPERTY] as Obj)['value'] = 'edited-in-administrator';

    const refused = await push('--config-map-key', 'KILL_SWITCH', '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('configuration-map key "KILL_SWITCH" changed on the server since the last pull');
    expect(refused.stderr).not.toContain('edited-in-administrator');
    expect(writes()).toEqual([]);

    const forced = await push('--config-map-key', 'KILL_SWITCH', '--yes', '--force');
    expect(forced.status, forced.stderr).toBe(0);
    expect(serverValue('KILL_SWITCH')).toBe('new-switch-value');
  });

  it('adds a new key, and refuses one created on the server meanwhile', async () => {
    await editTreeMap((entries) => [...entries, entry('HL7_TEXT_LEGACY', '{{env:CONFIG_MAP__HL7_TEXT_LEGACY}}', 'kill switch')]);
    await setEnv({ CONFIG_MAP__HL7_TEXT_LEGACY: 'legacy-on' });

    serverMap().push(entry('HL7_TEXT_LEGACY', 'someone-else'));
    const refused = await push('--config-map-key', 'HL7_TEXT_LEGACY', '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('was created on the server since the last pull');
    serverMap().pop();

    const added = await push('--config-map-key', 'HL7_TEXT_LEGACY', '--yes');
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain('create  configuration-map key HL7_TEXT_LEGACY');
    expect(serverMap().map((e) => e['string'])).toEqual(['KILL_SWITCH', 'OTHER', 'HL7_TEXT_LEGACY']);
    expect(serverMap()[2]).toEqual(entry('HL7_TEXT_LEGACY', 'legacy-on', 'kill switch'));
  });

  it('deletes a key the tree no longer has only with --allow-deletes', async () => {
    await editTreeMap((entries) => entries.filter((e) => e['string'] !== 'OTHER'));
    const refused = await push('--config-map-key', 'OTHER', '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--allow-deletes');
    expect(writes()).toEqual([]);

    const deleted = await push('--config-map-key', 'OTHER', '--yes', '--allow-deletes');
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(serverMap().map((e) => e['string'])).toEqual(['KILL_SWITCH']);
  });

  it('rechecks the named key right before the save', async () => {
    await setEnv({ CONFIG_MAP__KILL_SWITCH: 'new-switch-value' });
    // Once the backup exists, reads follow GET /server/id twice: the post-backup
    // check, then the binding check. The second is the read right before the save.
    let afterIdCheck = 0;
    mirth.onRequest = (request) => {
      const previous = mirth.requests.at(-2);
      const backedUp = existsSync(path.join(dir, 'backups')) && readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.xml'));
      if (backedUp && request.method === 'GET' && request.path === '/api/server/configuration' && previous?.path === '/api/server/id') {
        afterIdCheck += 1;
        if (afterIdCheck === 2) (serverMap()[0]![PROPERTY] as Obj)['value'] = 'edited-during-push';
      }
    };
    const result = await push('--config-map-key', 'KILL_SWITCH', '--yes');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed on the server just before saving the configuration map: configuration-map key "KILL_SWITCH"');
    expect(writes()).toEqual([]);
    expect(serverValue('KILL_SWITCH')).toBe('edited-during-push');
  });

  it('refuses without a baseline on this machine (pulled elsewhere, or by an older version) unless --force', async () => {
    await rm(path.join(process.env.CHANNELVAULT_CONFIG_DIR!, BASELINES_DIR), { recursive: true, force: true });
    await setEnv({ CONFIG_MAP__KILL_SWITCH: 'new-switch-value' });

    const refused = await push('--config-map-key', 'KILL_SWITCH', '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('no configuration-map baseline for this installation on this machine');

    const forced = await push('--config-map-key', 'KILL_SWITCH', '--yes', '--force');
    expect(forced.status, forced.stderr).toBe(0);
    expect(serverValue('KILL_SWITCH')).toBe('new-switch-value');
  });

  it('keeps the baseline out of the tree and its values out of every file it writes', async () => {
    const meta = await readFile(path.join(tree, 'channelvault.json'), 'utf8');
    expect(meta).not.toContain('configMap');
    const dirOf = path.join(process.env.CHANNELVAULT_CONFIG_DIR!, BASELINES_DIR);
    const stored = readdirSync(dirOf).map((f) => readFileSync(path.join(dirOf, f), 'utf8')).find((text) => text.includes(mirth.serverId));
    expect(stored).toBeDefined();
    expect(stored).not.toContain('old-switch-value');
    expect(stored).not.toContain('other-value');
  });

  // Mirth returns the map in its own order, and the tree may list a new key anywhere.
  it('leaves diff and a plain push clean after adding a key in the middle of the map', async () => {
    await editTreeMap((entries) => [entries[0]!, entry('HL7_TEXT_LEGACY', '{{env:CONFIG_MAP__HL7_TEXT_LEGACY}}'), ...entries.slice(1)]);
    await setEnv({ CONFIG_MAP__HL7_TEXT_LEGACY: 'legacy-on' });
    const added = await push('--config-map-key', 'HL7_TEXT_LEGACY', '--yes');
    expect(added.status, added.stderr).toBe(0);
    expect(serverMap().map((e) => e['string'])).toEqual(['KILL_SWITCH', 'OTHER', 'HL7_TEXT_LEGACY']);

    const diff = await runCli(['diff', tree, '--no-https'], env);
    expect(diff.status, diff.stdout + diff.stderr).toBe(0);
    const plan = await push('--plan-only', '--json');
    expect(JSON.parse(plan.stdout)).toMatchObject({ changes: [], notPushed: [] });
  });

  it('refuses an unknown key, and --whole-server with keys', async () => {
    const unknown = await push('--config-map-key', 'NOPE', '--plan-only');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no configuration-map key named "NOPE"');
    const whole = await push('--config-map-key', 'KILL_SWITCH', '--whole-server', '--plan-only');
    expect(whole.status).toBe(1);
    expect(whole.stderr).toContain('--config-map-key');
  });

  it('points a plain scoped push at --config-map-key when the map differs', async () => {
    await setEnv({ CONFIG_MAP__KILL_SWITCH: 'new-switch-value' });
    const plan = await push('--plan-only');
    expect(plan.stdout).toContain('--config-map-key for named configuration-map keys');
  });
});
