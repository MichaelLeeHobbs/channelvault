/**
 * Carry out a push plan against a server, and afterwards copy the server's new
 * revision numbers back into the tree so the next push compares like with like.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { MirthClientExt } from '../client/index.js';
import { readJson } from '../json.js';
import type { CanonicalConfig, Json } from '../types.js';
import {
  findChannel,
  findTemplate,
  librariesInSync,
  librariesOf,
  librariesToSend,
  list,
  type Change,
  type Plan,
  type Scope,
} from './index.js';

type Obj = Record<string, Json>;

export interface ApplyResult {
  applied: Change[];
  /** The change that failed, if any; nothing after it was attempted. */
  failed?: { change: Change; error: string };
  /** Ids whose revision the server now holds (for refreshing the tree). */
  touchedIds: Set<string>;
}

/** Order matters: templates exist before a library lists them, and leave a library before deletion. */
const ORDER: Array<[Change['kind'], Change['op'][]]> = [
  ['codeTemplate', ['create', 'update']],
  ['library', ['create', 'update', 'delete']],
  ['codeTemplate', ['delete']],
  ['channel', ['create', 'update']],
  ['channel', ['delete']],
  ['globalScripts', ['update']],
];

export async function applyPlan(
  client: MirthClientExt,
  plan: Plan,
  local: CanonicalConfig,
  remote: CanonicalConfig,
  scope: Scope,
  opts: { force?: boolean } = {},
): Promise<ApplyResult> {
  const applied: Change[] = [];
  const touchedIds = new Set<string>();
  let librariesSent = false;

  for (const [kind, ops] of ORDER) {
    for (const change of plan.changes.filter((c) => c.kind === kind && ops.includes(c.op))) {
      try {
        if (kind === 'library') {
          // One PUT replaces the whole list and bumps every library's revision.
          if (!librariesSent) {
            const inSync = librariesInSync(local, remote);
            await client.putCodeTemplateLibraries(librariesToSend(local, remote, scope, plan));
            librariesSent = true;
            // Take the server's new revision only where the tree now holds what
            // was sent; a stale out-of-scope library must keep its old revision
            // so the next push still sees its conflict.
            const sentFromTree = librariesOf(local).filter(
              (l) => scope.libraries === undefined || scope.libraries.includes(String(l['name'])) || scope.libraries.includes(String(l['id'])),
            );
            for (const l of sentFromTree) touchedIds.add(String(l['id']));
            for (const id of inSync) touchedIds.add(id);
          }
        } else if (kind === 'codeTemplate' && change.op === 'delete') {
          await client.deleteCodeTemplate(change.id);
        } else if (kind === 'codeTemplate') {
          await client.putCodeTemplate(findTemplate(local, change.id)!);
        } else if (kind === 'channel' && change.op === 'delete') {
          await client.deleteChannel(change.id);
        } else if (kind === 'channel') {
          await client.putChannel(
            await withServerAssociations(client, findChannel(local, change.id)!, change.op, findChannel(remote, change.id), opts.force === true),
          );
        } else {
          await client.putGlobalScripts(local['globalScripts']);
        }
      } catch (err) {
        return { applied, failed: { change, error: err instanceof Error ? err.message : String(err) }, touchedIds };
      }
      applied.push(change);
      touchedIds.add(change.id);
    }
  }
  return { applied, touchedIds };
}

/**
 * Saving a channel replaces its tag and dependency links with whatever the
 * payload carries, and the server configuration we pulled omits them, so a
 * plain PUT would silently untag the channel (seen on 4.5.2). Carry the
 * server's current links over; push only syncs the channel itself.
 */
const ASSOCIATIONS = ['channelTags', 'dependentIds', 'dependencyIds'];

async function withServerAssociations(
  client: MirthClientExt,
  channel: Obj,
  op: Change['op'],
  planned: Obj | undefined,
  force: boolean,
): Promise<Obj> {
  if (op !== 'update') return channel;
  const server = await client.getChannel(String(channel['id']));
  // Last check before the save (Mirth itself does not reject a stale
  // revision): someone saved this channel after the plan was made.
  const [now, then] = [Number(server?.['revision'] ?? 0), Number(planned?.['revision'] ?? 0)];
  if (!force && now > then) {
    throw new Error(`changed on the server during the push (revision ${now}, planned against ${then}); pull and try again`);
  }
  const serverExport = server?.['exportData'] as Obj | undefined;
  if (!serverExport) return channel;
  const exportData: Obj = { ...((channel['exportData'] as Obj | undefined) ?? {}) };
  for (const key of ASSOCIATIONS) if (key in serverExport) exportData[key] = serverExport[key]!;
  return { ...channel, exportData };
}

export async function deployChannels(
  client: MirthClientExt,
  ids: string[],
  nameOf: (id: string) => string,
): Promise<Array<{ name: string; error: string }>> {
  const failures: Array<{ name: string; error: string }> = [];
  for (const id of ids) {
    try {
      await client.deployChannel(id);
    } catch (err) {
      failures.push({ name: nameOf(id), error: err instanceof Error ? err.message : String(err) });
    }
  }
  return failures;
}

// --- refresh revisions in the tree ------------------------------------------

function copyVersionFields(target: Obj, source: Obj | undefined): boolean {
  if (!source) return false;
  let changed = false;
  for (const key of ['revision', 'lastModified'] as const) {
    if (key in source && JSON.stringify(target[key]) !== JSON.stringify(source[key])) {
      target[key] = source[key]!;
      changed = true;
    }
  }
  const tm = (target['exportData'] as Obj | undefined)?.['metadata'] as Obj | undefined;
  const sm = (source['exportData'] as Obj | undefined)?.['metadata'] as Obj | undefined;
  if (tm && sm && 'lastModified' in sm && JSON.stringify(tm['lastModified']) !== JSON.stringify(sm['lastModified'])) {
    tm['lastModified'] = sm['lastModified']!;
    changed = true;
  }
  return changed;
}

async function jsonFiles(dir: string, name: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name, name)).filter((f) => existsSync(f));
}

/**
 * Copy `revision`/`lastModified` from `server` into the tree's JSON for the
 * given ids. Only those fields change; files are rewritten in the format the
 * explode engine uses, so nothing else shows up in git.
 */
export async function refreshRevisions(root: string, server: CanonicalConfig, ids: Set<string>): Promise<void> {
  for (const file of await jsonFiles(path.join(root, 'channels'), 'channel.json')) {
    const json = await readJson<Obj>(file);
    if (ids.has(String(json['id'])) && copyVersionFields(json, findChannel(server, String(json['id'])))) {
      await writeFile(file, JSON.stringify(json, null, 2));
    }
  }
  const serverLibs = new Map(librariesOf(server).map((l) => [String(l['id']), l]));
  for (const file of await jsonFiles(path.join(root, 'codeTemplates'), 'library.json')) {
    const json = await readJson<Obj>(file);
    let changed = ids.has(String(json['id'])) && copyVersionFields(json, serverLibs.get(String(json['id'])));
    const container = json['codeTemplates'] as Obj | undefined;
    for (const t of list(container?.['codeTemplate'])) {
      if (ids.has(String(t['id'])) && copyVersionFields(t, findTemplate(server, String(t['id'])))) changed = true;
    }
    if (changed) await writeFile(file, JSON.stringify(json, null, 2));
  }
}

