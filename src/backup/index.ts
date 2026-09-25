/**
 * Server backups: the XML document Mirth's `GET /server/configuration`
 * returns, the same one the Administrator's Backup Config saves, stored as
 * `<server>-<UTC stamp>.xml`. A backup holds every credential in plain text,
 * so files are owner-only (on POSIX; on Windows they inherit the directory's
 * permissions) and a backup directory channelvault creates ignores itself in
 * git.
 *
 * The name in the file name comes from the configuration, which moves between
 * servers (a restore or a whole-server push carries it along). So which server
 * a backup came from is recorded separately, by Mirth's per-installation
 * server ID, in the directory's manifest; choosing and rotating backups go by
 * that.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** Which server each backup in a directory came from. */
export const MANIFEST = 'channelvault-backups.json';

/** Where a backup came from: Mirth's server ID (stable per installation) and, for people, its host. */
export interface Origin {
  serverId: string;
  host: string;
}

type Manifest = Record<string, Origin>;

async function readManifest(dir: string): Promise<Manifest> {
  const file = path.join(dir, MANIFEST);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { files?: Manifest };
    return parsed.files ?? {};
  } catch (err) {
    // Without it no backup can be matched to a server, so none is chosen or rotated.
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}; restore it from a copy or delete it`);
  }
}

async function writeManifest(dir: string, files: Manifest): Promise<void> {
  const present = Object.fromEntries(Object.entries(files).filter(([name]) => existsSync(path.join(dir, name))));
  await writePrivate(path.join(dir, MANIFEST), `${JSON.stringify({ version: 1, files: present }, null, 2)}\n`);
}

/** The backups in `dir` taken from the server with this ID, oldest first. */
export async function backupsOf(dir: string, serverId: string): Promise<BackupFile[]> {
  const manifest = await readManifest(dir);
  return (await listBackups(dir)).filter((b) => manifest[path.basename(b.file)]?.serverId === serverId);
}

/** The recorded origin of `file`, when it is a backup in `dir`'s manifest; else null. */
export async function originOf(dir: string, file: string): Promise<Origin | null> {
  if (!existsSync(dir) || !sameFile(path.dirname(file), dir)) return null;
  return (await readManifest(dir))[path.basename(file)] ?? null;
}

/** The origins recorded in `dir`, for telling someone which servers it has backups of. */
export async function originsIn(dir: string): Promise<Origin[]> {
  if (!existsSync(dir)) return [];
  const seen = new Map<string, Origin>();
  for (const o of Object.values(await readManifest(dir))) seen.set(o.serverId, o);
  return [...seen.values()];
}

/**
 * Save `xml` as the newest backup of the server at `origin`, filed as
 * `<name>-<stamp>.xml` in `dir`, then keep only the newest `keep` backups of
 * that server (never removing `protect`, or any file the manifest doesn't
 * attribute to it). Returns the new file's path.
 */
export async function saveBackup(
  dir: string,
  name: string,
  xml: string,
  opts: { keep: number; origin: Origin; now?: Date; protect?: string },
): Promise<string> {
  await ensureBackupDir(dir);
  const manifest = await readManifest(dir);
  const base = `${name}-${stamp(opts.now ?? new Date())}`;
  let file = path.join(dir, `${base}.xml`);
  for (let n = 2; existsSync(file); n += 1) file = path.join(dir, `${base}-${n}.xml`);
  await writePrivate(file, xml);
  manifest[path.basename(file)] = opts.origin;
  await writeManifest(dir, manifest);

  const mine = (await listBackups(dir)).filter((b) => manifest[path.basename(b.file)]?.serverId === opts.origin.serverId);
  for (const old of mine.slice(0, Math.max(0, mine.length - opts.keep))) {
    if (sameFile(old.file, file) || (opts.protect !== undefined && sameFile(old.file, opts.protect))) continue;
    await rm(old.file);
  }
  await writeManifest(dir, manifest);
  return file;
}

/** Two paths name the same file: links resolved, and case folded where the file system ignores it. */
function sameFile(a: string, b: string): boolean {
  const real = (p: string): string => {
    const resolved = existsSync(p) ? realpathSync.native(p) : path.resolve(p);
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  return real(a) === real(b);
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

/** `4.5.2` (or `4.5.2-SNAPSHOT`) as [4, 5, 2]; null when it does not start with a number. */
export function numericVersion(v: string): number[] | null {
  const m = /^\d+(?:\.\d+)*/.exec(v.trim());
  return m ? m[0].split('.').map(Number) : null;
}

/** Compare dotted versions numerically: negative when `a` is older. Both must pass {@link numericVersion}. */
export function compareVersions(a: string, b: string): number {
  const pa = numericVersion(a)!;
  const pb = numericVersion(b)!;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
