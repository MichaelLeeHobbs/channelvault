import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redactKnownSecrets, render, templatize } from '../src/secrets/index.js';
import { ensureEnvIgnored, formatValue, readEnvFile, updateEnvFile } from '../src/secrets/envfile.js';
import { XmlConfigAdapter } from '../src/xml/index.js';
import type { CanonicalConfig, Json } from '../src/types.js';

/** Live-API-shaped config with credentials in the places Mirth keeps them. */
function liveConfig(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    serverSettings: { smtpHost: 'smtp.example.org', smtpPassword: 'smtp-pw' },
    channels: {
      channel: [
        {
          id: 'c-1',
          name: 'Results Intake',
          sourceConnector: { name: 'sourceConnector', properties: { host: 'db.internal', port: '5432' } },
          destinationConnectors: {
            connector: [
              { metaDataId: 1, name: 'To HTTP', properties: { username: 'svc', password: 'http-pw', useAuthentication: true } },
              { metaDataId: 2, name: 'To File', properties: { password: '' } },
            ],
          },
        },
      ],
    },
    configurationMap: {
      entry: [{ string: 'api.token', 'com.mirth.connect.util.ConfigurationProperty': { value: 'tok-123', comment: null } }],
    },
  };
}

type Obj = Record<string, Json>;
const channel = (c: CanonicalConfig): Obj => ((c['channels'] as Obj)['channel'] as Obj[])[0]!;
const dest = (c: CanonicalConfig, i: number): Obj =>
  (((channel(c)['destinationConnectors'] as Obj)['connector'] as Obj[])[i]!['properties'] as Obj);

