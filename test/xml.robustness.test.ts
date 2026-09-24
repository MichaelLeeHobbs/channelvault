/**
 * Unknown and unexpected XML must survive the round-trip. Mirth plugins and
 * newer engine versions add elements, attributes and step classes we have never
 * seen; the adapter has to carry them through untouched and in order.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { XMLParser } from 'fast-xml-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { ORDER_KEY, XmlConfigAdapter } from '../src/xml/index.js';
import type { CanonicalConfig, Json } from '../src/types.js';

const adapter = new XmlConfigAdapter();
const FIXTURE = fileURLToPath(new URL('./fixtures/serverConfiguration.sample.xml', import.meta.url));

/**
 * Independent oracle: the document as an ordered outline of element names,
 * attributes, comments and non-whitespace text, read straight from fxp's
 * order-preserving tokenizer — not through the adapter under test.
 */
const ordered = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  commentPropName: '#comment',
});
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function outline(xml: string): string[] {
  const lines: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>, depth: number): void => {
    for (const node of nodes) {
      const name = Object.keys(node).find((k) => k !== ':@')!;
      const pad = ' '.repeat(depth);
      if (name === '#text') {
        const text = String(node[name]).replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => NAMED[e]!);
        if (text.trim() !== '') lines.push(`${pad}"${text}"`);
        continue;
      }
      lines.push(`${pad}<${name} ${JSON.stringify(node[':@'] ?? {})}>`);
      walk(node[name] as Array<Record<string, unknown>>, depth + 1);
    }
  };
  walk(ordered.parse(xml) as Array<Record<string, unknown>>, 0);
  return lines;
}

function roundTrip(xml: string): { cfg: CanonicalConfig; built: string } {
  const cfg = adapter.parse(xml);
  const built = adapter.build(cfg);
  expect(adapter.parse(built)).toEqual(cfg);
  return { cfg, built };
}

const JS = 'com.mirth.connect.plugins.javascriptstep.JavaScriptStep';
const MAPPER = 'com.mirth.connect.plugins.mapper.MapperStep';

const INTERLEAVED = `<serverConfiguration version="4.5.0">
  <channels>
    <channel version="4.5.0">
      <id>c1</id>
      <name>Mixed steps</name>
      <sourceConnector version="4.5.0">
        <transformer version="4.5.0">
          <elements>
            <${JS} version="4.5.0"><name>first</name><sequenceNumber>0</sequenceNumber><script>a();</script></${JS}>
            <${MAPPER} version="4.5.0"><name>map</name><sequenceNumber>1</sequenceNumber><mapping>msg['PID']</mapping></${MAPPER}>
            <${JS} version="4.5.0"><name>third</name><sequenceNumber>2</sequenceNumber><script>c();</script></${JS}>
          </elements>
        </transformer>
      </sourceConnector>
    </channel>
  </channels>
</serverConfiguration>
`;

