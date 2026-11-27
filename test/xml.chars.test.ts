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
