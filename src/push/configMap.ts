/**
 * Scoped push of named configuration-map keys. Mirth saves the map only as a
 * whole (PUT /server/configurationMap), so a push reads the server's map,
 * replaces the named entries and writes the whole map back.
 */
import { createHash } from 'node:crypto';

import { CONFIG_PROPERTY, configMapKeyOf } from '../secrets/index.js';
import type { CanonicalConfig, Json } from '../types.js';
import { list, normalizeEol, type Op } from './index.js';

type Obj = Record<string, Json>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ConfigMapChange {
  kind: 'configMapKey';
  op: Op;
  id: string;
  label: string;
}

/**
 * The server's map as this machine last saw it: a hash per key. Values are
 * often credentials, so it is kept owner-only outside the tree (see
 * src/configMapBaselines.ts), never in channelvault.json.
 */
export type ConfigMapBaseline = Record<string, string>;

export interface ConfigMapPlan {
  changes: ConfigMapChange[];
  /** Named keys the server changed since the baseline, or that have no baseline to check. */
  conflicts: string[];
  /** Named keys the server already holds as the tree does. */
  unchanged: string[];
}

export function configMapOf(c: CanonicalConfig): Obj[] {
  return isObj(c['configurationMap']) ? list(c['configurationMap']['entry']) : [];
}

function byKey(entries: Obj[]): Map<string, Obj> {
  const out = new Map<string, Obj>();
  for (const e of entries) {
    const k = configMapKeyOf(e);
    if (k !== undefined) out.set(k, e);
  }
  return out;
}

/**
 * Value and comment, the parts of an entry Mirth stores, compared as the
 * strings Mirth holds: its JSON answers a value such as `true` or `5` as a
 * boolean or number, and an empty comment as null. Line endings are ignored,
 * as everywhere in push.
 */
function contentOf(entry: Obj): string {
  const p = entry[CONFIG_PROPERTY];
  const part = (name: string): string => {
    const v = isObj(p) ? p[name] : undefined;
    return v === null || v === undefined ? '' : normalizeEol(typeof v === 'string' ? v : JSON.stringify(v));
  };
  return JSON.stringify([part('value'), part('comment')]);
}

export function sameEntry(a: Obj | undefined, b: Obj | undefined): boolean {
  if (!a || !b) return a === b;
  return contentOf(a) === contentOf(b);
}

/** Mirth holds the map in a hash map, so its order carries no meaning. */
export function sameConfigMap(a: CanonicalConfig, b: CanonicalConfig): boolean {
  return otherDifferingKeys(a, b, []).length === 0;
}

/** `c` with its map entries in key order, so a comparison of the two sides doesn't see Mirth's ordering. */
export function withSortedConfigMap(c: CanonicalConfig): CanonicalConfig {
  const holder = c['configurationMap'];
  if (!isObj(holder) || holder['entry'] === undefined) return c;
  const entry = [...configMapOf(c)].sort((x, y) => (configMapKeyOf(x) ?? '').localeCompare(configMapKeyOf(y) ?? '', 'en'));
  return { ...c, configurationMap: { ...holder, entry } };
}

/** The key is hashed in, so two keys holding one password don't show it. */
function digest(name: string, entry: Obj): string {
  return createHash('sha256').update(`${name}\0${contentOf(entry)}`).digest('hex');
}

export function configMapBaseline(c: CanonicalConfig): ConfigMapBaseline {
  return Object.fromEntries([...byKey(configMapOf(c))].map(([k, e]) => [k, digest(k, e)]));
}

/**
 * The baseline after a push: the named keys take `server`'s entries, the rest
 * keep theirs, so an unpulled change to another key still reads as a conflict
 * next time. Undefined without a baseline to extend: a partial one would
 * misreport every other key.
 */
export function baselineAfterPush(baseline: ConfigMapBaseline | undefined, server: CanonicalConfig, names: string[]): ConfigMapBaseline | undefined {
  if (!baseline) return undefined;
  const now = byKey(configMapOf(server));
  const next = { ...baseline };
  for (const name of names) {
    const e = now.get(name);
    if (e) next[name] = digest(name, e);
    else delete next[name];
  }
  return next;
}

function conflictOf(name: string, server: Obj | undefined, baseline: ConfigMapBaseline | undefined): string | undefined {
  const what = `configuration-map key "${name}"`;
  if (!baseline) return `${what}: no configuration-map baseline for this installation on this machine; pull or adopt to record one`;
  const recorded = baseline[name];
  if (recorded === undefined) return server ? `${what} was created on the server since the last pull` : undefined;
  if (!server) return `${what} was deleted on the server since the last pull`;
  return digest(name, server) === recorded ? undefined : `${what} changed on the server since the last pull`;
}

export function planConfigMap(local: CanonicalConfig, remote: CanonicalConfig, names: string[], baseline: ConfigMapBaseline | undefined): ConfigMapPlan {
  const tree = byKey(configMapOf(local));
  const server = byKey(configMapOf(remote));
  const plan: ConfigMapPlan = { changes: [], conflicts: [], unchanged: [] };
  for (const name of new Set(names)) {
    const t = tree.get(name);
    const s = server.get(name);
    if (!t && !s) throw new UnknownConfigMapKey(name);
    if (sameEntry(t, s)) {
      plan.unchanged.push(name);
      continue;
    }
    plan.changes.push({ kind: 'configMapKey', op: !s ? 'create' : !t ? 'delete' : 'update', id: name, label: name });
    const conflict = conflictOf(name, s, baseline);
    if (conflict) plan.conflicts.push(conflict);
  }
  return plan;
}

export class UnknownConfigMapKey extends Error {
  constructor(readonly key: string) {
    super(`no configuration-map key named "${key}" in the tree or on the server`);
  }
}

export function configMapMoved(names: string[], before: CanonicalConfig, after: CanonicalConfig): string[] {
  const [b, a] = [byKey(configMapOf(before)), byKey(configMapOf(after))];
  return names.filter((n) => !sameEntry(b.get(n), a.get(n)));
}

export function otherDifferingKeys(a: CanonicalConfig, b: CanonicalConfig, names: string[]): string[] {
  const [x, y] = [byKey(configMapOf(a)), byKey(configMapOf(b))];
  const skip = new Set(names);
  return [...new Set([...x.keys(), ...y.keys()])].filter((k) => !skip.has(k) && !sameEntry(x.get(k), y.get(k))).sort();
}

/**
 * The map to save: `server`'s entries in their order, each named key replaced
 * by the tree's entry, dropped when the tree has none, or appended when new.
 */
export function mergeConfigMap(server: CanonicalConfig, local: CanonicalConfig, names: string[]): Obj {
  const tree = byKey(configMapOf(local));
  const wanted = new Set(names);
  const placed = new Set<string>();
  const entry: Obj[] = [];
  for (const e of configMapOf(server)) {
    const k = configMapKeyOf(e);
    if (k === undefined || !wanted.has(k)) {
      entry.push(e);
      continue;
    }
    placed.add(k);
    const t = tree.get(k);
    if (t) entry.push(structuredClone(t));
  }
  for (const n of wanted) {
    const t = tree.get(n);
    if (!placed.has(n) && t) entry.push(structuredClone(t));
  }
  const holder = isObj(server['configurationMap']) ? server['configurationMap'] : {};
  return { ...holder, entry };
}
