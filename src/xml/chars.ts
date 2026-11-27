import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { mapLeaves } from '../secrets/index.js';
import { treeFiles } from '../tree/transaction.js';
import type { CanonicalConfig } from '../types.js';

/**
 * Characters XML 1.0 forbids (https://www.w3.org/TR/xml/#charsets), even as
 * character references. Mirth saves a resource holding one, but its
 * configuration export then fails with HTTP 500, so every later pull, diff,
 * push and restore fails too until the resource is fixed in the Administrator
 * (seen on 4.5.0 with U+FFFE in a code template). With the u flag a paired
 * surrogate is one code point and does not match; only unpaired ones do.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]/gu;

export interface ForbiddenChar {
  /** Resource names, outermost first, then the field: `Lab Feed › deployScript`. */
  where: string;
  line: number;
  /** In code points, as an editor counts them. */
  column: number;
  codePoint: string;
}

const hex = (ch: string): string => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

function positions(text: string): Array<{ line: number; column: number; codePoint: string }> {
  const out: Array<{ line: number; column: number; codePoint: string }> = [];
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    for (const m of line.matchAll(FORBIDDEN)) {
      out.push({ line: i + 1, column: [...line.slice(0, m.index)].length + 1, codePoint: hex(m[0]) });
    }
  });
  return out;
}

/** Every forbidden character in the config's values. Never includes the value itself, which may be a secret. */
export function forbiddenXmlChars(config: CanonicalConfig): ForbiddenChar[] {
  const out: ForbiddenChar[] = [];
  mapLeaves(config, (value, leaf) => {
    const owner = leaf.configMapKey !== undefined ? [`configuration map ${leaf.configMapKey}`] : leaf.labels.length ? leaf.labels : [leaf.location];
    for (const p of positions(value)) out.push({ where: [...owner, leaf.key].join(' › '), ...p });
    return value;
  });
  return out;
}

/** Forbidden characters written literally in a tree's files (scripts hold them verbatim), as `file:line:column`. */
async function forbiddenInFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await treeFiles(root)) {
    for (const p of positions(await readFile(path.join(root, file), 'utf8'))) out.push(`${file}:${p.line}:${p.column} (${p.codePoint})`);
  }
  return out;
}

export async function xmlSafetyProblem(config: CanonicalConfig, treeRoot?: string): Promise<string | undefined> {
  const found = forbiddenXmlChars(config);
  if (found.length === 0) return undefined;
  const files = treeRoot ? await forbiddenInFiles(treeRoot) : [];
  return [
    `${found.length} character(s) that XML 1.0 forbids; Mirth would save them and then fail to export its configuration (HTTP 500), breaking every later pull, push and restore:`,
    ...found.map((f) => `  ${f.where}: line ${f.line}, column ${f.column} of the value (${f.codePoint})`),
    ...(files.length ? ['in the tree:', ...files.map((f) => `  ${f}`)] : []),
    'escape them in the script, for example \\uFFFE inside a regex or string',
  ].join('\n');
}
