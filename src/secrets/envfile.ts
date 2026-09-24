/**
 * `.env` file read/update. Updates rewrite only the lines they touch, so
 * comments and hand-added variables survive a pull.
 */
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { parse } from 'dotenv';

export async function readEnvFile(file: string): Promise<Record<string, string>> {
  if (!existsSync(file)) return {};
  return parse(await readFile(file, 'utf8'));
}

/**
 * Serialize a value so dotenv parses it back unchanged. Tries bare, single,
 * backtick and double quotes in turn and proves the choice by parsing it.
 */
export function formatValue(value: string): string {
  const candidates = [
    /^[\w@%+=:,./-]*$/.test(value) ? value : null,
    value.includes("'") ? null : `'${value}'`,
    value.includes('`') ? null : `\`${value}\``,
    value.includes('"') ? null : `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`,
  ];
  for (const c of candidates) {
    if (c !== null && parse(`K=${c}`)['K'] === value) return c;
  }
  throw new Error('value cannot be represented in a .env file (it mixes quote characters with escapes)');
}

/** Set `updates` in `file`, replacing existing assignments in place and appending new ones. */
export async function updateEnvFile(file: string, updates: Record<string, string>): Promise<void> {
  const names = Object.keys(updates);
  if (names.length === 0) return;
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  const lines = existing === '' ? [] : existing.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const pending = new Set(names);
  // A multi-line quoted value spans several lines; we only rewrite the line
  // that starts the assignment and drop its continuation lines.
  const out: string[] = [];
  let skipUntilQuote: string | null = null;
  for (const line of lines) {
    if (skipUntilQuote !== null) {
      if (line.includes(skipUntilQuote)) skipUntilQuote = null;
      continue;
    }
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (m && pending.has(m[1]!)) {
      out.push(`${m[1]}=${formatValue(updates[m[1]!]!)}`);
      pending.delete(m[1]!);
      const q = m[2]![0];
      if ((q === '"' || q === "'" || q === '`') && m[2]!.lastIndexOf(q) === 0) skipUntilQuote = q;
      continue;
    }
    out.push(line);
  }
  for (const name of names) {
    if (pending.has(name)) out.push(`${name}=${formatValue(updates[name]!)}`);
  }
  await writeFile(file, `${out.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

const IGNORE_LINES = ['.env', '.env.*', '!.env.example'];

/** Make sure `dir/.gitignore` keeps env files out of git. Returns true if it changed. */
export async function ensureEnvIgnored(dir: string): Promise<boolean> {
  const file = path.join(dir, '.gitignore');
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return false;
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${prefix}# channelvault: secrets and per-environment values\n${missing.join('\n')}\n`);
  return true;
}
