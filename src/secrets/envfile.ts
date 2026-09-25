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
  const written = new Set<string>();
  const out: string[] = [];
  // Inside a multi-line quoted value (of any variable), lines are value text,
  // never assignments. `dropping` marks the continuation lines of a value
  // being replaced.
  let inQuote: string | null = null;
  let dropping = false;
  for (const line of lines) {
    if (inQuote !== null) {
      if (!dropping) out.push(line);
      if (line.includes(inQuote)) [inQuote, dropping] = [null, false];
      continue;
    }
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    const q = m?.[2]![0];
    const opens = (q === '"' || q === "'" || q === '`') && m![2]!.lastIndexOf(q) === 0 ? q : null;
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1]!)) {
      // Replace the first assignment and drop later duplicates: dotenv uses the
      // last one, so a stale duplicate would stay in effect.
      if (!written.has(m[1]!)) {
        out.push(`${m[1]}=${formatValue(updates[m[1]!]!)}`);
        written.add(m[1]!);
      }
      if (opens) [inQuote, dropping] = [opens, true];
      continue;
    }
    out.push(line);
    if (opens) inQuote = opens;
  }
  for (const name of names) {
    if (!written.has(name)) out.push(`${name}=${formatValue(updates[name]!)}`);
  }
  const text = `${out.join('\n')}\n`;
  // Prove the file says what we mean before replacing it.
  const readBack = parseEnv(text);
  const wrong = names.filter((n) => readBack[n] !== updates[n]);
  if (wrong.length > 0) throw new Error(`env file update would not read back correctly for ${wrong.join(', ')}; nothing written`);
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
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
export async function ensureEnvIgnored(dir: string, envFile?: string): Promise<boolean> {
  const file = path.join(dir, '.gitignore');
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const wanted = [...IGNORE_LINES];
  // The chosen env file itself, when the standard patterns miss its name
  // (e.g. `--dotenv secrets.prod`).
  if (envFile) {
    const rel = path.relative(dir, envFile).split(path.sep).join('/');
    const base = path.basename(envFile);
    const covered = !rel.includes('/') && (base === '.env' || (base.startsWith('.env.') && base !== '.env.example'));
    if (!covered && !rel.startsWith('..') && !path.isAbsolute(rel)) wanted.push(`/${rel}`);
  }
  const missing = wanted.filter((l) => !present.has(l));
  if (missing.length === 0) return false;
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${prefix}# channelvault: secrets and per-environment values\n${missing.join('\n')}\n`);
  return true;
}
