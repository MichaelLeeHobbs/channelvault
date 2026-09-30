import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelsOf, librariesOf, templatesOf } from '../src/push/index.js';
import type { CanonicalConfig } from '../src/types.js';
import { startFakeMirth, type FakeMirth, type FakeResponse } from './helpers/fakeMirth.js';
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
const pushArgs = (...flags: string[]) => ['push', tree, '--no-https', '--backup-dir', path.join(dir, 'backups'), ...flags];
const writes = () => mirth.writes.map(w => `${w.method} ${w.path}`);
const meta = async () => JSON.parse(await readFile(path.join(tree, 'channelvault.json'), 'utf8')) as { resources: { channels: Record<string, number> } };

describe('CLI push backup', () => {
  it('plans and creates a copied channel with a new ID without a manual skeleton reference', async () => {
    const folder = path.join(tree, 'channels', 'Delta');
    await cp(path.join(tree, 'channels', 'Alpha'), folder, { recursive: true });
    const file = path.join(folder, 'channel.json');
    const channel = JSON.parse(await readFile(file, 'utf8'));
    channel.id = 'c4'; channel.name = 'Delta'; channel.revision = 0;
    await writeFile(file, JSON.stringify(channel));
    const preview = await runCli(pushArgs('--plan-only', '--json'), env);
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).changes).toEqual([{ kind: 'channel', op: 'create', id: 'c4', label: 'Delta' }]);
    expect(mirth.writes).toEqual([]);
    const result = await runCli(pushArgs('--yes'), env);
    expect(result.status, result.stderr).toBe(0);
    expect(channelsOf(mirth.config).map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    mirth.writes.length = 0;
    expect((await runCli(pushArgs('--yes'), env)).stdout).toContain('nothing to push');
    expect(mirth.writes).toEqual([]);
  });

  const backupFiles = async () => (existsSync(path.join(dir, 'backups')) ? (await readdir(path.join(dir, 'backups'))).filter((f) => f.endsWith('.xml')) : []);

  it('backs up the server before changing it, as it was before the push', async () => {
    await edit('Alpha');
    const pushed = await runCli(pushArgs('--yes'), env);
    expect(pushed.status, pushed.stderr).toBe(0);
    const [file] = await backupFiles();
    expect(file).toMatch(new RegExp(`^127-0-0-1-${mirth.port}-\\d{8}T\\d{6}Z\\.xml$`));
    expect(pushed.stdout).toContain('undo with: channelvault restore');
    const saved = await readFile(path.join(dir, 'backups', file!), 'utf8');
    expect(saved).toContain('<deployScript>return;</deployScript>');
    expect(saved).not.toContain('Alpha edited');
  });

  it('backs up before a --whole-server replace too', async () => {
    await edit('Alpha');
    const pushed = await runCli(pushArgs('--yes', '--whole-server'), env);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(await backupFiles()).toHaveLength(1);
  });

  it('takes no backup when the push is declined at the prompt', async () => {
    await edit('Alpha');
    const running = startCli(pushArgs(), env, true);
    try {
      await running.waitFor('Continue?');
      running.child.stdin.end('n\n');
      expect((await running.finished).stdout).toContain('aborted.');
      expect(await backupFiles()).toEqual([]);
    } finally { running.child.kill(); }
  });

  it('takes no backup with --no-backup, or when nothing is pushed', async () => {
    expect((await runCli(pushArgs('--yes'), env)).stdout).toContain('nothing to push');
    await edit('Alpha');
    expect((await runCli(pushArgs('--yes', '--no-backup'), env)).status).toBe(0);
    expect(await backupFiles()).toEqual([]);
  });
});

