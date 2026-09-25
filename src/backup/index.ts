/**
 * Server backups: the XML document Mirth's `GET /server/configuration`
 * returns, the same one the Administrator's Backup Config saves, stored as
 * `<server>-<UTC stamp>.xml`. A backup holds every credential in plain text,
 * so files are owner-only and a backup directory channelvault creates ignores
 * itself in git.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { CanonicalConfig, Json } from '../types.js';

/** Default backup directory, relative to the current directory. */
export const DEFAULT_BACKUP_DIR = '.backup';
/** Backups kept per server unless `--keep` says otherwise. */
export const DEFAULT_KEEP = 10;

/** `<server>-20260925T143012Z.xml`, or `-2`, `-3`… after the stamp for a second backup in one second. */
const FILE_NAME = /^(.+)-(\d{8}T\d{6}Z)(?:-(\d+))?\.xml$/;

/** Lower-case letters, digits and single dashes: "VNS Gov" -> "vns-gov". */
export function serverSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The name a backup is filed under: the server name, else the environment
 * name (both in Server Settings), else `fallback` (host and port).
 */
export function backupName(config: CanonicalConfig, fallback: string): string {
  return configuredName(config) || serverSlug(fallback) || 'mirth';
}

/** The server or environment name set in Server Settings, as a slug; '' when neither is. */
export function configuredName(config: CanonicalConfig): string {
  const settings = config['serverSettings'];
  const field = (key: string): string => {
    const v = settings !== null && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, Json>)[key] : undefined;
    return typeof v === 'string' ? serverSlug(v) : '';
  };
  return field('serverName') || field('environmentName');
}

/** `20260925T143012Z` for `date`, in UTC so it sorts and never repeats at a DST change. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export interface BackupFile {
  file: string;
  server: string;
  stamp: string;
  /** Same-second sequence: 1 for the first. */
  seq: number;
}

/** Backups in `dir` by file name, oldest first. Other files are ignored. */
export async function listBackups(dir: string): Promise<BackupFile[]> {
  if (!existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of await readdir(dir)) {
    const m = FILE_NAME.exec(name);
    if (m) out.push({ file: path.join(dir, name), server: m[1]!, stamp: m[2]!, seq: m[3] ? Number(m[3]) : 1 });
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.seq - b.seq);
}

/** The server a backup file name says it came from, or null for a name channelvault didn't make. */
export function serverOfFile(file: string): string | null {
  return FILE_NAME.exec(path.basename(file))?.[1] ?? null;
}

/**
 * Save `xml` as the newest backup of `server` in `dir`, then keep only the
 * newest `keep` of that server's backups (never removing `protect`).
 * Returns the new file's path.
 */
export async function saveBackup(
  dir: string,
  server: string,
  xml: string,
  opts: { keep: number; now?: Date; protect?: string },
): Promise<string> {
  await ensureBackupDir(dir);
  const base = `${server}-${stamp(opts.now ?? new Date())}`;
  let file = path.join(dir, `${base}.xml`);
  for (let n = 2; existsSync(file); n += 1) file = path.join(dir, `${base}-${n}.xml`);
  await writePrivate(file, xml);
  const mine = (await listBackups(dir)).filter((b) => b.server === server);
  const keep = new Set([path.resolve(file), ...(opts.protect ? [path.resolve(opts.protect)] : [])]);
  for (const old of mine.slice(0, Math.max(0, mine.length - opts.keep))) {
    if (!keep.has(path.resolve(old.file))) await rm(old.file);
  }
  return file;
}

/**
 * Create `dir` if needed. A directory channelvault creates gets a
 * `.gitignore` of `*`, so no repository it sits in can commit its backups;
 * an existing directory is left alone (it may be the user's own folder).
 */
export async function ensureBackupDir(dir: string): Promise<void> {
  if (existsSync(dir)) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.gitignore'), '# channelvault backups hold credentials in plain text\n*\n');
}

/** Owner-only, written beside the target and renamed into place. */
export async function writePrivate(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** Compare dotted versions numerically: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
