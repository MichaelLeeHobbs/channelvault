import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsOf } from '../src/push/index.js';
import type { Profile } from '../src/profiles.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';
import { printedUndoArgs, runCli, startCli } from './helpers/cli.js';

const PASSWORD = 'gov-password-1234';
let dir: string, config: string, tree: string, mirth: FakeMirth;
let profiles: Record<string, Profile>;
let credentials: Record<string, string>;
// No MIRTH_* login from the developer's shell: only what each test sets.
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-profile-'));
  config = path.join(dir, 'config');
  tree = path.join(dir, 'tree');
  mirth = await startFakeMirth({ '@version': '4.5.2', channels: { channel: [
    { id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;', password: 'channel-secret-value' },
  ] } });
  profiles = {};
  credentials = {};
  env = { CHANNELVAULT_CONFIG_DIR: config, MIRTH_PROFILE: '', MIRTH_HOST: '', MIRTH_PORT: '', MIRTH_USER: '', MIRTH_PASS: '', MIRTH_TLS_FINGERPRINT: '' };
  await saveProfile('gov');
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function saveProfile(name: string, over: Partial<Profile> = {}, password: string | null = PASSWORD) {
  profiles[name] = { host: '127.0.0.1', port: mirth.port, user: 'u', https: false, serverId: mirth.serverId, ...over };
  if (password === null) delete credentials[name];
  else credentials[name] = password;
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, 'profiles.json'), JSON.stringify({ profiles }));
  await writeFile(path.join(config, 'credentials'), Object.entries(credentials).map(([k, v]) => `${k}=${v}\n`).join(''));
}
const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => runCli(args, { ...env, ...extra });
const backupDir = () => path.join(dir, 'backups');
async function pulled() {
  const r = await run(['pull', tree, '--profile', 'gov']);
  expect(r.status, r.stderr).toBe(0);
  return r;
}
const editAlpha = () => writeFile(path.join(tree, 'channels', 'Alpha', 'scripts', 'deploy.js'), 'edited();');