describe('CLI failure output', () => {
  /** Pull a DICOM credential into the env file, then make the next channel save fail with `respond(credential)`. */
  async function rejectEchoing(passcode: string, response: FakeResponse, extraEnv: NodeJS.ProcessEnv = {}) {
    const channels = channelsOf(mirth.config);
    channels[0]!['destinationConnectors'] = { connector: [{ metaDataId: 1, name: 'DICOM', properties: { passcode } }] };
    mirth.config['channels'] = { channel: channels };
    const pulled = await runCli(['pull', tree, '--no-https'], env);
    expect(pulled.status, pulled.stderr).toBe(0);
    expect(await readFile(path.join(tree, 'channels', 'Alpha', 'channel.json'), 'utf8')).toContain('{{env:');
    await edit('Alpha');
    mirth.onRequest = req => req.method === 'PUT' && req.path === '/api/channels/c1' ? response : undefined;
    const pushed = await runCli(pushArgs('--yes'), { ...env, ...extraEnv });
    expect(pushed.status).toBe(1);
    return pushed;
  }
  /** No 12-character run of the credential is printed, so no fragment of a truncated or reformatted echo either. */
  const expectNoFragment = (printed: string, passcode: string) => {
    for (let i = 0; i + 12 <= passcode.length; i += 1) expect(printed).not.toContain(passcode.slice(i, i + 12));
  };

  it('withholds the server response by default', async () => {
    const passcode = 'fixture-passcode-924';
    const pushed = await rejectEchoing(passcode, { status: 400, raw: `rejected value ${passcode} for DICOM` });
    expect(pushed.stderr).toContain('server response withheld');
    expectNoFragment(pushed.stdout + pushed.stderr, passcode);
  });

  // With CHANNELVAULT_DEBUG the body is shown, so the CLI's scrub of known
  // values must catch every way a server can echo one. A sentence, not a
  // credential field, so field-name redaction cannot help.
  const escaped = 'fixture"pass\\code&<924>'; // characters JSON and XML escape
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unicodeEscaped = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const long = `fixture-long-${'a1b2c3d4e5'.repeat(40)}`; // longer than any message truncation
  it.each<[string, string, FakeResponse]>([
    ['plain text', escaped, { status: 400, raw: `rejected value ${escaped} for DICOM` }],
    ['a JSON sentence', escaped, { status: 400, body: { error: `rejected value ${escaped} for DICOM` } }],
    ['an XML sentence', escaped, { status: 400, raw: `<error><message>rejected value ${xml(escaped)} for DICOM</message></error>` }],
    ['a JSON string of \\u escapes', escaped, { status: 400, raw: `"rejected value ${unicodeEscaped(escaped)} for DICOM"` }],
    ['a sentence with a 400-character credential', long, { status: 400, raw: `rejected value ${long} for DICOM` }],
    ['a sentence whose credential has double spaces', 'fixture  double  925', { status: 400, raw: 'rejected value fixture  double  925 for DICOM' }],
  ])('with CHANNELVAULT_DEBUG, redacts a credential echoed in %s', async (_format, passcode, response) => {
    const pushed = await rejectEchoing(passcode, response, { CHANNELVAULT_DEBUG: '1' });
    expect(pushed.stderr).toContain('rejected value <redacted> for DICOM');
    expectNoFragment(pushed.stdout + pushed.stderr, passcode);
  });
});

