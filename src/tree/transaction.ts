import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readlink, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writePrivate } from '../backup/index.js';
import { readJson } from '../json.js';

export const MANAGED_DIRS = ['server', 'channels', 'codeTemplates', 'channelGroups'];
export const STAGING_DIR = '.channelvault-staging';
export const JOURNAL = '.channelvault-transaction.json';
const ITEMS = [...MANAGED_DIRS, 'channelvault.json', '.gitignore', '.secrets', 'env'];
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
interface Entry { name: string; hadOld: boolean }
interface Journal { version: 1; id: string; state: 'prepared' | 'committed'; envFile: string; entries: Entry[] }

async function present(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });
}

async function canonical(file: string, depth = 0): Promise<string> {
  if (depth > 64) throw new Error(`too many links in path: ${file}`);
  let existing = path.resolve(file);
  while (!(await present(existing)) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const info = await lstat(existing);
  const base = info.isSymbolicLink()
    ? await canonical(path.resolve(path.dirname(existing), await readlink(existing)), depth + 1)
    : await realpath(existing);
  return path.join(base, path.relative(existing, path.resolve(file)));
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Retry transient Windows handle contention; every failed swap still has a rollback. */
async function move(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await delay(50 * (attempt + 1));
    }
  }
}

/** A sibling lock leaves a refused first pull's output directory untouched. */
export async function lockTree(root: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(root), { recursive: true });
  const lock = `${await canonical(root)}.channelvault-lock`;
  const ownerFile = path.join(lock, 'owner.json');
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  try { await mkdir(lock); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if ((await lstat(lock)).isSymbolicLink()) throw new Error(`refusing a linked working-tree lock: ${lock}`);
    let previous: typeof owner;
    try { previous = await readJson(ownerFile); }
    catch { throw new Error(`working-tree lock has no readable owner: ${lock}; inspect it before removing it`); }
    const dead = () => {
      if (previous.host !== hostname() || !Number.isInteger(previous.pid) || previous.pid <= 0) return false;
      try { process.kill(previous.pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    if (!dead()) throw new Error(`working tree is locked by process ${previous.pid} on ${previous.host}: ${lock}`);
    // Only one process can reap an abandoned lock. Never recursively remove
    // it: another reaper, or a new owner, must make removal fail safely.
    const reaping = path.join(lock, 'reaping');
    try { await mkdir(reaping); }
    catch { throw new Error(`another process is recovering the working-tree lock: ${lock}; retry`); }
    try {
      const check = await readJson<typeof owner>(ownerFile);
      if (check.token !== previous.token || !dead()) throw new Error(`working-tree lock changed: ${lock}; retry`);
      await unlink(ownerFile);
    } finally { await rmdir(reaping); }
    await rmdir(lock);
    await mkdir(lock);
  }
  try { await writeFile(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (err) { await rmdir(lock).catch(() => undefined); throw err; }
  return async () => {
    const check = await readJson<typeof owner>(ownerFile);
    if (check.token !== owner.token) throw new Error(`working-tree lock ownership changed: ${lock}`);
    await unlink(ownerFile);
    await rmdir(lock);
  };
}

async function assertStage(root: string): Promise<void> {
  for (const suffix of ['', 'next', 'previous']) {
    const stage = path.join(root, STAGING_DIR, suffix);
    const info = await lstat(stage).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return undefined;
    });
    if (info?.isSymbolicLink()) throw new Error(`refusing a linked staging directory: ${stage}`);
  }
}

function targetOf(root: string, journal: Journal, name: string): string {
  return name === 'env' ? journal.envFile : path.join(root, name);
}

function copies(root: string, journal: Journal, name: string): { old: string; next: string } {
  // Both env renames stay beside the selected env file, even on another volume.
  return name === 'env'
    ? { old: `${journal.envFile}.channelvault-${journal.id}.previous`, next: `${journal.envFile}.channelvault-${journal.id}.next` }
    : { old: path.join(root, STAGING_DIR, 'previous', name), next: path.join(root, STAGING_DIR, 'next', name) };
}

async function cleanup(root: string, journal: Journal): Promise<void> {
  if (journal.entries.some(e => e.name === 'env')) {
    const { old, next } = copies(root, journal, 'env');
    await rm(old, { force: true });
    await rm(next, { force: true });
  }
  await rm(path.join(root, STAGING_DIR), RM);
}

async function rollback(root: string, journal: Journal): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const target = targetOf(root, journal, entry.name);
    const { old, next } = copies(root, journal, entry.name);
    if (await present(old)) {
      await rm(target, RM);
      await move(old, target);
    } else if (!entry.hadOld && !(await present(next))) {
      await rm(target, RM);
    }
  }
}

