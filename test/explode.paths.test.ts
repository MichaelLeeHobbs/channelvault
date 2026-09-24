/**
 * Friendly-path naming on a Mirth-exported config.
 *
 * Parses the synthetic `serverConfiguration.sample.xml` fixture (exported by a
 * real Mirth 4.5.2 server) through the `XmlConfigAdapter`, explodes it, and asserts that the human-meaningful
 * file layout is produced for the common transformer / code-template cases
 * (not the generic `_code/...JavaScriptStep` fallback). Finally re-asserts the
 * full explode -> implode round-trip on the fixture.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { XmlConfigAdapter } from '../src/xml/index.js';
import type { CanonicalConfig } from '../src/types.js';

const fixturePath = fileURLToPath(
  new URL('./fixtures/serverConfiguration.sample.xml', import.meta.url),
);

const engine = createExplodeEngine();

let root: string;
let config: CanonicalConfig;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mirth-paths-'));
  config = new XmlConfigAdapter().parse(readFileSync(fixturePath, 'utf8'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively collect POSIX-relative file paths under `dir`. */
async function walk(dir: string, base = dir, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc;
}

describe('explode friendly paths on Mirth-exported data', () => {
  it('names a source transformer step by sequence + name', async () => {
    await engine.explode(config, { root });

    const step = path.join(
      root,
      'channels',
      'ADT-Inbound-Router',
      'source',
      'transformer',
      '1.normalizePatientId.js',
    );
    expect(await exists(step)).toBe(true);
    const body = await readFile(step, 'utf8');
    expect(body.trim().length).toBeGreaterThan(0);
    // It is real JavaScript, not JSON/XML.
    expect(body).toMatch(/[(){};=]/);
  });

  it('names a destination connector transformer step under destinations/<slug>', async () => {
    await engine.explode(config, { root });

    const files = await walk(root);
    const destStep = files.find((f) =>
      /^channels\/ADT-Inbound-Router\/destinations\/[^/]+\/transformer\/\d+(\.[^/]+)?\.js$/.test(f),
    );
    expect(destStep, 'expected a destination transformer step file').toBeTruthy();
    const body = await readFile(path.join(root, destStep!), 'utf8');
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('names a code template by template name, next to library.json', async () => {
    await engine.explode(config, { root });

    const ct = path.join(root, 'codeTemplates', 'Formatting', 'formatName.js');
    expect(await exists(ct)).toBe(true);
    const body = await readFile(ct, 'utf8');
    expect(body.trim().length).toBeGreaterThan(0);

    // And NOT in the generic fallback form.
    expect(
      await exists(
        path.join(root, 'codeTemplates', 'Formatting', '_code', 'codeTemplate.properties.code.js'),
      ),
    ).toBe(false);
  });

  it('does not use the generic _code/JavaScriptStep fallback for known channel/library leaves', async () => {
    await engine.explode(config, { root });

    const jsFiles = (await walk(root)).filter((f) => f.endsWith('.js'));
    expect(jsFiles.length).toBeGreaterThan(30);

    const offenders = jsFiles.filter(
      (f) =>
        (f.startsWith('channels/') || f.startsWith('codeTemplates/')) &&
        (f.includes('JavaScriptStep') ||
          f.includes('codeTemplate.properties.code') ||
          /(^|\/)_code\//.test(f)),
    );
    expect(offenders, `unexpected generic fallback files:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('round-trips the fixture (explode -> implode deep-equals original)', async () => {
    const snapshot = structuredClone(config);
    await engine.explode(config, { root });
    const imploded = await engine.implode({ root });
    expect(imploded).toEqual(snapshot);
    // input not mutated by explode
    expect(config).toEqual(snapshot);
  });
});
