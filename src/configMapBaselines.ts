/**
 * Configuration-map baselines, one owner-only file per installation in
 * `~/.channelvault/config-map-baselines/`. Per machine rather than per tree:
 * every checkout and worktree of a server's tree shares the server's map,
 * and the hashes stay out of git.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { writePrivate } from './backup/index.js';
import { readJson } from './json.js';
import { configDir } from './profiles.js';
import type { ConfigMapBaseline } from './push/configMap.js';

export const BASELINES_DIR = 'config-map-baselines';

/** Installation IDs are free text (an admin can set one), so the file is named by a hash of it. */
function fileFor(serverId: string): string {
  return path.join(configDir(), BASELINES_DIR, `${createHash('sha256').update(serverId).digest('hex').slice(0, 32)}.json`);
}

export async function readConfigMapBaseline(serverId: string): Promise<ConfigMapBaseline | undefined> {
  const file = fileFor(serverId);
  if (!existsSync(file)) return undefined;
  const stored = await readJson<{ serverId?: unknown; entries?: unknown }>(file);
  if (stored.serverId !== serverId || typeof stored.entries !== 'object' || stored.entries === null) return undefined;
  return stored.entries as ConfigMapBaseline;
}

export async function writeConfigMapBaseline(serverId: string, entries: ConfigMapBaseline): Promise<void> {
  const file = fileFor(serverId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writePrivate(file, `${JSON.stringify({ serverId, entries }, null, 2)}\n`);
}
