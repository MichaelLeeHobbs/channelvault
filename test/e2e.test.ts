/**
 * End-to-end acceptance: the full pipeline must round-trip the Mirth-exported
 * fixture losslessly.
 *
 *   parse(xml) -> explode -> (files on disk) -> implode -> build -> parse
 *
 * must deep-equal the original parse(xml).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { XmlConfigAdapter } from '../src/xml/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'serverConfiguration.sample.xml');

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'channelvault-e2e-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

it('round-trips the backup through explode -> implode -> build', async () => {
  const xml = new XmlConfigAdapter();
  const engine = createExplodeEngine();

  const original = xml.parse(await readFile(FIXTURE, 'utf8'));

  await engine.explode(original, { root: work });

  // The exploded tree has the expected top-level shape.
  expect(existsSync(path.join(work, 'server', 'configuration.json'))).toBe(true);
  expect(existsSync(path.join(work, 'channels'))).toBe(true);

  const imploded = await engine.implode({ root: work });

  // 1) implode(explode(x)) deep-equals x
  expect(imploded).toEqual(original);

  // 2) the imploded config rebuilds to XML that re-parses identically
  const rebuiltXml = xml.build(imploded);
  const reparsed = xml.parse(rebuiltXml);
  expect(reparsed).toEqual(original);
});
