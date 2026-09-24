import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanSecrets, type SecretKind } from '../src/secrets/detect.js';
import { backupEnvFile, ENV_BACKUPS_KEPT } from '../src/secrets/envfile.js';
import { render } from '../src/secrets/index.js';
import { XmlConfigAdapter } from '../src/xml/index.js';
import type { CanonicalConfig, Json } from '../src/types.js';

type Obj = Record<string, Json>;

/** One channel whose deploy script is `script`. */
const withScript = (script: string): CanonicalConfig => ({
  channels: { channel: [{ id: 'c1', name: 'Lab Feed', deployScript: script }] },
});
const scriptOf = (c: CanonicalConfig): string => (((c['channels'] as Obj)['channel'] as Obj[])[0]!['deployScript'] as string);

describe('scanSecrets', () => {
  // Each sample is built at runtime so no token-shaped literal sits in the repo.
  const aws = 'AKIA' + 'Q'.repeat(16);
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'c2lnbmF0dXJlLXBhcnQ'].join('.');
  const github = 'ghp_' + 'a1'.repeat(15);
  const slack = 'xoxb-' + '1234567890-abcdef';
  const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join('\n');

  it.each<[SecretKind, string, string]>([
    ['url-credentials', 'var u = "sftp://svc:s3cretPw@files.example.org/in";', 's3cretPw'],
    ['connection-string', 'var c = "jdbc:sqlserver://db;user=svc;password=s3cretPw;encrypt=true";', 's3cretPw'],
    ['authorization-header', "headers.put('Authorization', 'Basic c3ZjOnMzY3JldFB3');", 'c3ZjOnMzY3JldFB3'],
    ['assignment', "var password = 's3cretPw';", 's3cretPw'],
    ['assignment', '{"apiKey": "k-12345678"}', 'k-12345678'],
    ['db-connection-call', "var db = DatabaseConnectionFactory.createDatabaseConnection(driver, url, 'svc', 's3cretPw');", 's3cretPw'],
    ['aws-access-key', `var k = '${aws}';`, aws],
    ['jwt', `var t = "${jwt}";`, jwt],
    ['github-token', `var g = '${github}';`, github],
    ['slack-token', `var s = '${slack}';`, slack],
    ['private-key', `var pem = \`${key}\`;`, key],
  ])('finds %s and extracts only the secret', (kind, script, secret) => {
    const found = scanSecrets(withScript(script), { mode: 'find' });
    expect(found.findings.map((f) => f.kind)).toContain(kind);
    expect(scriptOf(found.config)).toBe(script); // find mode changes nothing

    const extracted = scanSecrets(withScript(script), { mode: 'extract' });
    const out = scriptOf(extracted.config);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/\{\{env:LAB_FEED__DEPLOYSCRIPT__[A-Z_]+\}\}/);
    expect(Object.values(extracted.envUpdates)).toContain(secret);
    // Filling the placeholder back in restores the original exactly.
    expect(scriptOf(render(extracted.config, extracted.envUpdates))).toBe(script);
  });

  it.each([
    ['a Mirth variable in a URL', 'var u = "sftp://svc:${sftpPassword}@files.example.org";'],
    ['a Mirth variable in a connection string', 'var c = "jdbc:x;password=${dbPassword}";'],
    ['a placeholder', "var password = '{{env:DB_PASSWORD}}';"],
    ['a password read from config', "var password = $cfg('db.password');"],
    ['an empty assignment', "var password = '';"],
    ['a word that merely contains token', "var tokenizer = 'whitespace';"],
  ])('ignores %s', (_label, script) => {
    expect(scanSecrets(withScript(script), { mode: 'find' }).findings).toEqual([]);
  });

  it('honours the allow list by location and kind', () => {
    const script = "var password = 'not-a-secret-in-tests';";
    const { findings } = scanSecrets(withScript(script), { mode: 'find' });
    expect(findings).toHaveLength(1);
    const allow = [{ location: findings[0]!.location, kind: findings[0]!.kind }];
    expect(scanSecrets(withScript(script), { mode: 'find', allow }).findings).toEqual([]);
  });

  it('reports where a finding is, never its value', () => {
    const { findings } = scanSecrets(withScript("var password = 's3cretPw';"), { mode: 'find' });
    expect(findings[0]).toEqual({ location: 'channels/channel[c1]/deployScript', kind: 'assignment', where: 'Lab Feed › deployScript' });
    expect(JSON.stringify(findings)).not.toContain('s3cretPw');
  });

  it('redacts for display', () => {
    const { config } = scanSecrets(withScript("var password = 's3cretPw';"), { mode: 'redact' });
    expect(scriptOf(config)).toBe("var password = '<redacted assignment>';");
  });

  it('does not reuse an env name that already holds a different value', () => {
    const { envUpdates, config } = scanSecrets(withScript("var password = 'newpw1';  var pwd = 'otherpw';"), {
      mode: 'extract',
      env: { LAB_FEED__DEPLOYSCRIPT__PASSWORD: 'existing' },
    });
    expect(Object.keys(envUpdates).sort()).toEqual(['LAB_FEED__DEPLOYSCRIPT__PASSWORD_2', 'LAB_FEED__DEPLOYSCRIPT__PASSWORD_3']);
    expect(scriptOf(render(config, { ...envUpdates }))).toBe("var password = 'newpw1';  var pwd = 'otherpw';");
  });
});

