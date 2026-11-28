import { existsSync, realpathSync } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import * as path from 'node:path';

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `child` is `parent` or inside it (case-insensitively on Windows). */
export function isWithin(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(parent), norm(child));
  // `..runtime.env` is a file name, not a step up.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `p` with links resolved as far as it exists (the rest may not be created yet). */
export async function resolvedPath(p: string): Promise<string> {
  const abs = path.resolve(p);
  let existing = abs;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(await realpath(existing), path.relative(existing, abs));
}

/** {@link resolvedPath} for synchronous callers; the native call also expands Windows 8.3 short names. */
export function resolvedPathSync(p: string): string {
  const abs = path.resolve(p);
  let existing = abs;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(realpathSync.native(existing), path.relative(existing, abs));
}

export async function present(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });
}

/** Like {@link resolvedPath}, but also follows a dangling link to where it would write. */
export async function canonical(file: string, depth = 0): Promise<string> {
  if (depth > 64) throw new Error(`too many links in path: ${file}`);
  let existing = path.resolve(file);
  while (!(await present(existing)) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const info = await lstat(existing);
  const base = info.isSymbolicLink()
    ? await canonical(path.resolve(path.dirname(existing), await readlink(existing)), depth + 1)
    : await realpath(existing);
  return path.join(base, path.relative(existing, path.resolve(file)));
}
