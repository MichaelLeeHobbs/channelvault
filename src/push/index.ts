/**
 * Scoped push: work out which channels, code templates, libraries and global
 * scripts differ between the working tree and the server, and send only
 * those, one resource at a time. Everything else in the server configuration
 * (settings, configuration map, groups, alerts) is left alone and reported if
 * it differs.
 *
 * Both configs are in the live (Jackson JSON) shape, and the local one has its
 * `{{env:…}}` placeholders already rendered.
 */
import { createHash } from 'node:crypto';

import type { CanonicalConfig, Json } from '../types.js';

type Obj = Record<string, Json>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Jackson writes a one-element list as a bare object; normalize to an array. */
export function list(v: Json | undefined): Obj[] {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).filter(isObj);
}

export function channelsOf(c: CanonicalConfig): Obj[] {
  return isObj(c['channels']) ? list(c['channels']['channel']) : [];
}

export function librariesOf(c: CanonicalConfig): Obj[] {
  return isObj(c['codeTemplateLibraries']) ? list(c['codeTemplateLibraries']['codeTemplateLibrary']) : [];
}

export function templatesOf(library: Obj): Obj[] {
  return isObj(library['codeTemplates']) ? list(library['codeTemplates']['codeTemplate']) : [];
}

const idOf = (o: Obj): string => String(o['id']);
const nameOf = (o: Obj): string => String(o['name'] ?? o['id']);
const revisionOf = (o: Obj): number => Number(o['revision'] ?? 0);

/**
 * Mirth rewrites every line ending (CRLF, and a lone CR too) as LF when it
 * saves a channel (seen on 4.5.2), so a line-ending-only difference can never
 * be pushed and would otherwise re-appear on every run.
 */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** `normalizeEol` applied to every string in a config (for display, e.g. `diff`). */
export function normalizeEolDeep<T extends Json>(value: T): T {
  if (typeof value === 'string') return normalizeEol(value) as T;
  if (Array.isArray(value)) return value.map((v) => normalizeEolDeep(v)) as T;
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeEolDeep(v)])) as T;
  return value;
}

