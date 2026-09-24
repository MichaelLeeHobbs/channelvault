/**
 * `.env` file read/update. Updates rewrite only the lines they touch, so
 * comments and hand-added variables survive a pull.
 */
import { existsSync } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { parse } from 'dotenv';

/**
 * Marks a value stored base64-encoded because no dotenv quoting can carry it
 * exactly (dotenv turns CRLF into LF, and each quote style excludes some
 * characters), e.g. a configuration-map JSON with Windows line endings.
 */
const BASE64_PREFIX = 'cv-base64:';

/** Parse env-file text, decoding values channelvault had to store base64-encoded. */
export function parseEnv(text: string): Record<string, string> {
  const out = parse(text);
  for (const [k, v] of Object.entries(out)) {
    if (v.startsWith(BASE64_PREFIX)) out[k] = Buffer.from(v.slice(BASE64_PREFIX.length), 'base64').toString('utf8');
  }
  return out;
}

export async function readEnvFile(file: string): Promise<Record<string, string>> {
  if (!existsSync(file)) return {};
  return parseEnv(await readFile(file, 'utf8'));
}

/**
 * Serialize a value so it reads back unchanged. Tries bare, single, backtick
 * and double quotes in turn and proves the choice by parsing it; falls back to
 * base64 for values none of them can carry.
 */
export function formatValue(value: string): string {
  const candidates = [
    /^[\w@%+=:,./-]*$/.test(value) && !value.startsWith(BASE64_PREFIX) ? value : null,
    value.includes("'") ? null : `'${value}'`,
    value.includes('`') ? null : `\`${value}\``,
    value.includes('"') ? null : `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`,
  ];
  for (const c of candidates) {
    if (c !== null && parseEnv(`K=${c}`)['K'] === value) return c;
  }
  return `${BASE64_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
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

/** How many superseded env files to keep; old secrets should not pile up on disk. */
export const ENV_BACKUPS_KEPT = 5;

/**
 * Before `updates` overwrite a value already in `file`, copy the file to
 * `<dir>/<name>-<UTC timestamp>` (the tree's git-ignored `.secrets/`), keeping the newest
 * {@link ENV_BACKUPS_KEPT}. Adding new variables loses nothing, so it makes
 * no copy. Returns the backup path, or null if none was needed.
 */
export async function backupEnvFile(file: string, updates: Record<string, string>, dir: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  const current = parseEnv(await readFile(file, 'utf8'));
  if (!Object.entries(updates).some(([k, v]) => current[k] !== undefined && current[k] !== v)) return null;

  await mkdir(dir, { recursive: true });
  const prefix = `${path.basename(file)}-`;
  // 20260924T173321.123Z: sorts chronologically; a same-millisecond collision gets -02, -03…
  const stamp = new Date().toISOString().replace(/[-:]/g, '');
  let target = path.join(dir, `${prefix}${stamp}`);
  for (let n = 2; existsSync(target); n += 1) target = path.join(dir, `${prefix}${stamp}-${String(n).padStart(2, '0')}`);
  await copyFile(file, target);
  await chmod(target, 0o600);

  // Prune the oldest, never the copy just made.
  const others = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f !== path.basename(target)).sort();
  for (const old of others.slice(0, Math.max(0, others.length - (ENV_BACKUPS_KEPT - 1)))) {
    await rm(path.join(dir, old));
  }
  return target;
}

const IGNORE_LINES = ['.env', '.env.*', '!.env.example', '.secrets/'];

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
