/**
 * Optional: the full pipeline on a real server export that must never be
 * committed. Point CHANNELVAULT_PRIVATE_FIXTURE at a backup XML to run it;
 * without it the test is reported as skipped, not passed.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import { expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { XmlConfigAdapter } from '../src/xml/index.js';

const FIXTURE = process.env.CHANNELVAULT_PRIVATE_FIXTURE;

/** Element-name outline in document order, from fxp directly (independent of the adapter). */
function elementOrder(xml: string): string[] {
  const out: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>): void => {
    for (const n of nodes) {
      const name = Object.keys(n).find((k) => k !== ':@')!;
      if (name === '#text') continue;
      out.push(name);
      walk(n[name] as Array<Record<string, unknown>>);
    }
  };
  walk(new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: false }).parse(xml));
  return out;
}

it.skipIf(!FIXTURE)('round-trips a private server export (CHANNELVAULT_PRIVATE_FIXTURE)', async () => {
  const xml = await readFile(FIXTURE!, 'utf8');
  const adapter = new XmlConfigAdapter();
  const engine = createExplodeEngine();
  const root = await mkdtemp(path.join(tmpdir(), 'channelvault-private-'));
  try {
    const original = adapter.parse(xml);
    await engine.explode(original, { root });
    const imploded = await engine.implode({ root });
    expect(imploded).toEqual(original);
    const rebuilt = adapter.build(imploded);
    expect(adapter.parse(rebuilt)).toEqual(original);
    expect(elementOrder(rebuilt)).toEqual(elementOrder(xml));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 120_000);