/** Run under the tree lock, before reading any part of a working tree. */
export async function recoverTree(root: string, envFile: string): Promise<void> {
  const file = path.join(root, JOURNAL);
  if (!existsSync(file)) return;
  await assertStage(root);
  const journal = await readJson<Journal>(file);
  if (journal.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.id) || !['prepared', 'committed'].includes(journal.state) ||
      !Array.isArray(journal.entries) || journal.entries.some(e => !ITEMS.includes(e.name) || typeof e.hadOld !== 'boolean') ||
      new Set(journal.entries.map(e => e.name)).size !== journal.entries.length ||
      typeof journal.envFile !== 'string' || !samePath(journal.envFile, await canonical(envFile))) {
    throw new Error(`invalid transaction journal or different env file: ${file}; use the original --dotenv selection to recover`);
  }
  if (journal.state === 'prepared') await rollback(root, journal);
  await cleanup(root, journal);
  await unlink(file);
}

/** Stage everything first, journal the swap, and retain the old generation until commit. */
export async function replaceTree(root: string, envFile: string, prepare: (next: string) => Promise<void>): Promise<void> {
  await recoverTree(root, envFile);
  await assertStage(root);
  const stage = path.join(root, STAGING_DIR);
  await rm(stage, RM); // An unjournaled preparation never touched the old generation.
  const next = path.join(stage, 'next');
  await mkdir(next, { recursive: true });
  let journal: Journal | undefined;
  try {
    await prepare(next);
    const targetEnv = await canonical(envFile);
    journal = { version: 1, id: randomUUID(), state: 'prepared', envFile: targetEnv, entries: [] };
    for (const name of ITEMS) {
      if (!MANAGED_DIRS.includes(name) && !existsSync(path.join(next, name === 'env' ? '.env' : name))) continue;
      const target = targetOf(root, journal, name);
      const info = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; return undefined; });
      journal.entries.push({ name, hadOld: info !== undefined });
    }
    await mkdir(path.join(stage, 'previous'));
    await writePrivate(path.join(root, JOURNAL), JSON.stringify(journal));
    if (journal.entries.some(e => e.name === 'env')) {
      await mkdir(path.dirname(targetEnv), { recursive: true });
      await copyFile(path.join(next, '.env'), copies(root, journal, 'env').next, constants.COPYFILE_EXCL);
    }
    for (const entry of journal.entries) {
      const target = targetOf(root, journal, entry.name);
      const files = copies(root, journal, entry.name);
      if (entry.hadOld) await move(target, files.old);
      if (existsSync(files.next)) {
        await mkdir(path.dirname(target), { recursive: true });
        await move(files.next, target);
      }
    }
    journal.state = 'committed';
    await writePrivate(path.join(root, JOURNAL), JSON.stringify(journal));
  } catch (err) {
    if (journal && existsSync(path.join(root, JOURNAL))) {
      try { await rollback(root, journal); }
      catch (recoveryError) {
        throw new Error(`replacement failed and recovery is pending in ${path.join(root, JOURNAL)}; retry this command with the same env file`, { cause: recoveryError });
      }
      await cleanup(root, journal);
      await unlink(path.join(root, JOURNAL));
    }
    await rm(stage, RM);
    throw err;
  }
  // Cleanup failure leaves a committed journal: the next command cleans up,
  // rather than rolling back a replacement that has already completed.
  await cleanup(root, journal!);
  await unlink(path.join(root, JOURNAL));
}