describe('templatize', () => {
  it('replaces credentials with named placeholders and returns their values', () => {
    const { config, envUpdates } = templatize(liveConfig(), null, {});
    expect(dest(config, 0)['password']).toBe('{{env:RESULTS_INTAKE__TO_HTTP__PASSWORD}}');
    expect((config['serverSettings'] as Obj)['smtpPassword']).toBe('{{env:SERVERSETTINGS__SMTPPASSWORD}}');
    const entry = ((config['configurationMap'] as Obj)['entry'] as Obj[])[0]!;
    expect((entry['com.mirth.connect.util.ConfigurationProperty'] as Obj)['value']).toBe('{{env:CONFIG_MAP__API_TOKEN}}');
    expect(envUpdates).toEqual({
      RESULTS_INTAKE__TO_HTTP__PASSWORD: 'http-pw',
      SERVERSETTINGS__SMTPPASSWORD: 'smtp-pw',
      CONFIG_MAP__API_TOKEN: 'tok-123',
    });
  });

  it('leaves empty credentials, non-secret fields and non-string values alone', () => {
    const { config } = templatize(liveConfig(), null, {});
    expect(dest(config, 1)['password']).toBe('');
    expect(dest(config, 0)['username']).toBe('svc');
    expect(dest(config, 0)['useAuthentication']).toBe(true);
  });

  it('round-trips through render', () => {
    const { config, envUpdates } = templatize(liveConfig(), null, {});
    expect(render(config, envUpdates)).toEqual(liveConfig());
  });

  it('is stable on re-pull: same placeholders, nothing to write', () => {
    const first = templatize(liveConfig(), null, {});
    const second = templatize(liveConfig(), first.config, first.envUpdates);
    expect(second.config).toEqual(first.config);
    expect(second.envUpdates).toEqual({});
    expect(second.notes).toEqual([]);
  });

  it('updates the env value when a password is rotated on the server', () => {
    const first = templatize(liveConfig(), null, {});
    const rotated = liveConfig();
    dest(rotated, 0)['password'] = 'new-pw';
    const second = templatize(rotated, first.config, first.envUpdates);
    expect(dest(second.config, 0)['password']).toBe('{{env:RESULTS_INTAKE__TO_HTTP__PASSWORD}}');
    expect(second.envUpdates).toEqual({ RESULTS_INTAKE__TO_HTTP__PASSWORD: 'new-pw' });
  });

  it('keeps a hand-added placeholder while it still renders to the server value', () => {
    const previous = liveConfig();
    ((channel(previous)['sourceConnector'] as Obj)['properties'] as Obj)['host'] = '{{env:DB_HOST}}';
    const { config } = templatize(liveConfig(), previous, { DB_HOST: 'db.internal' });
    expect(((channel(config)['sourceConnector'] as Obj)['properties'] as Obj)['host']).toBe('{{env:DB_HOST}}');
  });

  it('keeps an embedded placeholder in code when it renders to the server value', () => {
    const remote = liveConfig();
    channel(remote)['deployScript'] = "var url = 'https://api.example.org/v1/x';";
    const previous = liveConfig();
    channel(previous)['deployScript'] = "var url = '{{env:API_URL}}/x';";
    const { config } = templatize(remote, previous, { API_URL: 'https://api.example.org/v1' });
    expect(channel(config)['deployScript']).toBe("var url = '{{env:API_URL}}/x';");
  });

  it('updates an embedded placeholder whose surrounding text still matches', () => {
    const remote = liveConfig();
    channel(remote)['deployScript'] = "var url = 'https://other.example.org/x';";
    const previous = liveConfig();
    channel(previous)['deployScript'] = "var url = '{{env:API_URL}}/x';";
    const { config, envUpdates } = templatize(remote, previous, { API_URL: 'https://api.example.org/v1' });
    expect(channel(config)['deployScript']).toBe("var url = '{{env:API_URL}}/x';");
    expect(envUpdates['API_URL']).toBe('https://other.example.org');
  });

  it('drops a placeholder when neither its text nor its value is on the server, and says so', () => {
    const remote = liveConfig();
    channel(remote)['deployScript'] = "var link = 'https://other.example.org/y';";
    const previous = liveConfig();
    channel(previous)['deployScript'] = "var url = '{{env:API_URL}}/x';";
    const { config, notes } = templatize(remote, previous, { API_URL: 'https://api.example.org/v1' });
    expect(channel(config)['deployScript']).toBe("var link = 'https://other.example.org/y';");
    expect(notes.join('\n')).toMatch(/deployScript: placeholder no longer matches/);
  });

  it('gives two credentials that derive the same name distinct variables', () => {
    const remote = liveConfig();
    const conns = (channel(remote)['destinationConnectors'] as Obj)['connector'] as Obj[];
    conns[1] = { metaDataId: 2, name: 'To HTTP', properties: { password: 'other-pw' } };
    const { envUpdates } = templatize(remote, null, {});
    expect(envUpdates).toMatchObject({ RESULTS_INTAKE__TO_HTTP__PASSWORD: 'http-pw', RESULTS_INTAKE__TO_HTTP__PASSWORD_2: 'other-pw' });
  });

  it('handles the XML shape of configuration-map entries', () => {
    const cfg = new XmlConfigAdapter().parse(
      `<serverConfiguration version="4.5.2"><configurationMap class="linked-hash-map"><entry><string>db.url</string>` +
        `<com.mirth.connect.util.ConfigurationProperty><value>jdbc:x</value><comment></comment></com.mirth.connect.util.ConfigurationProperty>` +
        `</entry></configurationMap></serverConfiguration>`,
    );
    expect(templatize(cfg, null, {}).envUpdates).toEqual({ CONFIG_MAP__DB_URL: 'jdbc:x' });
  });

  it('leaves secrets inside values to the detector', () => {
    const remote = liveConfig();
    channel(remote)['deployScript'] = "var password = 'hunter22';";
    const { config, notes } = templatize(remote, null, {});
    expect(channel(config)['deployScript']).toBe("var password = 'hunter22';");
    expect(notes).toEqual([]);
  });
});

describe('render', () => {
  it('names every missing variable instead of sending a placeholder', () => {
    const { config } = templatize(liveConfig(), null, {});
    expect(() => render(config, { SERVERSETTINGS__SMTPPASSWORD: 'x' })).toThrow(
      'missing values for CONFIG_MAP__API_TOKEN, RESULTS_INTAKE__TO_HTTP__PASSWORD',
    );
  });

  it('leaves Mirth ${velocity} variables alone', () => {
    expect(render({ template: '${message.encodedData}' }, {})).toEqual({ template: '${message.encodedData}' });
  });
});

describe('env file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'channelvault-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it.each([
    ['plain', 'abc123'],
    ['spaces and hash', 'p@ss word #1'],
    ['single quote', "it's"],
    ['double quote', 'say "hi"'],
    ['both quotes', `it's "x"`],
    ['newline', 'line1\nline2'],
    ['literal backslash-n', 'a\\nb'],
    ['equals', 'a=b=c'],
    ['empty', ''],
  ])('round-trips a value with %s', (_label, value) => {
    expect(parse(`K=${formatValue(value)}`)['K']).toBe(value);
  });

  it('updates in place, keeping comments and other variables', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, '# my notes\nKEEP=1\nPASS=old\nMULTI="a\nb"\n');
    await updateEnvFile(file, { PASS: 'new value', MULTI: 'single', ADDED: 'x' });
    expect(await readFile(file, 'utf8')).toBe("# my notes\nKEEP=1\nPASS='new value'\nMULTI=single\nADDED=x\n");
    expect(await readEnvFile(file)).toEqual({ KEEP: '1', PASS: 'new value', MULTI: 'single', ADDED: 'x' });
  });

  it('adds env files to .gitignore once', async () => {
    await writeFile(path.join(dir, '.gitignore'), 'node_modules');
    expect(await ensureEnvIgnored(dir)).toBe(true);
    expect(await ensureEnvIgnored(dir)).toBe(false);
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n# channelvault: secrets and per-environment values\n.env\n.env.*\n!.env.example\n.secrets/\n',
    );
  });
});