describe('CLI pull preflight', () => {
  it('refuses an env file inside a directory it replaces, writing nothing', async () => {
    const fresh = path.join(dir, 'fresh');
    const envFile = path.join(fresh, 'channels', 'runtime.env');
    const r = await runCli(['pull', fresh, '--no-https', '--dotenv', envFile], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is inside channels/');
    expect(existsSync(fresh)).toBe(false);
  });

  it('refuses an env file whose name merely starts with two dots', async () => {
    const fresh = path.join(dir, 'fresh');
    const r = await runCli(['pull', fresh, '--no-https', '--dotenv', path.join(fresh, 'channels', '..runtime.env')], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is inside channels/');
  });

  it('refuses an env file reached through a directory link inside a replaced directory', async () => {
    const fresh = path.join(dir, 'fresh');
    const outside = path.join(dir, 'envstore');
    await mkdir(outside);
    await mkdir(path.join(fresh, 'channels'), { recursive: true });
    await writeFile(path.join(fresh, 'channelvault.json'), JSON.stringify({ source: 'http://example' }));
    // A junction needs no privileges on Windows; elsewhere it is a symlink.
    await symlink(outside, path.join(fresh, 'channels', 'envstore'), 'junction');
    const r = await runCli(['pull', fresh, '--no-https', '--dotenv', path.join(fresh, 'channels', 'envstore', 'runtime.env')], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is inside channels/');
    expect(existsSync(path.join(fresh, 'channels', 'envstore'))).toBe(true);
  });

  it('refuses unreadable metadata before touching the tree', async () => {
    await edit('Alpha');
    await writeFile(path.join(tree, 'channelvault.json'), '{"tool": "channel');
    const requestsBefore = mirth.requests.length;
    const r = await runCli(['pull', tree, '--no-https'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('channelvault.json is unreadable or not channelvault metadata');
    expect(await readFile(path.join(tree, 'channels', 'Alpha', 'scripts', 'deploy.js'), 'utf8')).toBe('// Alpha edited\nreturn;');
    expect(mirth.requests.length).toBe(requestsBefore); // refused before connecting
  });
});

describe('CLI partial pushes', () => {
  it.each(['delete', 'update', 'global', 'whole-server'])('refuses %s changes made during backup before any mutation', async kind => {
    if (kind === 'delete') await rm(path.join(tree, 'channels', 'Alpha'), { recursive: true });
    else if (kind === 'global') {
      const file = path.join(tree, 'server', 'configuration.json');
      const json = JSON.parse(await readFile(file, 'utf8'));
      json.globalScripts = { entry: [{ string: ['Deploy', 'local();'] }] };
      await writeFile(file, JSON.stringify(json));
    } else await edit('Alpha');
    let idReads = 0;
    mirth.onRequest = req => {
      if (req.path === '/api/server/id' && ++idReads === 2) {
        if (kind === 'global') mirth.config.globalScripts = { entry: [{ string: ['Deploy', 'colleague();'] }] };
        else { channelsOf(mirth.config)[0]!.revision = 2; channelsOf(mirth.config)[0]!.deployScript = 'colleague();'; }
      }
    };
    const flags = kind === 'delete' ? ['--allow-deletes'] : kind === 'whole-server' ? ['--whole-server'] : kind === 'global' ? ['--global-scripts'] : [];
    const result = await runCli(pushArgs('--yes', ...flags), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('during backup');
    expect(mirth.writes).toEqual([]);
  });

  it('checks a deletion again after an earlier save in the same push', async () => {
    await edit('Alpha');
    await rm(path.join(tree, 'channels', 'Beta'), { recursive: true });
    mirth.onRequest = req => {
      if (req.method === 'PUT' && req.path === '/api/channels/c1') {
        channelsOf(mirth.config)[1]!.revision = 2;
        channelsOf(mirth.config)[1]!.deployScript = 'colleague();';
      }
    };
    const result = await runCli(pushArgs('--yes', '--allow-deletes'), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Beta changed on the server during the push');
    expect(writes()).toEqual(['PUT /api/channels/c1']);
    expect(channelsOf(mirth.config)[1]!.deployScript).toBe('colleague();');
  });

  it('requires deletion consent for a resource appearing during a forced whole-server backup', async () => {
    await edit('Alpha');
    let idReads = 0;
    mirth.onRequest = req => {
      if (req.path === '/api/server/id' && ++idReads === 2) mirth.config.channels = { channel: [...channelsOf(mirth.config), { id: 'c4', name: 'Created During Backup', revision: 1 }] };
    };
    const result = await runCli(pushArgs('--yes', '--whole-server', '--force'), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--allow-deletes');
    expect(mirth.writes).toEqual([]);
  });

  it('refuses a channel removed after backup instead of recreating it', async () => {
    await edit('Alpha');
    mirth.onRequest = req => {
      if (req.method === 'GET' && req.path === '/api/channels/c1') mirth.config.channels = { channel: channelsOf(mirth.config).slice(1) };
    };
    const result = await runCli(pushArgs('--yes'), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed on the server during the push');
    expect(mirth.writes).toEqual([]);
  });
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
      if (req.method === 'PUT') return { status: 503, body: 'save refused' }; // withheld: only the status shows
      if (req.path === '/api/server/configuration' && mirth.writes.length) return { status: 502, body: 'refresh unavailable' };
    };
    const failed = await runCli(pushArgs('--yes'), env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('applied 0 of 1; update Alpha failed');
    expect(failed.stderr).toContain('HTTP 503');
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

  it.each(['backup', 'save', 'previous redeploy'])('skips an operator undeploy during %s', async when => {
    await Promise.all(['Alpha', 'Beta'].map(edit));
    mirth.deployed = new Set(['c1', 'c2']);
    let idReads = 0;
    mirth.onRequest = req => {
      if ((when === 'backup' && req.path === '/api/server/id' && ++idReads === 2) ||
          (when === 'save' && req.method === 'PUT' && req.path === '/api/channels/c2') ||
          (when === 'previous redeploy' && req.path === '/api/channels/c1/_deploy')) {
        mirth.deployed.delete('c2');
      }
    };
    const result = await runCli(pushArgs('--yes', '--deploy'), env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('deployed 1 of 2');
    expect(result.stdout).toContain('redeploy skipped (no longer deployed): Beta');
    expect(writes().filter(w => w.startsWith('POST'))).toEqual(['POST /api/channels/c1/_deploy']);
    expect(mirth.deployed.has('c2')).toBe(false);
    expect((await meta()).resources.channels).toEqual({ c1: 2, c2: 2, c3: 1 });
  });

  it('refuses redeployment when its current status cannot be read', async () => {
    await edit('Alpha');
    mirth.deployed.add('c1');
    let reads = 0;
    mirth.onRequest = req => {
      if (req.path === '/api/channels/statuses' && ++reads > 1) return { status: 503, body: 'status unavailable' };
    };
    const result = await runCli(pushArgs('--yes', '--deploy'), env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('pushed 1 change(s)');
    expect(result.stderr).toContain('deploy failed: Alpha');
    expect(writes()).toEqual(['PUT /api/channels/c1']);
  });
});

describe('template and library checks immediately before saving', () => {
  async function setupLibrary() {
    mirth.config.codeTemplateLibraries = { codeTemplateLibrary: [{
      id: 'L1', name: 'Helpers', revision: 1, codeTemplates: { codeTemplate: [
        { id: 't1', name: 'one', revision: 1, properties: { code: 'function one() {}' } },
        { id: 't2', name: 'two', revision: 1, properties: { code: 'function two() {}' } },
      ] },
    }] };
    expect((await runCli(['pull', tree, '--no-https'], env)).status).toBe(0);
  }
  it.each([false, true])('retains server-only members during a library save and converges (force=%s)', async force => {
    await setupLibrary();
    const lib = librariesOf(mirth.config)[0]!;
    lib.codeTemplates = { codeTemplate: [...templatesOf(lib), { id: 't9', name: 'theirs', revision: 1, properties: { code: 'function theirs() {}' } }] };
    if (force) lib.revision = 5;
    const file = path.join(tree, 'codeTemplates', 'Helpers', 'library.json');
    const local = JSON.parse(await readFile(file, 'utf8'));
    local.description = 'my settings edit';
    local.codeTemplates.codeTemplate.push({ id: 't3', name: 'three', revision: 0, properties: { code: 'function three() {}' } });
    await writeFile(file, JSON.stringify(local));
    const result = await runCli(pushArgs('--yes', '--library', 'Helpers', ...(force ? ['--force'] : [])), env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('left alone');
    expect(templatesOf(librariesOf(mirth.config)[0]!).map(t => t.id)).toEqual(['t1', 't2', 't3', 't9']);
    expect(templatesOf(librariesOf(mirth.config)[0]!).find(t => t.id === 't9')!.properties).toEqual({ code: 'function theirs() {}' });
    expect((JSON.parse(await readFile(path.join(tree, 'channelvault.json'), 'utf8'))).resources.codeTemplates).not.toHaveProperty('t9');
    mirth.writes.length = 0;
    const repeat = await runCli(pushArgs('--yes', '--library', 'Helpers'), env);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(repeat.stdout).toContain('nothing to push');
    expect(mirth.writes).toEqual([]);
  });

  it('refuses a library deletion that would detach a newly added server template', async () => {
    await setupLibrary();
    const lib = librariesOf(mirth.config)[0]!;
    lib.codeTemplates = { codeTemplate: [...templatesOf(lib), { id: 't9', name: 'theirs', revision: 1, properties: { code: 'return;' } }] };
    await rm(path.join(tree, 'codeTemplates', 'Helpers'), { recursive: true });
    const result = await runCli(pushArgs('--yes', '--force', '--allow-deletes'), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('contains server-only code templates');
    expect(mirth.writes).toEqual([]);
  });
  it('refuses a template edit with an unchanged revision after the last snapshot', async () => {
    await setupLibrary();
    await writeFile(path.join(tree, 'codeTemplates', 'Helpers', 'one.js'), 'function one() { return 1; }');
    mirth.onRequest = req => {
      if (req.method === 'GET' && req.path === '/api/codeTemplates/t1') {
        templatesOf(librariesOf(mirth.config)[0]!)[0]!.properties = { code: 'function one() { return 2; }' };
      }
    };
    const result = await runCli(pushArgs('--yes', '--library', 'Helpers'), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed on the server during the push');
    expect(mirth.writes).toEqual([]);
  });
  it('refuses deleting a template edited while its library was saved', async () => {
    await setupLibrary();
    const file = path.join(tree, 'codeTemplates', 'Helpers', 'library.json');
    const lib = JSON.parse(await readFile(file, 'utf8'));
    lib.codeTemplates.codeTemplate.pop();
    await writeFile(file, JSON.stringify(lib));
    mirth.onRequest = req => {
      if (req.method === 'PUT' && req.path === '/api/codeTemplateLibraries') {
        const t = templatesOf(librariesOf(mirth.config)[0]!)[1]!;
        t.revision = 2; t.properties = { code: 'colleague();' };
      }
    };
    const result = await runCli(pushArgs('--yes', '--library', 'Helpers', '--allow-deletes'), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed on the server during the push');
    expect(writes()).toEqual(['PUT /api/codeTemplateLibraries']);
  });
  it('rechecks the whole library list after creating a template', async () => {
    await setupLibrary();
    const file = path.join(tree, 'codeTemplates', 'Helpers', 'library.json');
    const lib = JSON.parse(await readFile(file, 'utf8'));
    lib.codeTemplates.codeTemplate.push({ id: 't3', name: 'three', revision: 0, properties: { code: 'function three() {}' } });
    await writeFile(file, JSON.stringify(lib));
    let added = false;
    mirth.onRequest = req => {
      if (!added && req.method === 'GET' && req.path === '/api/server/configuration' && mirth.writes.length) {
        added = true;
        mirth.config.codeTemplateLibraries = { codeTemplateLibrary: [...librariesOf(mirth.config), { id: 'L2', name: 'Added Meanwhile', revision: 1 }] };
      }
    };
    const result = await runCli(pushArgs('--yes', '--library', 'Helpers'), env);
    expect(result.status).toBe(1);
    expect(added).toBe(true);
    expect(result.stderr).toContain('library list is saved as a whole');
    expect(writes()).toEqual(['PUT /api/codeTemplates/t3']);
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

  it.each([
    [[], 'configuration map differs but is kept'],
    [['--overwrite-config-map'], 'also replaced: configurationMap'],
  ])('says whether a whole-server push replaces the configuration map (%j)', async (flags, expected) => {
    mirth.config['configurationMap'] = { entry: [] };
    const running = startCli(pushArgs('--whole-server', ...flags), env, true);
    try {
      await running.waitFor('Continue?');
      running.child.stdin.end('n\n');
      const result = await running.finished;
      expect(result.stdout).toContain(expected);
      expect(result.stdout).not.toContain(flags.length ? 'is kept' : 'also replaced');
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
