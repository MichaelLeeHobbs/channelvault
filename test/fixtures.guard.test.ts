/**
 * Tripwire: fixtures must be synthetic. A real Mirth export dropped into
 * test/fixtures would carry production hosts, credentials and PHI-adjacent
 * config into a public repo. Synthetic fixtures use sequential UUIDs
 * (00000000-0000-4000-8000-…) and example.org addresses, which no real server
 * produces.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
const files = readdirSync(dir).filter((f) => /\.(xml|json)$/.test(f));

describe.each(files)('fixture %s is synthetic', (file) => {
  const text = readFileSync(path.join(dir, file), 'utf8');

  it('uses only synthetic UUIDs', () => {
    const ids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(ids.filter((id) => !id.startsWith('00000000-0000-4000-8000-'))).toEqual([]);
  });

  it('uses only example.org addresses', () => {
    const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    expect(emails.filter((e) => !e.endsWith('@example.org'))).toEqual([]);
    const urls = text.match(/https?:\/\/[^\s<"']+/g) ?? [];
    expect(urls.filter((u) => !/^https?:\/\/([\w-]+\.)*example\.org(\/|:|$)/.test(u))).toEqual([]);
  });

  it('contains no cloud access keys', () => {
    expect(text).not.toMatch(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/);
  });
});

it('found fixtures to check', () => {
  expect(files.length).toBeGreaterThan(0);
});
