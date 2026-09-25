/**
 * The full pipeline on third-party Mirth exports (3.8, 4.0.1, OIE 4.5.2),
 * listed with their provenance and hashes in the fixtures' SOURCE.md.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { scanSecrets } from '../src/secrets/detect.js';
import { render, templatize } from '../src/secrets/index.js';
import { XmlConfigAdapter } from '../src/xml/index.js';

const dir = fileURLToPath(new URL('./fixtures/third-party/mirthsync/', import.meta.url));
// Rows of SOURCE.md's table: | `file` | engine | `sha256` |
const manifest = [...(await readFile(path.join(dir, 'SOURCE.md'), 'utf8')).matchAll(/^\| `([^`]+\.xml)` \| ([^|]+) \| `([0-9a-f]{64})` \|$/gm)].map(
  (m) => ({ file: m[1]!, engine: m[2]!.trim(), sha256: m[3]! }),
);

it('lists the fixtures to check', () => {
  expect(manifest.map((f) => f.file)).toEqual(['mirth-backup-3-08.xml', 'mirth-backup-4-01.xml', 'mirth-backup-oie-4-52.xml']);
});

describe.each(manifest)('$file ($engine)', ({ file, engine, sha256 }) => {
  const xml = new XmlConfigAdapter();
  let text: string;
  let work: string;
  beforeEach(async () => {
    text = await readFile(path.join(dir, file), 'utf8');
    work = await mkdtemp(path.join(tmpdir(), 'channelvault-third-party-'));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Only the recorded upstream files belong here; a real export would not match.
  it('is the upstream file, unmodified', () => {
    expect(createHash('sha256').update(text).digest('hex')).toBe(sha256);
  });

  it('is the engine version SOURCE.md says', () => {
    expect(engine).toContain(String(xml.parse(text)['@_version']));
  });

  it('round-trips through explode -> implode -> build', async () => {
    const engineApi = createExplodeEngine();
    const original = xml.parse(text);
    await engineApi.explode(original, { root: work });
    const imploded = await engineApi.implode({ root: work });
    expect(imploded).toEqual(original);
    expect(xml.parse(xml.build(imploded))).toEqual(original);
  });

  it('templatizes its credentials, finds no other secrets, and renders back exactly', () => {
    const original = xml.parse(text);
    const templated = templatize(original, null, {});
    // The Database Writer's password, and the configuration map (all of whose values move to the env file).
    expect(templated.envUpdates).toEqual({
      HELLO_DB_WRITER__HELLO_DATABASE_WRITER__PASSWORD: 'test',
      CONFIG_MAP__THIS_IS_A_KEY: 'This is a multi\nline\nvalue',
    });
    expect(scanSecrets(templated.config, { mode: 'find' }).findings).toEqual([]);
    expect(render(templated.config, templated.envUpdates)).toEqual(original);
  });
});