/** Key-order-insensitive structural equality, ignoring line-ending style. */
function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return normalizeEol(a) === normalizeEol(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

/** Drop the fields Mirth changes on every save, so they never count as a change. */
function stripVolatile(o: Obj): Obj {
  const out: Obj = { ...o };
  delete out['revision'];
  delete out['lastModified'];
  // Of exportData, compare only the channel's own metadata. Its tags and
  // dependency links are carried over from the server on push, and Mirth
  // flips them between absent and null in GET /server/configuration after
  // unrelated saves (seen on 4.5.2).
  const exportData = out['exportData'];
  if (isObj(exportData)) {
    const metadata = isObj(exportData['metadata']) ? { ...exportData['metadata'] } : undefined;
    if (metadata) {
      delete metadata['lastModified'];
      delete metadata['userId'];
    }
    out['exportData'] = metadata ? { metadata } : {};
  }
  return out;
}

/** A library's own settings and membership, without its templates' contents. */
function libraryShape(lib: Obj): Obj {
  const out = stripVolatile(lib);
  out['codeTemplates'] = templatesOf(lib).map(idOf);
  return out;
}

// --- plan -------------------------------------------------------------------

export type Op = 'create' | 'update' | 'delete';

export interface Change {
  kind: 'channel' | 'library' | 'codeTemplate' | 'globalScripts';
  op: Op;
  id: string;
  /** Display name: channel name, `library/template`, or `global scripts`. */
  label: string;
}

export interface Plan {
  changes: Change[];
  /** Resources the server changed since the tree was pulled. */
  conflicts: string[];
  /** Server resources the tree never had (created since the last pull): left alone, not deleted. */
  serverOnly: string[];
  /** Top-level sections that differ but that scoped push does not send. */
  notPushed: string[];
  /** Channels to redeploy with --deploy: changed ones and users of changed libraries. */
  deployIds: string[];
}

export interface Scope {
  /** Channel names or ids; undefined = all. */
  channels?: string[];
  /** Library names or ids; undefined = all. */
  libraries?: string[];
  globalScripts?: boolean;
}

/**
 * Resource ids the tree held when it was last pulled. A server resource the
 * tree lacks is a local deletion only if the tree once had it; otherwise it
 * was created on the server since the pull, and deleting it would destroy
 * someone else's work.
 */
export interface Known {
  /** id -> revision when last synced (null: unknown, from an older tree). */
  channels: Record<string, number | null>;
  libraries: Record<string, number | null>;
  codeTemplates: Record<string, number | null>;
  /** Hash of the global scripts when last synced; they carry no revision. */
  globalScripts?: string;
}

export function hashGlobalScripts(c: CanonicalConfig): string {
  return createHash('sha256').update(JSON.stringify(normalizeEolDeep((c['globalScripts'] ?? null) as Json))).digest('hex');
}

/** The sync baseline for a config: every resource's revision, plus the global scripts' hash. */
export function resourceIds(c: CanonicalConfig): Known {
  const libs = librariesOf(c);
  const revs = (items: Obj[]) => Object.fromEntries(items.map((o) => [idOf(o), revisionOf(o)]));
  return {
    channels: revs(channelsOf(c)),
    libraries: revs(libs),
    codeTemplates: revs(libs.flatMap(templatesOf)),
    globalScripts: hashGlobalScripts(c),
  };
}

/** Accept the older id-list form of the baseline (no revisions). */
export function knownFrom(raw: unknown): Known | undefined {
  if (!isObj(raw as Json)) return undefined;
  const r = raw as Record<string, unknown>;
  const map = (v: unknown): Record<string, number | null> =>
    Array.isArray(v) ? Object.fromEntries(v.map((id) => [String(id), null])) : ((v ?? {}) as Record<string, number | null>);
  return {
    channels: map(r['channels']),
    libraries: map(r['libraries']),
    codeTemplates: map(r['codeTemplates']),
    globalScripts: typeof r['globalScripts'] === 'string' ? r['globalScripts'] : undefined,
  };
}

/**
 * The baseline after a push: resources the push wrote take the server's new
 * revision, created ones join, deleted ones leave; everything else keeps its
 * old baseline, so a colleague's unpulled change still reads as a conflict.
 */
export function knownAfterPush(known: Known, applied: Change[], touched: Set<string>, fresh: CanonicalConfig): Known {
  const now = resourceIds(fresh);
  const next: Known = {
    channels: { ...known.channels },
    libraries: { ...known.libraries },
    codeTemplates: { ...known.codeTemplates },
    globalScripts: known.globalScripts,
  };
  const key = { channel: 'channels', library: 'libraries', codeTemplate: 'codeTemplates' } as const;
  for (const c of applied) {
    if (c.kind === 'globalScripts') {
      next.globalScripts = now.globalScripts;
    } else if (c.op === 'delete') {
      delete next[key[c.kind]][c.id];
    }
  }
  for (const k of ['channels', 'libraries', 'codeTemplates'] as const) {
    for (const id of touched) if (id in now[k]) next[k][id] = now[k][id]!;
  }
  return next;
}

/** The server-configuration sections scoped push handles. */
const HANDLED = new Set(['channels', 'codeTemplateLibraries', 'globalScripts', 'date']);

function selectedBy(names: string[] | undefined, what: string, local: Obj[], remote: Obj[]): (o: Obj) => boolean {
  if (names === undefined) return () => true;
  const known = [...local, ...remote];
  for (const n of names) {
    if (!known.some((o) => nameOf(o) === n || idOf(o) === n)) throw new Error(`no ${what} named "${n}" in the tree or on the server`);
  }
  return (o) => names.includes(nameOf(o)) || names.includes(idOf(o));
}

/**
 * With --library, the library list sent mixes the tree's in-scope libraries
 * with the server's others, so a template moved across that boundary would end
 * up in two libraries or in none. Refuse instead.
 */
function assertNoMovesAcrossScope(ll: Obj[], rl: Obj[], inScope: (o: Obj) => boolean): void {
  const owner = (libs: Obj[]) => new Map(libs.flatMap((l) => templatesOf(l).map((t) => [idOf(t), l] as const)));
  const localOwner = owner(ll);
  for (const [id, r] of owner(rl)) {
    const l = localOwner.get(id);
    if (l && idOf(l) !== idOf(r) && inScope(l) !== inScope(r)) {
      throw new Error(
        `code template "${nameOf(templatesOf(l).find((t) => idOf(t) === id)!)}" moved from "${nameOf(r)}" to "${nameOf(l)}"; include both with --library`,
      );
    }
  }
}

/**
 * Libraries whose tree copy matched the server before a push. The library-list
 * PUT bumps every library's revision; copying the new revision into these is
 * safe, but copying it into a stale library would hide a real conflict.
 */
export function librariesInSync(local: CanonicalConfig, remote: CanonicalConfig): string[] {
  const rl = new Map(librariesOf(remote).map((l) => [idOf(l), l]));
  return librariesOf(local)
    .filter((l) => {
      const r = rl.get(idOf(l));
      return r !== undefined && revisionOf(r) === revisionOf(l) && same(libraryShape(l), libraryShape(r));
    })
    .map(idOf);
}

/** Channels a library's code is available to, per its include/enable/disable settings. */
function channelsUsing(lib: Obj, allChannelIds: string[]): string[] {
  const ids = (v: Json | undefined): string[] =>
    isObj(v) ? (Array.isArray(v['string']) ? v['string'] : v['string'] != null ? [v['string']] : []).map(String) : [];
  if (lib['includeNewChannels'] === true) {
    const disabled = new Set(ids(lib['disabledChannelIds']));
    return allChannelIds.filter((id) => !disabled.has(id));
  }
  const enabled = new Set(ids(lib['enabledChannelIds']));
  return allChannelIds.filter((id) => enabled.has(id));
}

export function planPush(local: CanonicalConfig, remote: CanonicalConfig, scope: Scope = {}, known?: Known): Plan {
  const everything = scope.channels === undefined && scope.libraries === undefined && scope.globalScripts === undefined;
  const channelScope = everything || scope.channels !== undefined;
  const libraryScope = everything || scope.libraries !== undefined;
  const changes: Change[] = [];
  const conflicts: string[] = [];
  const deploy = new Set<string>();
  const serverOnly: string[] = [];
  /** A server resource missing from the tree: a planned delete, unless the tree never had it. */
  const missingLocally = (
    kind: 'channel' | 'library' | 'codeTemplate',
    r: Obj,
    label: string,
    baseline?: Record<string, number | null>,
  ): void => {
    const what = `${kind === 'codeTemplate' ? 'code template' : kind} "${label}"`;
    if (baseline && !(idOf(r) in baseline)) {
      serverOnly.push(what);
      return;
    }
    // Deleted locally, but edited on the server since the last pull: the
    // delete would discard someone else's work, so it is a conflict too.
    const pulled = baseline?.[idOf(r)];
    if (pulled != null && revisionOf(r) > pulled) {
      conflicts.push(`${what} changed on the server since the last pull (revision ${revisionOf(r)}, pulled ${pulled}); deleting it would discard that`);
    }
    changes.push({ kind, op: 'delete', id: idOf(r), label });
  };

  // Channels
  if (channelScope) {
    const lc = channelsOf(local);
    const rc = channelsOf(remote);
    const inScope = selectedBy(scope.channels, 'channel', lc, rc);
    const remoteById = new Map(rc.map((c) => [idOf(c), c]));
    const localIds = new Set(lc.map(idOf));
    for (const c of lc.filter(inScope)) {
      const r = remoteById.get(idOf(c));
      if (!r) {
        changes.push({ kind: 'channel', op: 'create', id: idOf(c), label: nameOf(c) });
      } else if (!same(stripVolatile(c), stripVolatile(r))) {
        changes.push({ kind: 'channel', op: 'update', id: idOf(c), label: nameOf(c) });
        if (revisionOf(r) > revisionOf(c)) conflicts.push(`channel "${nameOf(c)}" (server revision ${revisionOf(r)}, tree ${revisionOf(c)})`);
      } else {
        continue;
      }
      deploy.add(idOf(c));
    }
    for (const r of rc.filter(inScope)) {
      if (!localIds.has(idOf(r))) missingLocally('channel', r, nameOf(r), known?.channels);
    }
  }

  // The channels as they will be after this push: the server's, minus planned
  // deletes, with the tree's copy where the push writes one. Redeploys are
  // computed from these, so a channel created on the server since the pull,
  // or outside --channel, still gets a changed library's new code.
  const deletedChannels = new Set(changes.filter((c) => c.kind === 'channel' && c.op === 'delete').map((c) => c.id));
  const writtenChannels = new Set(changes.filter((c) => c.kind === 'channel' && c.op !== 'delete').map((c) => c.id));
  const effective = new Map<string, Obj>();
  for (const r of channelsOf(remote)) if (!deletedChannels.has(idOf(r))) effective.set(idOf(r), r);
  for (const l of channelsOf(local)) if (writtenChannels.has(idOf(l))) effective.set(idOf(l), l);

  // Code templates and libraries
  if (libraryScope) {
    const ll = librariesOf(local);
    const rl = librariesOf(remote);
    const inScope = selectedBy(scope.libraries, 'library', ll, rl);
    if (scope.libraries !== undefined) assertNoMovesAcrossScope(ll, rl, inScope);
    const remoteLibById = new Map(rl.map((l) => [idOf(l), l]));
    const remoteTemplates = new Map(rl.flatMap((l) => templatesOf(l).map((t) => [idOf(t), t] as const)));
    const localTemplateIds = new Set(ll.flatMap((l) => templatesOf(l).map(idOf)));
    const allChannelIds = [...effective.keys()];

    for (const lib of ll.filter(inScope)) {
      const r = remoteLibById.get(idOf(lib));
      let touched = false;
      if (!r || !same(libraryShape(lib), libraryShape(r))) {
        changes.push({ kind: 'library', op: r ? 'update' : 'create', id: idOf(lib), label: nameOf(lib) });
        touched = true;
        if (r && revisionOf(r) > revisionOf(lib)) conflicts.push(`library "${nameOf(lib)}" (server revision ${revisionOf(r)}, tree ${revisionOf(lib)})`);
      }
      for (const t of templatesOf(lib)) {
        const rt = remoteTemplates.get(idOf(t));
        const label = `${nameOf(lib)}/${nameOf(t)}`;
        if (!rt) {
          changes.push({ kind: 'codeTemplate', op: 'create', id: idOf(t), label });
        } else if (!same(stripVolatile(t), stripVolatile(rt))) {
          changes.push({ kind: 'codeTemplate', op: 'update', id: idOf(t), label });
          if (revisionOf(rt) > revisionOf(t)) conflicts.push(`code template "${label}" (server revision ${revisionOf(rt)}, tree ${revisionOf(t)})`);
        } else {
          continue;
        }
        touched = true;
      }
      // Channels using it before or after the push both need a redeploy: one
      // losing access to the library must stop running its old code too.
      if (touched) {
        for (const id of channelsUsing(lib, allChannelIds)) deploy.add(id);
        if (r) for (const id of channelsUsing(r, allChannelIds)) deploy.add(id);
      }
    }
    for (const r of rl.filter(inScope)) {
      if (!ll.some((l) => idOf(l) === idOf(r))) {
        const before = changes.length;
        missingLocally('library', r, nameOf(r), known?.libraries);
        if (changes.length > before) for (const id of channelsUsing(r, allChannelIds)) deploy.add(id);
      }
      for (const t of templatesOf(r)) {
        if (!localTemplateIds.has(idOf(t))) missingLocally('codeTemplate', t, `${nameOf(r)}/${nameOf(t)}`, known?.codeTemplates);
      }
    }
  }

  // Global scripts
  if ((everything || scope.globalScripts === true) && !same(local['globalScripts'], remote['globalScripts'])) {
    changes.push({ kind: 'globalScripts', op: 'update', id: 'globalScripts', label: 'global scripts' });
    // No revision to compare, so compare against the hash taken at the last sync.
    if (known?.globalScripts && hashGlobalScripts(remote) !== known.globalScripts) {
      conflicts.push('global scripts changed on the server since the last pull');
    }
  }

  const notPushed = everything
    ? [...new Set([...Object.keys(local), ...Object.keys(remote)])]
        .filter((k) => !HANDLED.has(k) && !k.startsWith('@') && !same(local[k], remote[k]))
        .sort()
    : [];

  // Only enabled channels that will exist after the push can be deployed.
  const enabled = new Set(
    [...effective.values()]
      .filter((c) => {
        const md = isObj(c['exportData']) ? c['exportData']['metadata'] : undefined;
        return !(isObj(md) && md['enabled'] === false);
      })
      .map(idOf),
  );

  return {
    changes,
    conflicts,
    serverOnly,
    notPushed,
    deployIds: [...deploy].filter((id) => enabled.has(id)),
  };
}

/**
 * The full library list to send when the plan has library changes (Mirth only
 * replaces the whole list): the tree's version of each library in scope and the
 * server's version of the rest, so a scoped push never touches other libraries.
 */
export function librariesToSend(local: CanonicalConfig, remote: CanonicalConfig, scope: Scope, plan: Plan): Obj[] {
  const ll = librariesOf(local);
  const rl = librariesOf(remote);
  const inScope =
    scope.libraries === undefined ? () => true : (o: Obj) => scope.libraries!.includes(nameOf(o)) || scope.libraries!.includes(idOf(o));
  // Start from the server's list: a library leaves it only through a planned
  // (and approved) delete, so one created on the server since the pull survives.
  const deleted = new Set(plan.changes.filter((c) => c.kind === 'library' && c.op === 'delete').map((c) => c.id));
  const localById = new Map(ll.map((l) => [idOf(l), l]));
  const out: Obj[] = [];
  for (const r of rl) {
    if (deleted.has(idOf(r))) continue;
    const l = localById.get(idOf(r));
    out.push(l && inScope(l) ? l : r);
  }
  for (const l of ll) if (inScope(l) && !rl.some((r) => idOf(r) === idOf(l))) out.push(l);
  return out;
}

/**
 * Planned resources whose server copy changed between `before` (what the plan
 * was made from) and `after`. Run after the confirmation prompt: an edit made
 * in the Administrator while it was open must not be overwritten.
 */
export function changedSince(plan: Plan, before: CanonicalConfig, after: CanonicalConfig): string[] {
  const out: string[] = [];
  const libs = (c: CanonicalConfig) => new Map(librariesOf(c).map((l) => [idOf(l), l]));
  const [lb, la] = [libs(before), libs(after)];
  for (const c of plan.changes) {
    let a: Obj | undefined;
    let b: Obj | undefined;
    if (c.kind === 'channel') [b, a] = [findChannel(before, c.id), findChannel(after, c.id)];
    else if (c.kind === 'codeTemplate') [b, a] = [findTemplate(before, c.id), findTemplate(after, c.id)];
    else if (c.kind === 'library') [b, a] = [lb.get(c.id), la.get(c.id)];
    else if (!same(before['globalScripts'], after['globalScripts'])) out.push('global scripts');
    if (c.kind === 'globalScripts') continue;
    const existed = b !== undefined;
    const exists = a !== undefined;
    if (existed !== exists || (a && b && revisionOf(a) !== revisionOf(b))) out.push(`${c.kind} "${c.label}"`);
  }
  // The library-list save replaces every library, not just the planned ones:
  // any library added, removed or changed meanwhile would be reverted.
  if (plan.changes.some((c) => c.kind === 'library')) {
    const shape = (m: Map<string, Obj>) => [...m].map(([id, l]) => `${id}@${revisionOf(l)}`).sort().join(',');
    if (shape(lb) !== shape(la)) out.push('code template libraries (the library list is saved as a whole)');
  }
  return [...new Set(out)];
}

/** Two server configurations hold the same data (ignoring the export `date`, which every GET changes). */
export function sameServerConfig(a: CanonicalConfig, b: CanonicalConfig): boolean {
  const { date: _a, ...ra } = a;
  const { date: _b, ...rb } = b;
  return same(ra as Json, rb as Json);
}

/** Find a code template by id in a config. */
export function findTemplate(c: CanonicalConfig, id: string): Obj | undefined {
  for (const lib of librariesOf(c)) for (const t of templatesOf(lib)) if (idOf(t) === id) return t;
  return undefined;
}

/** Find a channel by id in a config. */
export function findChannel(c: CanonicalConfig, id: string): Obj | undefined {
  return channelsOf(c).find((ch) => idOf(ch) === id);
}
