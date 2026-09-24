/**
 * Keep secrets and per-environment values out of the working tree.
 *
 * A string in the tree may contain `{{env:NAME}}` placeholders. `render`
 * replaces them from an environment (a `.env` file plus `process.env`) before
 * anything is sent to Mirth or written as XML. `templatize` goes the other way
 * on `pull`/`explode`: it swaps credential values for placeholders, returning
 * the values so the caller can store them in `.env`.
 *
 * The syntax is not Mirth's `${...}`, which connector fields already use for
 * Velocity variables (`${message.encodedData}`).
 */
import type { CanonicalConfig, Json } from '../types.js';

export type Env = Readonly<Record<string, string | undefined>>;

const PLACEHOLDER = /\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const SINGLE_PLACEHOLDER = /^\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}$/;

/** Credential-bearing keys: `password`, `smtpPassword`, `proxyPassword`, `secret`, `apiToken`… */
const SECRET_KEY = /(password|passphrase|secret|token)$/i;

/** Mirth's configuration-map entry value holder (XML and live shapes). */
const CONFIG_PROPERTY = 'com.mirth.connect.util.ConfigurationProperty';

export function placeholder(name: string): string {
  return `{{env:${name}}}`;
}

export function hasPlaceholder(value: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(value);
}

/** Fill every placeholder in `value`; names with no value are collected in `missing`. */
function fill(value: string, env: Env, missing: Set<string>): string {
  return value.replace(PLACEHOLDER, (whole, name: string) => {
    const v = env[name];
    if (v === undefined) {
      missing.add(name);
      return whole;
    }
    return v;
  });
}

/**
 * Replace every placeholder in the config. Throws, naming every missing
 * variable, rather than sending a literal `{{env:…}}` to a server.
 */
export function render(config: CanonicalConfig, env: Env): CanonicalConfig {
  const missing = new Set<string>();
  const walk = (node: Json): Json => {
    if (typeof node === 'string') return fill(node, env, missing);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  const out = walk(config) as CanonicalConfig;
  if (missing.size > 0) {
    throw new Error(
      `missing values for ${[...missing].sort().join(', ')} (set them in the env file or the environment)`,
    );
  }
  return out;
}

// --- locations -------------------------------------------------------------

type Segment = string;

/**
 * A stable address for a value: array elements are identified by `id` or
 * `metaDataId` when they have one, so reordering or adding channels does not
 * move an existing placeholder to a different value.
 */
function elementSegment(el: Json, index: number): Segment {
  if (el && typeof el === 'object' && !Array.isArray(el)) {
    const id = el['id'] ?? el['metaDataId'];
    if (typeof id === 'string' || typeof id === 'number') return `[${String(id)}]`;
  }
  return `[${index}]`;
}

export interface Leaf {
  location: string;
  key: string;
  /** `name`s of enclosing objects (channel, connector), outermost first. */
  labels: string[];
  /** Top-level section the leaf lives in (`serverSettings`, `channels`, …). */
  section: string;
  /** The configuration-map key when this leaf is a map entry's value. */
  configMapKey?: string;
}

/** Visit every string leaf, allowing the visitor to replace it. */
export function mapLeaves(config: CanonicalConfig, visit: (value: string, leaf: Leaf) => string): CanonicalConfig {
  const walk = (node: Json, key: string, path: Segment[], labels: string[], section: string, cmKey?: string): Json => {
    if (typeof node === 'string') {
      return visit(node, { location: path.join('/'), key, labels, section, configMapKey: cmKey });
    }
    if (Array.isArray(node)) {
      return node.map((el, i) => walk(el, key, [...path.slice(0, -1), `${path[path.length - 1]}${elementSegment(el, i)}`], labels, section, cmKey));
    }
    if (node && typeof node === 'object') {
      const name = node['name'];
      const inner = typeof name === 'string' && name.trim() !== '' ? [...labels, name] : labels;
      // A configuration-map entry: { string: key | [key], ConfigurationProperty: { value, comment } }.
      const entryKey = node['string'];
      const mapKey =
        section === 'configurationMap' && CONFIG_PROPERTY in node
          ? typeof entryKey === 'string'
            ? entryKey
            : Array.isArray(entryKey) && typeof entryKey[0] === 'string'
              ? entryKey[0]
              : undefined
          : cmKey;
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, k, [...path, k], inner, section || k, mapKey);
      }
      return out;
    }
    return node;
  };
  return walk(config, '', [], [], '') as CanonicalConfig;
}