describe('CLI: explode/implode keep secrets in .env', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(repo, 'test', 'fixtures', 'serverConfiguration.sample.xml');
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'channelvault-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), ...args], {
      cwd: repo,
      encoding: 'utf8',
    });

  async function allTreeText(root: string): Promise<string> {
    let text = '';
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name !== '.env') text += await readFile(path.join(entry.parentPath, entry.name), 'utf8');
    }
    return text;
  }

  it('writes no credential into the tree and restores them on implode', async () => {
    const tree = path.join(dir, 'tree');
    const exploded = cli('explode', fixture, tree);
    expect(exploded.status, exploded.stderr).toBe(0);

    const text = await allTreeText(tree);
    for (const secret of ['fixture-password', 'fixture-smtp-password', 'fixture-token-not-a-secret']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('{{env:');
    expect(existsSync(path.join(tree, '.env'))).toBe(true);
    expect(await readFile(path.join(tree, '.gitignore'), 'utf8')).toContain('.env');

    const out = path.join(dir, 'out.xml');
    const imploded = cli('implode', tree, out);
    expect(imploded.status, imploded.stderr).toBe(0);
    const adapter = new XmlConfigAdapter();
    expect(adapter.parse(await readFile(out, 'utf8'))).toEqual(adapter.parse(await readFile(fixture, 'utf8')));
  });

  it('refuses to implode when the env file is missing', async () => {
    const tree = path.join(dir, 'tree');
    expect(cli('explode', fixture, tree).status).toBe(0);
    await rm(path.join(tree, '.env'));
    const imploded = cli('implode', tree, path.join(dir, 'out.xml'));
    expect(imploded.status).toBe(1);
    expect(imploded.stderr).toMatch(/missing values for .*SERVERSETTINGS__SMTPPASSWORD/);
  });
});

describe('second review regressions', () => {
  const two = (a: string, b: string): CanonicalConfig => ({
    channels: {
      channel: [
        { id: 'c1', name: 'A-B', properties: { password: a } },
        { id: 'c2', name: 'A B', properties: { password: b } },
      ],
    },
  });
  const pw = (c: CanonicalConfig, i: number) => ((((c['channels'] as Obj)['channel'] as Obj[])[i]!['properties'] as Obj)['password']);

  it('gives two locations their own placeholders even when name and value collide', () => {
    const { config } = templatize(two('same', 'same'), null, {});
    expect(pw(config, 0)).not.toBe(pw(config, 1));
  });

  it('rotating one of two shared placeholders never changes the other', () => {
    // A tree from before the fix, where both locations share one name.
    const shared = two('{{env:A_B__PASSWORD}}', '{{env:A_B__PASSWORD}}');
    const env = { A_B__PASSWORD: 'old' };
    const { config, envUpdates } = templatize(two('new', 'old'), shared, env);
    const rendered = render(config, { ...env, ...envUpdates });
    expect(pw(rendered, 0)).toBe('new');
    expect(pw(rendered, 1)).toBe('old');
  });

  it('redacts literal credentials by field name for display', () => {
    const cfg: CanonicalConfig = { serverSettings: { smtpPassword: 'typed-by-hand', smtpHost: 'smtp.example.org' } };
    expect(redactKnownSecrets(cfg)).toEqual({ serverSettings: { smtpPassword: '<redacted>', smtpHost: 'smtp.example.org' } });
  });
});

it('ignores a custom env file name inside the tree', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'channelvault-ignore-'));
  try {
    await ensureEnvIgnored(dir, path.join(dir, 'secrets.prod'));
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('\n/secrets.prod\n');
    await ensureEnvIgnored(dir, path.join(dir, '.env.prod')); // already covered by .env.*
    expect((await readFile(path.join(dir, '.gitignore'), 'utf8')).match(/\.env\.prod/g)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