describe('backupEnvFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'channelvault-backup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('keeps a copy only when an existing value is about to change', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'A=1\n');
    expect(await backupEnvFile(file, { B: 'new' })).toBeNull(); // adding loses nothing
    expect(await backupEnvFile(file, { A: '1' })).toBeNull(); // unchanged
    const backup = await backupEnvFile(file, { A: '2' });
    expect(backup).toMatch(/[\\/]\.secrets[\\/]\.env-\d{8}T\d{6}\.\d{3}Z(-\d{2})?$/);
    expect(await readFile(backup!, 'utf8')).toBe('A=1\n');
  });

  it(`keeps only the newest ${ENV_BACKUPS_KEPT}`, async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'A=0\n');
    for (let i = 1; i <= ENV_BACKUPS_KEPT + 2; i += 1) {
      await backupEnvFile(file, { A: String(i) });
      await writeFile(file, `A=${i}\n`);
    }
    const kept = (await readdir(path.join(dir, '.secrets'))).sort();
    expect(kept).toHaveLength(ENV_BACKUPS_KEPT);
    // The oldest two (A=0, A=1) were removed and the newest (A=6) kept.
    const contents = await Promise.all(kept.map((f) => readFile(path.join(dir, '.secrets', f), 'utf8')));
    expect(contents).toEqual(['A=2\n', 'A=3\n', 'A=4\n', 'A=5\n', 'A=6\n']);
  });

  it('does nothing without an env file', async () => {
    expect(await backupEnvFile(path.join(dir, '.env'), { A: '1' })).toBeNull();
    expect(existsSync(path.join(dir, '.secrets'))).toBe(false);
  });
});

describe('CLI: explode with secrets inside values', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(repo, 'test', 'fixtures', 'serverConfiguration.sample.xml');
  let dir: string;
  let backupXml: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'channelvault-detect-cli-'));
    // The fixture plus one channel script with a hard-coded password.
    const adapter = new XmlConfigAdapter();
    const cfg = adapter.parse(await readFile(fixture, 'utf8'));
    const ch = ((cfg['channels'] as Obj)['channel'] as Obj[])[0]!;
    ch['deployScript'] = "var conn = DatabaseConnectionFactory.createDatabaseConnection(driver, url, 'svc', 'Hunter22!');\nvar password = 'Hunter22!';";
    backupXml = path.join(dir, 'backup.xml');
    await writeFile(backupXml, adapter.build(cfg));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), ...args], { cwd: repo, encoding: 'utf8' });

  it('refuses and writes nothing', () => {
    const tree = path.join(dir, 'tree');
    const r = cli('explode', backupXml, tree);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/found 2 possible secret\(s\).*nothing was written/);
    expect(r.stderr).toContain('assignment');
    expect(r.stderr).toContain('db-connection-call');
    expect(r.stderr).not.toContain('Hunter22!');
    expect(existsSync(tree)).toBe(false);
  });

  it('extracts with --extract-secrets and round-trips on implode', async () => {
    const tree = path.join(dir, 'tree');
    const r = cli('explode', backupXml, tree, '--extract-secrets');
    expect(r.status, r.stderr).toBe(0);
    const deploy = await readFile(path.join(tree, 'channels', 'ADT-Inbound-Router', 'scripts', 'deploy.js'), 'utf8');
    expect(deploy).not.toContain('Hunter22!');
    expect(deploy).toContain("var password = '{{env:ADT_INBOUND_ROUTER__DEPLOYSCRIPT__PASSWORD}}';");

    const out = path.join(dir, 'out.xml');
    expect(cli('implode', tree, out).status).toBe(0);
    const adapter = new XmlConfigAdapter();
    expect(adapter.parse(await readFile(out, 'utf8'))).toEqual(adapter.parse(await readFile(backupXml, 'utf8')));
  });

  it('accepts a false positive listed in channelvault.allow.json', async () => {
    const tree = path.join(dir, 'tree');
    const refused = cli('explode', backupXml, tree);
    const ignore = [...refused.stderr.matchAll(/^ {2}(\S+) +.+\n +at (\S+)$/gm)].map((m) => ({ kind: m[1], location: m[2], note: 'test' }));
    expect(ignore.map((i) => i.kind).sort()).toEqual(['assignment', 'db-connection-call']);
    await mkdir(tree, { recursive: true });
    await writeFile(path.join(tree, 'channelvault.allow.json'), JSON.stringify({ ignore }));
    const r = cli('explode', backupXml, tree);
    expect(r.status, r.stderr).toBe(0);
  });
});
