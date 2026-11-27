import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configDir, credentialsFile, isLoopback, loadProfiles, normalizeFingerprint, profileProblems, profilesFile, readCredentials, saveProfiles, setCredential,
} from '../src/profiles.js';

let dir: string;
const original = process.env.CHANNELVAULT_CONFIG_DIR;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-profiles-'));
  process.env.CHANNELVAULT_CONFIG_DIR = dir;
});
afterEach(async () => {
  process.env.CHANNELVAULT_CONFIG_DIR = original;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const valid = { host: 'gov.example', port: 8443, user: 'svc' };

describe('profiles.json', () => {
  it('is empty when absent, and round-trips with a normalised fingerprint', async () => {
    expect(await loadProfiles()).toEqual({});
    await saveProfiles({ gov: { ...valid, tlsFingerprint: 'AB:'.repeat(31) + 'AB', serverId: 'id-1', dotenv: path.join(dir, 'gov.env') } });
    expect((await loadProfiles()).gov).toMatchObject({ tlsFingerprint: 'ab'.repeat(32), serverId: 'id-1' });
    expect(profilesFile()).toBe(path.join(dir, 'profiles.json'));
  });

  it('refuses unknown fields by name and points a password to set-password', () => {
    expect(profileProblems({ gov: { ...valid, colour: 'red' } })).toEqual([expect.stringContaining('unknown field colour')]);
    expect(profileProblems({ gov: { ...valid, password: 'x' } })).toEqual([expect.stringContaining('channelvault profile set-password gov')]);
  });

  it('refuses plain http and turning verification off except on loopback', () => {
    expect(profileProblems({ gov: { ...valid, https: false } })[0]).toContain('https cannot be false');
    expect(profileProblems({ gov: { ...valid, insecure: true } })[0]).toContain('insecure is refused');
    expect(profileProblems({ local: { ...valid, host: '127.0.0.1', https: false } })).toEqual([]);
    expect(profileProblems({ local: { ...valid, host: 'localhost', insecure: true } })).toEqual([]);
  });

  it('refuses two servers sharing an env file, and relative env files', () => {
    const shared = path.join(dir, 'shared.env');
    expect(profileProblems({ a: { ...valid, dotenv: shared }, b: { ...valid, dotenv: shared } })[0]).toContain('share the env file');
    expect(profileProblems({ a: { ...valid, dotenv: 'relative.env' } })[0]).toContain('absolute path');
  });

  it('refuses bad names, ports and fingerprints', () => {
    expect(profileProblems({ 'bad name': valid })[0]).toContain('a name is');
    expect(profileProblems({ gov: { ...valid, port: 0 } })[0]).toContain('port');
    expect(profileProblems({ gov: { ...valid, tlsFingerprint: 'abc' } })[0]).toContain('tlsFingerprint');
  });

  it('reports an unreadable file without echoing its contents', async () => {
    await writeFile(path.join(dir, 'profiles.json'), '{ "profiles": { "gov": "hunter2-secret');
    await expect(loadProfiles()).rejects.toThrow(/not valid JSON/);
    await expect(loadProfiles()).rejects.not.toThrow(/hunter2/);
    await writeFile(path.join(dir, 'profiles.json'), JSON.stringify({ gov: valid }));
    await expect(loadProfiles()).rejects.toThrow(/\{ "profiles"/);
  });
});

describe('credentials', () => {
  it('stores one line per profile, owner-only, and ignores the process environment', async () => {
    await setCredential('gov', 'pa ss=word#1');
    await setCredential('second', 'another-password');
    process.env.gov = 'from-environment';
    try {
      expect(await readCredentials()).toEqual({ gov: 'pa ss=word#1', second: 'another-password' });
    } finally {
      delete process.env.gov;
    }
    expect(await readFile(credentialsFile(), 'utf8')).toMatch(/^gov=/m);
    if (process.platform !== 'win32') expect((await stat(credentialsFile())).mode & 0o077).toBe(0);
  });
});

describe('the folder', () => {
  it('is refused inside a git work tree', () => {
    process.env.CHANNELVAULT_CONFIG_DIR = path.join(process.cwd(), 'not-here');
    expect(() => configDir()).toThrow(/inside a git work tree/);
  });
});

describe('helpers', () => {
  it('recognises loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopback(h)).toBe(true);
    for (const h of ['gov.example', '10.0.0.1', '128.0.0.1']) expect(isLoopback(h)).toBe(false);
  });

  it('normalises fingerprints', () => {
    expect(normalizeFingerprint('AB:'.repeat(31) + 'AB')).toBe('ab'.repeat(32));
    expect(normalizeFingerprint('ab'.repeat(31))).toBeNull();
  });
});
