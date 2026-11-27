import { describe, expect, it } from 'vitest';

import { resolveConnection, type SelectionInput } from '../src/connection.js';
import type { Profiles } from '../src/profiles.js';

const profiles: Profiles = {
  gov: { host: 'gov.example', port: 8443, user: 'svc', serverId: 'gov-id', tlsFingerprint: 'ab'.repeat(32), dotenv: '/secrets/gov.env' },
  second: { host: 'second.example', port: 8443, user: 'svc', serverId: 'second-id' },
};
const credentials = { gov: 'gov-password', second: 'second-password' };
const envLogin = { MIRTH_HOST: 'env.example', MIRTH_PORT: '8443', MIRTH_USER: 'u', MIRTH_PASS: 'env-password' };

function select(over: Partial<SelectionInput> = {}) {
  return resolveConnection({ flags: {}, env: {}, profiles, credentials, ...over });
}
function reason(over: Partial<SelectionInput>): string | undefined {
  try {
    select(over);
    return undefined;
  } catch (err) {
    return (err as { reason?: string }).reason;
  }
}

describe('selection order', () => {
  it('--profile wins over everything, and carries the whole profile', () => {
    const conn = select({ flags: { profile: 'second' }, env: { ...envLogin, MIRTH_PROFILE: 'gov' }, treeServerId: 'second-id' });
    expect(conn).toMatchObject({ source: 'profile-flag', profile: 'second', host: 'second.example', password: 'second-password', passwordSource: 'credentials', serverId: 'second-id' });
  });

  it('login flags come next, filled from MIRTH_* for the same host', () => {
    const conn = select({ flags: { host: 'env.example' }, env: { ...envLogin, MIRTH_PROFILE: 'gov' } });
    expect(conn).toMatchObject({ source: 'flags', host: 'env.example', password: 'env-password', passwordSource: 'MIRTH_PASS' });
  });

  it('then MIRTH_PROFILE, ahead of MIRTH_HOST', () => {
    expect(select({ env: { ...envLogin, MIRTH_PROFILE: 'gov' } })).toMatchObject({ source: 'env-profile', profile: 'gov' });
  });

  it('then MIRTH_HOST', () => {
    expect(select({ env: envLogin })).toMatchObject({ source: 'env', host: 'env.example', passwordSource: 'MIRTH_PASS' });
  });

  it("then the profile naming the tree's installation", () => {
    expect(select({ treeServerId: 'second-id' })).toMatchObject({ source: 'tree', profile: 'second' });
  });

  it('otherwise fails, listing the profiles and never suggesting --pass', () => {
    expect(() => select()).toThrow(/profiles: gov, second/);
    expect(() => select()).not.toThrow(/--pass/);
    expect(reason({})).toBe('no-connection');
    expect(reason({ treeServerId: 'unknown-id' })).toBe('no-connection');
  });
});

describe('each source is used whole', () => {
  it('refuses login or TLS flags beside --profile', () => {
    for (const flags of [{ host: 'x' }, { pass: 'x' }, { insecure: true }, { https: false }, { tlsFingerprint: 'ab'.repeat(32) }]) {
      expect(reason({ flags: { profile: 'gov', ...flags } })).toBe('flag-conflict');
    }
  });

  it('does not lend MIRTH_PASS to a typed --host for another server', () => {
    expect(reason({ flags: { host: 'other.example', port: '1', user: 'u' }, env: envLogin })).toBe('env-conflict');
    expect(reason({ flags: { host: 'other.example' }, env: envLogin })).toBe('env-conflict');
    expect(select({ flags: { host: 'other.example', port: '1', user: 'u', pass: 'typed' }, env: envLogin })).toMatchObject({ password: 'typed', passwordSource: '--pass' });
    expect(select({ flags: { host: 'other.example', port: '1', user: 'u' }, env: { MIRTH_PASS: 'only-pass' } })).toMatchObject({ password: 'only-pass' });
    expect(select({ flags: { host: 'ENV.example' }, env: envLogin })).toMatchObject({ password: 'env-password' });
  });

  it('does not let MIRTH_HOST stand in for a profile that owns the tree', () => {
    expect(reason({ env: envLogin, treeServerId: 'gov-id' })).toBe('env-shadowed');
    expect(select({ env: envLogin, treeServerId: 'not-a-profile' })).toMatchObject({ source: 'env' });
  });

  it('refuses an explicit profile for another installation than the tree', () => {
    expect(reason({ flags: { profile: 'gov' }, treeServerId: 'second-id' })).toBe('profile-mismatch');
    expect(reason({ env: { MIRTH_PROFILE: 'gov' }, treeServerId: 'second-id' })).toBe('profile-mismatch');
  });

  it('names a missing password and an unknown profile', () => {
    expect(reason({ flags: { profile: 'gov' }, credentials: {} })).toBe('no-password');
    expect(reason({ flags: { profile: 'nope' } })).toBe('profile-unknown');
  });

  it('refuses two profiles naming one installation rather than guessing', () => {
    const twins = { ...profiles, twin: { ...profiles.gov!, dotenv: '/secrets/twin.env' } };
    expect(reason({ profiles: twins, credentials: { ...credentials, twin: 'x'.repeat(8) }, treeServerId: 'gov-id' })).toBe('profile-ambiguous');
  });
});

describe('writes need a typed profile (W2)', () => {
  it('refuses a write the tree selected', () => {
    expect(reason({ treeServerId: 'gov-id', write: true })).toBe('profile-not-typed');
    expect(select({ treeServerId: 'gov-id' })).toMatchObject({ source: 'tree' });
  });

  it('lets MIRTH_PROFILE select a write only when it is confirmed at a terminal', () => {
    expect(select({ env: { MIRTH_PROFILE: 'gov' }, write: true })).toMatchObject({ source: 'env-profile' });
    expect(reason({ env: { MIRTH_PROFILE: 'gov' }, write: true, yes: true })).toBe('profile-not-typed');
  });

  it('accepts a typed profile, login flags and MIRTH_HOST for writes', () => {
    expect(select({ flags: { profile: 'gov' }, write: true, yes: true })).toMatchObject({ source: 'profile-flag' });
    expect(select({ flags: { host: 'env.example' }, env: envLogin, write: true, yes: true })).toMatchObject({ source: 'flags' });
    expect(select({ env: envLogin, write: true, yes: true })).toMatchObject({ source: 'env' });
  });
});

describe('TLS on the flags path', () => {
  it('takes a pin from --tls-fingerprint or MIRTH_TLS_FINGERPRINT, normalised', () => {
    expect(select({ env: { ...envLogin, MIRTH_TLS_FINGERPRINT: 'AB:'.repeat(31) + 'AB' } }).tlsFingerprint).toBe('ab'.repeat(32));
    expect(select({ flags: { host: 'env.example', tlsFingerprint: 'CD'.repeat(32) }, env: envLogin }).tlsFingerprint).toBe('cd'.repeat(32));
  });

  it('refuses a malformed pin, and --insecure or --no-https beside one', () => {
    expect(reason({ env: { ...envLogin, MIRTH_TLS_FINGERPRINT: 'abc' } })).toBe('bad-fingerprint');
    expect(reason({ flags: { insecure: true }, env: { ...envLogin, MIRTH_TLS_FINGERPRINT: 'ab'.repeat(32) } })).toBe('flag-conflict');
    expect(reason({ flags: { host: 'env.example', https: false, tlsFingerprint: 'ab'.repeat(32) }, env: envLogin })).toBe('flag-conflict');
  });
});
