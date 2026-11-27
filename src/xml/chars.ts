import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { mapLeaves } from '../secrets/index.js';
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
  /** Resource names, outermost first, then the field: `Lab Feed › Source › script`. */
  where: string;
  line: number;
  column: number;
  codePoint: string;
}

const hex = (ch: string): string => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

function positions(text: string): Array<{ line: number; column: number; codePoint: string }> {
  const out: Array<{ line: number; column: number; codePoint: string }> = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(FORBIDDEN)) out.push({ line: i + 1, column: m.index + 1, codePoint: hex(m[0]) });
  });
  return out;
}

/** Every forbidden character in the config's values. Never includes the value itself, which may be a secret. */
export function forbiddenXmlChars(config: CanonicalConfig): ForbiddenChar[] {
  const out: ForbiddenChar[] = [];
  mapLeaves(config, (value, leaf) => {
    for (const p of positions(value)) out.push({ where: [...leaf.labels, leaf.key].join(' › '), ...p });
    return value;
  });
  return out;
}

/** Forbidden characters written literally in a tree's files (scripts hold them verbatim), as `file:line:column`. */
export async function forbiddenXmlCharsInFiles(root: string, dirs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(path.join(root, dir), { recursive: true, withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const file = path.join(e.parentPath, e.name);
      for (const p of positions(await readFile(file, 'utf8'))) {
        out.push(`${path.relative(root, file).split(path.sep).join('/')}:${p.line}:${p.column} (${p.codePoint})`);
      }
    }
  }
  return out;
}

/** The refusal message, or undefined when the config is safe to send. */
export async function xmlSafetyProblem(config: CanonicalConfig, tree?: { root: string; dirs: readonly string[] }): Promise<string | undefined> {
  const found = forbiddenXmlChars(config);
  if (found.length === 0) return undefined;
  const files = tree ? await forbiddenXmlCharsInFiles(tree.root, tree.dirs) : [];
  return [
    `${found.length} character(s) that XML 1.0 forbids; Mirth would save them and then fail to export its configuration (HTTP 500), breaking every later pull, push and restore:`,
    ...found.map((f) => `  ${f.where}: line ${f.line}, column ${f.column} of the value (${f.codePoint})`),
    ...(files.length ? ['in the tree:', ...files.map((f) => `  ${f}`)] : []),
    'escape them in the script (for example \\uFFFE inside a regex or string) and try again',
  ].join('\n');
}
