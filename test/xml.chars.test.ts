import { describe, expect, it } from 'vitest';

import { forbiddenXmlChars } from '../src/xml/chars.js';

const config = (code: string) => ({ channels: { channel: [{ id: 'c1', name: 'Lab Feed', deployScript: code }] } });

describe('forbiddenXmlChars', () => {
  it.each([
    ['a C0 control', 'a\u0001', 'U+0001'],
    ['U+FFFE', '/[\uFFFE]/', 'U+FFFE'],
    ['U+FFFF', '\uFFFF', 'U+FFFF'],
    ['an unpaired high surrogate', 'x\uD83D', 'U+D83D'],
    ['an unpaired low surrogate', '\uDE00x', 'U+DE00'],
  ])('finds %s', (_label, code, codePoint) => {
    expect(forbiddenXmlChars(config(code)).map(f => f.codePoint)).toEqual([codePoint]);
  });

  it('allows tab, line breaks, astral characters and the rest of the BMP', () => {
    expect(forbiddenXmlChars(config('\t\r\n😀 \uFFFD \uE000 é'))).toEqual([]);
  });

  it('reports the line and column within the value, and never the value', () => {
    expect(forbiddenXmlChars(config('ok\nsecret\u0002'))).toEqual([{ where: 'Lab Feed › deployScript', line: 2, column: 7, codePoint: 'U+0002' }]);
  });
});

describe('where a forbidden character is reported', () => {
  it('names a configuration-map entry by key and never shows the value', async () => {
    const { xmlSafetyProblem } = await import('../src/xml/chars.js');
    const map = { configurationMap: { entry: [{ string: 'DB_PASSWORD', 'com.mirth.connect.util.ConfigurationProperty': { value: 'hunter2\u0007', comment: '' } }] } };
    const message = await xmlSafetyProblem(map);
    expect(message).toContain('configuration map DB_PASSWORD › value: line 1, column 8 of the value (U+0007)');
    expect(message).not.toContain('hunter2');
  });

  it('counts columns in code points and lone CR as a line break', () => {
    expect(forbiddenXmlChars(config('\u{1F600}\u0001\rx\u0002'))).toMatchObject([
      { line: 1, column: 2, codePoint: 'U+0001' },
      { line: 2, column: 2, codePoint: 'U+0002' },
    ]);
  });

  it('names a code template by its library and name', () => {
    const lib = { codeTemplateLibraries: { codeTemplateLibrary: [{ name: 'Utils', codeTemplates: { codeTemplate: [{ name: 'stringUtils', properties: { code: '/[\uFFFE]/' } }] } }] } };
    expect(forbiddenXmlChars(lib)).toEqual([{ where: 'Utils › stringUtils › code', line: 1, column: 3, codePoint: 'U+FFFE' }]);
  });
});
