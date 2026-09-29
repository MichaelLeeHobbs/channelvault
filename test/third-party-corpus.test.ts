/**
 * Every vendored third-party export (test/fixtures/third-party/<source>/,
 * listed with its provenance and hash in that folder's SOURCE.md) through the
 * offline pipeline: exports from Mirth 3.0 to OIE 4.6, from projects that
 * write channels differently from each other and from us.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { scanSecrets } from '../src/secrets/detect.js';
import { render, templatize } from '../src/secrets/index.js';
import { XmlConfigAdapter } from '../src/xml/index.js';

const base = fileURLToPath(new URL('./fixtures/third-party/', import.meta.url));
const corpus = readdirSync(base)
  .filter((dir) => existsSync(path.join(base, dir, 'SOURCE.md')))
  .flatMap((dir) =>
    [...readFileSync(path.join(base, dir, 'SOURCE.md'), 'utf8').matchAll(/^\| `([^`]+\.xml)` \| [^|]+ \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({
      source: dir,
      file: m[1]!,
      sha256: m[2]!,
    })),
  );

/**
 * channelvault reads a server configuration; wrap a single channel, library
 * or global-scripts export in one, leaving the export's own text untouched.
 */
function asServerConfiguration(text: string): string {
  const body = text.replace(/^\uFEFF?\s*<\?xml[^>]*\?>/, '');
  const open = /<([A-Za-z][\w.]*)(\s[^>]*)?>/.exec(body.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length)))!;
  const version = /\sversion="([^"]+)"/.exec(open[0])?.[1] ?? '3.0.0';
  const wrap = (section: string, inner: string) => `<serverConfiguration version="${version}"><${section}>${inner}</${section}></serverConfiguration>`;
  switch (open[1]) {
    case 'serverConfiguration': return body;
    case 'channel': return wrap('channels', body);
    case 'codeTemplateLibrary': return wrap('codeTemplateLibraries', body);
    case 'map': return wrap('globalScripts', body.slice(body.indexOf(open[0]) + open[0].length, body.lastIndexOf('</map>')));
    default: throw new Error(`unexpected root <${open[1]}>`);
  }
}

it('finds the vendored exports', () => {
  expect(corpus.length).toBeGreaterThan(30);
  expect(new Set(corpus.map((c) => c.source)).size).toBeGreaterThan(8);
});

describe.each(corpus)('$source/$file', ({ source, file, sha256 }) => {
  const bytes = readFileSync(path.join(base, source, file));
  const xml = new XmlConfigAdapter();

  // Only the recorded upstream files belong here.
  it('is the upstream file, unmodified', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
  });

  it('round-trips through explode -> implode -> build', { timeout: 60_000 }, async () => {
    const original = xml.parse(asServerConfiguration(bytes.toString('utf8')));
    const root = await mkdtemp(path.join(tmpdir(), 'channelvault-corpus-'));
    try {
      const engine = createExplodeEngine();
      await engine.explode(original, { root });
      const imploded = await engine.implode({ root });
      expect(imploded).toEqual(original);
      expect(xml.parse(xml.build(imploded))).toEqual(original);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('gets back exactly the original after extracting its secrets and filling them in again', () => {
    const original = xml.parse(asServerConfiguration(bytes.toString('utf8')));
    const templated = templatize(original, null, {});
    const extracted = scanSecrets(templated.config, { mode: 'extract' });
    expect(render(extracted.config, { ...templated.envUpdates, ...extracted.envUpdates })).toEqual(original);
  });
});