describe('reading with a profile', () => {
  it('pulls with --profile, names the connection, and never prints the password', async () => {
    const r = await pulled();
    expect(r.stderr).toContain(`connection: profile gov, http://127.0.0.1:${mirth.port} as u, installation ${mirth.serverId}, chosen by typed --profile, password from credentials`);
    expect(r.stdout + r.stderr).not.toContain(PASSWORD);
    expect(JSON.parse(await readFile(path.join(tree, 'channelvault.json'), 'utf8')).serverId).toBe(mirth.serverId);
  });

  it("lets the tree's serverId pick the profile for reads", async () => {
    await pulled();
    const diff = await run(['diff', tree]);
    expect(diff.status, diff.stderr).toBe(0);
    expect(diff.stderr).toContain("chosen by the tree's serverId");
    const json = await run(['diff', tree, '--json']);
    const out = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(out.serverId).toBe(mirth.serverId);
    expect(out.connection).toMatchObject({ profile: 'gov', source: 'tree', passwordSource: 'credentials' });
    expect(json.stderr).toBe('');
  });

  it('reports offline which profile status would use, and whether its password is set', async () => {
    await pulled();
    let status = JSON.parse((await run(['status', tree, '--json'])).stdout) as { connection: Record<string, unknown>; serverId: string };
    expect(status.serverId).toBe(mirth.serverId);
    expect(status.connection).toMatchObject({ profile: 'gov', source: 'tree', passwordConfigured: true });
    await saveProfile('gov', {}, null);
    status = JSON.parse((await run(['status', tree, '--json'])).stdout);
    expect(status.connection).toMatchObject({ profile: 'gov', passwordConfigured: false });
  });

  it('fails without a connection, listing profiles and not suggesting --pass', async () => {
    const r = await run(['backup']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[no-connection]');
    expect(r.stderr).toContain('profiles: gov');
    expect(r.stderr).not.toContain('--pass');
  });

  it('refuses a profile whose server answers as another installation', async () => {
    await saveProfile('gov', { serverId: 'some-other-installation' });
    const r = await run(['pull', tree, '--profile', 'gov']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[server-mismatch]');
    expect(existsSync(tree)).toBe(false);
  });

  it('refuses MIRTH_HOST for a tree or a server that belongs to a profile', async () => {
    await pulled();
    const login = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
    const offline = await run(['diff', tree], login);
    expect(offline.status).toBe(2);
    expect(offline.stderr).toContain('[env-shadowed]');
    const online = await run(['backup', '--no-https', '--backup-dir', backupDir()], login);
    expect(online.status).toBe(1);
    expect(online.stderr).toContain('[env-shadowed]');
  });
});

describe('writing with a profile (W2)', () => {
  it("refuses a push the tree's serverId selected, and pushes with a typed --profile", async () => {
    await pulled();
    await editAlpha();
    const untyped = await run(['push', tree, '--yes', '--backup-dir', backupDir()]);
    expect(untyped.status).toBe(1);
    expect(untyped.stderr).toContain('[profile-not-typed]');
    expect(untyped.stderr).toContain('--profile gov');
    expect(mirth.writes).toEqual([]);
    const planned = await run(['push', tree, '--plan-only']);
    expect(planned.status, planned.stderr).toBe(0);

    const typed = await run(['push', tree, '--profile', 'gov', '--yes', '--backup-dir', backupDir()]);
    expect(typed.status, typed.stderr).toBe(0);
    const undo = printedUndoArgs(typed.stdout);
    expect(undo).toEqual(expect.arrayContaining(['--profile', 'gov']));
    expect(undo).not.toContain('--host');
    expect(undo).not.toContain('--yes');
    const restored = await run([...undo, '--yes']);
    expect(restored.status, restored.stderr).toBe(0);
    expect(channelsOf(mirth.config)[0]!.deployScript).toBe('return;');
  });

  it('lets MIRTH_PROFILE select a push only when it is confirmed at a terminal', async () => {
    await pulled();
    await editAlpha();
    const scripted = await run(['push', tree, '--yes', '--backup-dir', backupDir()], { MIRTH_PROFILE: 'gov' });
    expect(scripted.status).toBe(1);
    expect(scripted.stderr).toContain('[profile-not-typed]');
    const running = startCli(['push', tree, '--backup-dir', backupDir()], { ...env, MIRTH_PROFILE: 'gov' }, true);
    await running.waitFor('Continue?');
    running.child.stdin.end('y\n');
    const confirmed = await running.finished;
    expect(confirmed.status, confirmed.stderr).toBe(0);
    expect(confirmed.stderr).toContain('chosen by MIRTH_PROFILE');
    expect(confirmed.stdout).toContain('profile gov');
  });

  it('adopts only through an explicit profile or login', async () => {
    await pulled();
    const r = await run(['adopt', tree, '--plan-only']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[no-connection]');
    const typed = await run(['adopt', tree, '--plan-only', '--profile', 'gov']);
    expect(typed.status, typed.stderr).toBe(0);
    await rm(path.join(config, 'profiles.json'));
    const login = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
    const fromEnv = await run(['adopt', tree, '--yes', '--no-https'], login);
    expect(fromEnv.status).toBe(1);
    expect(fromEnv.stderr).toContain('[connection-not-typed]');
    const withHost = await run(['adopt', tree, '--yes', '--no-https', '--host', '127.0.0.1'], login);
    expect(withHost.status, withHost.stderr).toBe(0);
  });
});

describe('safety on every source', () => {
  it('refuses to pull a tree from another installation, and diff against one', async () => {
    await pulled();
    const before = await readFile(path.join(tree, 'channelvault.json'), 'utf8');
    const other = await startFakeMirth({ '@version': '4.5.2', channels: { channel: [] } });
    try {
      const login = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(other.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
      // MIRTH_HOST itself is allowed here only because no profile names this tree.
      await rm(path.join(config, 'profiles.json'));
      const pull = await run(['pull', tree, '--no-https'], login);
      expect(pull.status).toBe(1);
      expect(pull.stderr).toContain('[installation-mismatch]');
      expect(await readFile(path.join(tree, 'channelvault.json'), 'utf8')).toBe(before);
      const diff = await run(['diff', tree, '--no-https'], login);
      expect(diff.status).toBe(2);
      expect(diff.stderr).toContain('[installation-mismatch]');
    } finally {
      await other.close();
    }
  });

  it('scrubs the connection password from stdout and error text', async () => {
    channelsOf(mirth.config)[0]!.name = `Named ${PASSWORD}`;
    channelsOf(mirth.config)[0]!.description = 'x';
    await pulled();
    const [channelDir] = await readdir(path.join(tree, 'channels'));
    await writeFile(path.join(tree, 'channels', channelDir!, 'scripts', 'deploy.js'), 'edited();');
    const plan = await run(['push', tree, '--plan-only']);
    expect(plan.stdout).toContain('update  channel Named <redacted>');
    expect(plan.stdout + plan.stderr).not.toContain(PASSWORD);
    mirth.onRequest = req => (req.path === '/api/server/configuration' ? { status: 500, raw: `failed for password ${PASSWORD}` } : undefined);
    const failed = await run(['diff', tree], { CHANNELVAULT_DEBUG: '1' });
    expect(failed.status).toBe(2);
    expect(failed.stderr).not.toContain(PASSWORD);
  });
});

describe("a profile's env file", () => {
  it('holds the secrets for every checkout of the tree, and refuses a different local .env', async () => {
    const shared = path.join(dir, 'secrets', 'gov.env');
    await saveProfile('gov', { dotenv: shared });
    const pull = await pulled();
    expect(pull.stdout).toContain(`in ${shared}`);
    expect(await readFile(shared, 'utf8')).toContain('channel-secret-value');
    expect(existsSync(path.join(tree, '.env'))).toBe(false);

    // A second worktree: the same committed files, no .env of its own.
    const worktree = path.join(dir, 'worktree');
    await cp(tree, worktree, { recursive: true });
    const diff = await run(['diff', worktree]);
    expect(diff.status, diff.stdout + diff.stderr).toBe(0);
    expect(diff.stderr).toContain(`env file ${shared}`);

    await writeFile(path.join(worktree, '.env'), 'OTHER=1\n');
    const ambiguous = await run(['diff', worktree]);
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toContain('[env-ambiguous]');
    const chosen = await run(['diff', worktree, '--dotenv', shared]);
    expect(chosen.status, chosen.stderr).toBe(0);
  });

  it('refuses to read it while another checkout is replacing it', async () => {
    const shared = path.join(dir, 'secrets', 'gov.env');
    await saveProfile('gov', { dotenv: shared });
    await pulled();
    const copy = `${shared}.channelvault-${randomUUID()}.next`;
    await writeFile(copy, 'X=1\n');
    const busy = await run(['diff', tree]);
    expect(busy.status).toBe(2);
    expect(busy.stderr).toContain('[env-busy]');
    await rm(copy);
    expect((await run(['diff', tree])).status).toBe(0);
  });

  it('retries a pull interrupted while replacing it in one run', async () => {
    const shared = path.join(dir, 'secrets', 'gov.env');
    await saveProfile('gov', { dotenv: shared });
    await pulled();
    // What an interrupted pull leaves once its swap completed: a committed journal naming the env file.
    await writeFile(path.join(tree, '.channelvault-transaction.json'), JSON.stringify({ version: 1, id: randomUUID(), state: 'committed', envFile: await realpath(shared), entries: [] }));
    const retry = await run(['pull', tree, '--profile', 'gov']);
    expect(retry.status, retry.stderr).toBe(0);
    expect(existsSync(path.join(tree, '.channelvault-transaction.json'))).toBe(false);
  });
});

describe('profile commands', () => {
  it('lists profiles without passwords', async () => {
    const r = await run(['profile', 'list', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { profiles: Array<Record<string, unknown>> };
    expect(out.profiles).toEqual([expect.objectContaining({ name: 'gov', url: `http://127.0.0.1:${mirth.port}`, serverId: mirth.serverId, passwordConfigured: true })]);
    expect(r.stdout).not.toContain(PASSWORD);
  });

  it('checks each profile by logging in, and names the failures', async () => {
    await saveProfile('stale', { serverId: 'reinstalled' });
    await saveProfile('nopass', {}, null);
    const r = await run(['profile', 'check', '--json']);
    expect(r.status).toBe(1);
    const results = (JSON.parse(r.stdout) as { profiles: Array<{ name: string; ok: boolean; problem: string | null }> }).profiles;
    expect(results.find(p => p.name === 'gov')).toMatchObject({ ok: true });
    expect(results.find(p => p.name === 'stale')?.problem).toContain('[server-mismatch]');
    expect(results.find(p => p.name === 'nopass')?.problem).toContain('[no-password]');
  });

  it('adds a profile at a terminal, recording its installation', async () => {
    const running = startCli(['profile', 'add', 'local', '--host', '127.0.0.1', '--port', String(mirth.port), '--user', 'u', '--no-https'], env, true);
    await running.waitFor('right server?');
    running.child.stdin.write('y\n');
    await running.waitFor('Password for u');
    running.child.stdin.end('local-password-99\n');
    const r = await running.finished;
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('local-password-99');
    const saved = JSON.parse(await readFile(path.join(config, 'profiles.json'), 'utf8')) as { profiles: Record<string, Profile> };
    expect(saved.profiles.local).toEqual({ host: '127.0.0.1', port: mirth.port, user: 'u', https: false, serverId: mirth.serverId });
    expect(await readFile(path.join(config, 'credentials'), 'utf8')).toContain('local=local-password-99');
  });

  it('refuses short passwords, and the terminal-only commands without a terminal', async () => {
    const running = startCli(['profile', 'set-password', 'gov'], env, true);
    await running.waitFor('New password');
    running.child.stdin.end('short\n');
    const weak = await running.finished;
    expect(weak.status).toBe(1);
    expect(weak.stderr).toContain('[weak-password]');
    for (const args of [['profile', 'add', 'x', '--host', 'h', '--port', '1', '--user', 'u'], ['profile', 'set-password', 'gov'], ['profile', 'repin', 'gov']]) {
      const r = await run(args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[no-terminal]');
    }
  });

  it('refuses a non-loopback profile that turns certificate checks off', async () => {
    const r = await run(['profile', 'add', 'x', '--host', 'mirth.example', '--port', '8443', '--user', 'u', '--insecure'], { ...env });
    expect(r.stderr).toContain('[no-terminal]');
    await writeFile(path.join(config, 'profiles.json'), JSON.stringify({ profiles: { x: { host: 'mirth.example', port: 8443, user: 'u', insecure: true } } }));
    const list = await run(['profile', 'list']);
    expect(list.status).toBe(1);
    expect(list.stderr).toContain('[profiles-invalid]');
    expect(list.stderr).toContain('insecure is refused');
  });
});
