import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { XmlConfigAdapter } from '../src/xml/index.js';

const fixturePath = fileURLToPath(
  new URL('./fixtures/serverConfiguration.sample.xml', import.meta.url),
);

/** Walk a JSON tree and collect every string leaf. */
function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectStrings(v, out);
  }
  return out;
}

describe('XmlConfigAdapter', () => {
  const adapter = new XmlConfigAdapter();

  it('round-trips a small hand-written snippet (semantic equality)', () => {
    const xml = `<serverConfiguration version="4.5.0">
  <date>2024-12-27 12:10:33</date>
  <channels>
    <channel version="4.5.0">
      <id>0123-leading-zero</id>
      <name>Demo &amp; Test</name>
      <enabled>true</enabled>
      <transformer version="4.5.0">
        <elements>
          <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.0">
            <script>var x = 'a' &lt; 'b' &amp;&amp; foo();
  return x;</script>
          </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
        </elements>
      </transformer>
      <description></description>
      <pluginProperties/>
    </channel>
  </channels>
</serverConfiguration>
`;
    const original = adapter.parse(xml);
    const reparsed = adapter.parse(adapter.build(original));
    expect(reparsed).toEqual(original);
  });

  it('keeps values as strings and forces single members into arrays', () => {
    const xml = `<serverConfiguration version="4.5.0">
  <channels>
    <channel version="4.5.0">
      <id>10000</id>
    </channel>
  </channels>
</serverConfiguration>`;
    const cfg = adapter.parse(xml);
    // top-level wrapper stripped; @_version surfaced.
    expect(cfg['@_version']).toBe('4.5.0');
    const channels = cfg['channels'] as Record<string, unknown>;
    // Single <channel> is still an array.
    expect(Array.isArray(channels['channel'])).toBe(true);
    const channel = (channels['channel'] as Array<Record<string, unknown>>)[0]!;
    // "10000" stays a string, not the number 10000.
    expect(channel['id']).toBe('10000');
    expect(typeof channel['id']).toBe('string');
  });

  it('parse() unwraps the serverConfiguration root', () => {
    const xml = readFileSync(fixturePath, 'utf8');
    const cfg = adapter.parse(xml);
    expect(cfg).not.toHaveProperty('serverConfiguration');
    expect(cfg).toHaveProperty('channels');
    expect(cfg['@_version']).toBe('4.5.2');
  });

  it('decodes entities and preserves non-empty script bodies', () => {
    const xml = readFileSync(fixturePath, 'utf8');
    const cfg = adapter.parse(xml);
    const strings = collectStrings(cfg);
    // Entity decode worked somewhere in the tree: real chars, not entities.
    const hasApostrophe = strings.some((s) => s.includes("'"));
    const hasAmp = strings.some((s) => s.includes('&'));
    const hasLt = strings.some((s) => s.includes('<'));
    expect(hasApostrophe).toBe(true);
    expect(hasAmp).toBe(true);
    expect(hasLt).toBe(true);
    // No raw XML entities should leak through as decoded text.
    expect(strings.some((s) => s.includes('&apos;'))).toBe(false);
    // At least one substantial multi-character script-like body survived.
    expect(strings.some((s) => s.includes("channelMap.put('route'"))).toBe(true);
  });

  it('semantically round-trips the full fixture', () => {
    const xml = readFileSync(fixturePath, 'utf8');
    const original = adapter.parse(xml);
    const rebuilt = adapter.build(original);
    const reparsed = adapter.parse(rebuilt);
    expect(reparsed).toEqual(original);
  });

  it('decodes a CR character reference (&#xd;) to a real carriage return', () => {
    const xml = `<serverConfiguration version="4.5.0">
  <channels>
    <channel version="4.5.0">
      <transformer version="4.5.0">
        <elements>
          <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.0">
            <script>var a = 1&#xd;var b = 2</script>
          </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
        </elements>
      </transformer>
    </channel>
  </channels>
</serverConfiguration>`;
    const strings = collectStrings(adapter.parse(xml));
    // The script body carries a real CR, not the literal text "&#xd;".
    expect(strings).toContain('var a = 1\rvar b = 2');
    expect(strings.some((s) => s.includes('&#xd;'))).toBe(false);
  });

  it('re-encodes a carriage return as &#xd; on build (no &amp;#xd; corruption)', () => {
    const xml = `<serverConfiguration version="4.5.0">
  <channels>
    <channel version="4.5.0">
      <description>line1&#xd;line2</description>
    </channel>
  </channels>
</serverConfiguration>`;
    const built = adapter.build(adapter.parse(xml));
    // The CR comes back out as the char reference, exactly once...
    expect(built).toContain('line1&#xd;line2');
    // ...and is NOT double-escaped into a literal "&#xd;" string.
    expect(built).not.toContain('&amp;#xd;');
  });

  it('byte-perfectly round-trips &#xd; through build (parse->build is a fixed point)', () => {
    // A CR ref must survive build identically; before the codec fix the builder
    // emitted &amp;#xd;, which then re-parsed to a different string.
    const xml = `<serverConfiguration version="4.5.0">` +
      `<channels><channel version="4.5.0">` +
      `<description>a&#xd;b</description>` +
      `</channel></channels></serverConfiguration>`;
    const once = adapter.build(adapter.parse(xml));
    const twice = adapter.build(adapter.parse(once));
    // Stable: building again produces the same bytes, with the CR ref intact.
    expect(twice).toBe(once);
    expect(once).toContain('a&#xd;b');
  });

  it('preserves literal text that looks like an entity (&amp;#xd; stays literal)', () => {
    // A script that literally contains the five characters "&#xd;" must NOT be
    // mistaken for a carriage return. In source that is written &amp;#xd;.
    const xml = `<serverConfiguration version="4.5.0">
  <channels>
    <channel version="4.5.0">
      <description>see &amp;#xd; in docs</description>
    </channel>
  </channels>
</serverConfiguration>`;
    const strings = collectStrings(adapter.parse(xml));
    // Decodes to the literal text, NOT a carriage return.
    expect(strings).toContain('see &#xd; in docs');
    expect(strings.some((s) => s.includes('\r'))).toBe(false);
    // And it round-trips back to the doubly-escaped source form.
    const built = adapter.build(adapter.parse(xml));
    expect(built).toContain('see &amp;#xd; in docs');
  });
});
