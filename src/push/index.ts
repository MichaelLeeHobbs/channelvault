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
  channels: string[];
  libraries: string[];
  codeTemplates: string[];
}

export function resourceIds(c: CanonicalConfig): Known {
  const libs = librariesOf(c);
  return {
    channels: channelsOf(c).map(idOf),
    libraries: libs.map(idOf),
    codeTemplates: libs.flatMap((l) => templatesOf(l).map(idOf)),
  };
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
  const missingLocally = (kind: 'channel' | 'library' | 'codeTemplate', r: Obj, label: string, knownIds?: string[]): void => {
    if (knownIds && !knownIds.includes(idOf(r))) {
      serverOnly.push(`${kind === 'codeTemplate' ? 'code template' : kind} "${label}"`);
    } else {
      changes.push({ kind, op: 'delete', id: idOf(r), label });
    }
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

  // Code templates and libraries
  if (libraryScope) {
    const ll = librariesOf(local);
    const rl = librariesOf(remote);
    const inScope = selectedBy(scope.libraries, 'library', ll, rl);
    if (scope.libraries !== undefined) assertNoMovesAcrossScope(ll, rl, inScope);
    const remoteLibById = new Map(rl.map((l) => [idOf(l), l]));
    const remoteTemplates = new Map(rl.flatMap((l) => templatesOf(l).map((t) => [idOf(t), t] as const)));
    const localTemplateIds = new Set(ll.flatMap((l) => templatesOf(l).map(idOf)));
    const allChannelIds = channelsOf(local).map(idOf);

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
      if (touched) for (const id of channelsUsing(lib, allChannelIds)) deploy.add(id);
    }
    for (const r of rl.filter(inScope)) {
      if (!ll.some((l) => idOf(l) === idOf(r))) missingLocally('library', r, nameOf(r), known?.libraries);
      for (const t of templatesOf(r)) {
        if (!localTemplateIds.has(idOf(t))) missingLocally('codeTemplate', t, `${nameOf(r)}/${nameOf(t)}`, known?.codeTemplates);
      }
    }
  }

  // Global scripts
  if ((everything || scope.globalScripts === true) && !same(local['globalScripts'], remote['globalScripts'])) {
    changes.push({ kind: 'globalScripts', op: 'update', id: 'globalScripts', label: 'global scripts' });
  }

  const notPushed = everything
    ? [...new Set([...Object.keys(local), ...Object.keys(remote)])]
        .filter((k) => !HANDLED.has(k) && !k.startsWith('@') && !same(local[k], remote[k]))
        .sort()
    : [];

  // Only enabled channels that will exist after the push can be deployed.
  const enabled = new Set(
    channelsOf(local)
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
export function librariesToSend(local: CanonicalConfig, remote: CanonicalConfig, scope: Scope = {}): Obj[] {
  const ll = librariesOf(local);
  const rl = librariesOf(remote);
  if (scope.libraries === undefined) return ll;
  const inScope = (o: Obj) => scope.libraries!.includes(nameOf(o)) || scope.libraries!.includes(idOf(o));
  const out = rl.map((r) => (inScope(r) ? ll.find((l) => idOf(l) === idOf(r)) : r)).filter((x): x is Obj => x !== undefined);
  for (const l of ll) if (inScope(l) && !rl.some((r) => idOf(r) === idOf(l))) out.push(l);
  return out;
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