function isSecret(leaf: Leaf): boolean {
  if (leaf.section === 'configurationMap') return leaf.configMapKey !== undefined && leaf.key === 'value';
  return SECRET_KEY.test(leaf.key);
}

export function envName(parts: string[]): string {
  return parts
    .map((p) => p.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('__')
    .replace(/^(?=[0-9])/, '_');
}

export function derivedName(leaf: Leaf): string {
  if (leaf.configMapKey !== undefined) return envName(['CONFIG_MAP', leaf.configMapKey]);
  const context = leaf.labels.length > 0 ? leaf.labels : [leaf.section];
  return envName([...context, leaf.key]);
}

// --- templatize ------------------------------------------------------------

export interface TemplatizeResult {
  config: CanonicalConfig;
  /** Values to write to the env file (new or changed on the server). Never print these. */
  envUpdates: Record<string, string>;
  /** Human-readable notes: placeholders dropped, secrets updated from the server. */
  notes: string[];
}

/** Placeholder-bearing strings in a previously pulled (un-rendered) tree, by location. */
function templatesOf(config: CanonicalConfig | null): Map<string, string> {
  const out = new Map<string, string>();
  if (config) {
    mapLeaves(config, (value, leaf) => {
      if (hasPlaceholder(value)) out.set(leaf.location, value);
      return value;
    });
  }
  return out;
}

/**
 * Replace credentials in a freshly fetched config with placeholders.
 *
 * `previous` is the existing tree (un-rendered), so placeholders the user
 * added by hand survive a re-pull as long as they still render to what the
 * server holds. `env` is what they render with.
 */
export function templatize(remote: CanonicalConfig, previous: CanonicalConfig | null, env: Env): TemplatizeResult {
  const templates = templatesOf(previous);
  const envUpdates: Record<string, string> = {};
  const notes: string[] = [];
  const assigned = new Map<string, string>(); // name -> value, this run
  const reserved = new Set<string>();
  for (const t of templates.values()) {
    for (const m of t.matchAll(PLACEHOLDER)) reserved.add(m[1]!);
  }

  const assign = (base: string, value: string): string => {
    let name = base;
    for (let n = 2; ; n += 1) {
      const taken = assigned.get(name);
      if (taken === value || (taken === undefined && !reserved.has(name))) break;
      name = `${base}_${n}`;
    }
    assigned.set(name, value);
    if (env[name] !== value) envUpdates[name] = value;
    return name;
  };

  const config = mapLeaves(remote, (value, leaf) => {
    const template = templates.get(leaf.location);
    if (template !== undefined) {
      const missing = new Set<string>();
      if (fill(template, env, missing) === value && missing.size === 0) {
        for (const m of template.matchAll(PLACEHOLDER)) assigned.set(m[1]!, env[m[1]!]!);
        return template;
      }
      const single = SINGLE_PLACEHOLDER.exec(template);
      if (single) {
        const name = single[1]!;
        assigned.set(name, value);
        envUpdates[name] = value;
        notes.push(`${name}: server value differs from the env file; env file updated`);
        return template;
      }
      notes.push(`${leaf.location}: placeholder no longer matches the server; replaced with the server value`);
      return value;
    }
    if (isSecret(leaf) && value !== '' && !hasPlaceholder(value)) {
      return placeholder(assign(derivedName(leaf), value));
    }
    return value;
  });

  return { config, envUpdates, notes };
}