describe('XmlConfigAdapter: unexpected XML', () => {
  it('preserves document order on the full fixture', async () => {
    const xml = await readFile(FIXTURE, 'utf8');
    expect(outline(adapter.build(adapter.parse(xml)))).toEqual(outline(xml));
  });

  it('keeps interleaved step classes in document order', () => {
    const { cfg, built } = roundTrip(INTERLEAVED);
    expect(outline(built)).toEqual(outline(INTERLEAVED));
    const channel = (cfg['channels'] as Record<string, Json[]>)['channel']![0] as Record<string, Json>;
    const elements = ((channel['sourceConnector'] as Record<string, Json>)['transformer'] as Record<string, Json>)[
      'elements'
    ] as Record<string, Json>;
    expect(elements[ORDER_KEY]).toEqual([JS, MAPPER, JS]);
  });

  it('adds no order hint where default order already matches', () => {
    const cfg = adapter.parse(INTERLEAVED.replace(/<com\.mirth\.connect\.plugins\.mapper[\s\S]*?MapperStep>/, ''));
    expect(JSON.stringify(cfg)).not.toContain(ORDER_KEY);
  });

  it('tolerates a stale order hint after hand edits', () => {
    const cfg = adapter.parse(INTERLEAVED);
    const channel = (cfg['channels'] as Record<string, Json[]>)['channel']![0] as Record<string, Json>;
    const elements = ((channel['sourceConnector'] as Record<string, Json>)['transformer'] as Record<string, Json>)[
      'elements'
    ] as Record<string, Json>;
    (elements[JS] as Json[]).pop(); // hint still names two JS steps
    elements['com.example.NewStep'] = { name: 'added' }; // hint never mentions it
    const built = adapter.build(cfg);
    expect(built.match(/<com\.mirth\.connect\.plugins\.javascriptstep\.JavaScriptStep /g)).toHaveLength(1);
    expect(built).toContain('<com.example.NewStep>');
    expect(built.indexOf(MAPPER)).toBeLessThan(built.indexOf('com.example.NewStep'));
  });

  it('rejects a malformed order hint with a clear error', () => {
    const cfg = adapter.parse(INTERLEAVED);
    const channel = (cfg['channels'] as Record<string, Json[]>)['channel']![0] as Record<string, Json>;
    channel[ORDER_KEY] = 'id';
    expect(() => adapter.build(cfg)).toThrow(/#order under <channel> must be an array/);
  });

  it('carries unknown elements, attributes and plugin sections through verbatim', () => {
    const xml = `<serverConfiguration version="9.9.9" vendor="acme">
  <futureSection enabled="true">
    <nested><deeper id="1">x</deeper><deeper id="2"></deeper></nested>
  </futureSection>
  <channels>
    <channel version="9.9.9" experimental="yes">
      <id>c1</id>
      <unknownProperty>kept</unknownProperty>
    </channel>
  </channels>
</serverConfiguration>
`;
    const { built } = roundTrip(xml);
    expect(outline(built)).toEqual(outline(xml));
  });

  it('preserves comments in position', () => {
    const xml = `<serverConfiguration version="4.5.0"><a>1</a><!-- between --><b>2</b></serverConfiguration>`;
    const { built } = roundTrip(xml);
    expect(outline(built)).toEqual(outline(xml));
  });

  it('preserves mixed content text segments and their positions', () => {
    const xml = `<serverConfiguration version="4.5.0"><note>before<b>bold</b>after</note></serverConfiguration>`;
    const { cfg, built } = roundTrip(xml);
    expect((cfg['note'] as Record<string, Json>)['#text']).toEqual(['before', 'after']);
    expect(built).toContain('<note>before<b>bold</b>after</note>');
  });

  it('reads CDATA literally, without entity decoding', () => {
    const xml = `<serverConfiguration version="4.5.0"><script><![CDATA[if (a < b && c) x = "&amp;";]]></script></serverConfiguration>`;
    const { cfg } = roundTrip(xml);
    expect(cfg['script']).toBe('if (a < b && c) x = "&amp;";');
  });

  it('keeps newline and tab character references in attributes', () => {
    const xml = `<serverConfiguration version="4.5.0"><x note="a&#xa;b&#x9;c"></x></serverConfiguration>`;
    const { cfg, built } = roundTrip(xml);
    expect((cfg['x'] as Record<string, Json>)['@_note']).toBe('a\nb\tc');
    expect(built).toContain('note="a&#xa;b&#x9;c"');
  });

  it('normalizes a literal newline in an attribute to a space, as Mirth reads it', () => {
    const cfg = adapter.parse(`<serverConfiguration version="4.5.0"><x note="a\nb"></x></serverConfiguration>`);
    expect((cfg['x'] as Record<string, Json>)['@_note']).toBe('a b');
  });

  it('treats CRLF line endings as LF but keeps an explicit &#xd;', () => {
    // A backup checked out with Windows line endings must not gain CRs.
    const xml = `<serverConfiguration version="4.5.0">\r\n<script>a();\r\nb();&#xd;</script>\r\n</serverConfiguration>`;
    const { cfg } = roundTrip(xml);
    expect(cfg['script']).toBe('a();\nb();\r');
  });

  it('round-trips control characters as character references', () => {
    const xml = `<serverConfiguration version="4.5.0"><s>a&#x1;b</s></serverConfiguration>`;
    const { cfg, built } = roundTrip(xml);
    expect(cfg['s']).toBe('a\u0001b');
    expect(built).toContain('<s>a&#x1;b</s>');
  });

  it.each([
    ['an out-of-range character reference', '<s>&#x110000;</s>', /invalid character reference &#x110000;/],
    ['a DOCTYPE', '', /DOCTYPE declarations are not supported/],
    ['a __proto__ element', '<__proto__>x</__proto__>', /unsupported element name <__proto__>/],
  ])('rejects %s with a clear error', (_label, body, message) => {
    const doctype = body === '' ? '<!DOCTYPE serverConfiguration>' : '';
    const xml = `${doctype}<serverConfiguration version="4.5.0">${body}</serverConfiguration>`;
    expect(() => adapter.parse(xml)).toThrow(message);
  });
});

describe('explode/implode with unexpected XML', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'channelvault-robust-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('keeps interleaved steps and an unknown plugin step through the exploded tree', async () => {
    const xml = INTERLEAVED.replace(
      `<${MAPPER}`,
      `<com.example.plugins.CustomStep version="1.0"><name>custom</name><sequenceNumber>3</sequenceNumber><script>custom();</script></com.example.plugins.CustomStep>\n            <${MAPPER}`,
    );
    const engine = createExplodeEngine();
    const cfg = adapter.parse(xml);
    await engine.explode(cfg, { root });

    // The unknown step class still gets a friendly sidecar.
    const sidecar = path.join(root, 'channels', 'Mixed-steps', 'source', 'transformer', '4.custom.js');
    expect(await readFile(sidecar, 'utf8')).toBe('custom();');

    const imploded = await engine.implode({ root });
    expect(imploded).toEqual(cfg);
    expect(outline(adapter.build(imploded))).toEqual(outline(xml));
  });
});
