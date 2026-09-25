/**
 * Explode / implode engine.
 *
 * Projects a canonical config (the unwrapped Mirth `serverConfiguration`) onto a
 * git-friendly directory tree and reverses it losslessly. The exploded tree is a
 * verbatim *projection* of the config split across files using two marker types:
 *
 *   - `{ "@file": "<relpath>" }` replaces an extracted code/script STRING leaf;
 *     the string is written to a sidecar `.js` file (path relative to the JSON
 *     file holding the marker).
 *   - `{ "@ref": "<relpath>" }` replaces a whole sub-object split into its own
 *     `.json` file (path relative to the JSON file holding the marker).
 *
 * Invariant: `implode(explode(config))` deep-equals `config`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  CHANNEL_SCRIPT_KEYS,
  CODE_KEYS,
  isFileRef,
  type CanonicalConfig,
  type ExplodeEngine,
  type ExplodeOptions,
  type Json,
} from '../types.js';

// --- shared helpers --------------------------------------------------------

/** Coerce a "container may be object or array depending on count" value. */
export function asArray<T = Json>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : x == null ? [] : [x as T];
}

/** Marker left in a `*.json` file in place of an extracted sub-object. */
interface RefMarker {
  '@ref': string;
}

export function isRefMarker(v: unknown): v is RefMarker {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as Record<string, unknown>)['@ref'] === 'string'
  );
}

const CODE_KEY_SET: ReadonlySet<string> = new Set([...CODE_KEYS, ...CHANNEL_SCRIPT_KEYS]);

/** Map of channel-level script key -> friendly file base name. */
const CHANNEL_SCRIPT_FRIENDLY: Record<string, string> = {
  preprocessingScript: 'preprocessor',
  postprocessingScript: 'postprocessor',
  deployScript: 'deploy',
  undeployScript: 'undeploy',
};

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepClone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Slugify a name into a filesystem-safe segment.
 * Replaces `/ \ : * ? " < > |` and control chars, collapses whitespace to `-`,
 * trims leading/trailing separators. Never returns an empty string.
 */
function slug(name: unknown): string {
  let s = typeof name === 'string' ? name : name == null ? '' : String(name);
  // Replace reserved / control characters with a space (later collapsed).
  s = s.replace(/[/\\:*?"<>|]/g, ' ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  // Collapse any run of whitespace to a single dash.
  s = s.replace(/\s+/g, '-');
  // Trim leading/trailing dashes/dots.
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  if (s.length === 0) return 'unnamed';
  // Windows reserves these device names in every directory.
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s) ? `${s}-` : s;
}

/**
 * Deterministically resolve slug collisions within a namespace. Compared
 * case-insensitively: on Windows and macOS `Alpha` and `alpha` are the same
 * directory, and one would silently overwrite the other.
 */
function uniqueSlug(base: string, used: Set<string>): string {
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${base}-${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** POSIX-style relative path for storage inside markers (stable across OS). */
function relPosix(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).split(path.sep).join('/');
}

/** The real path of the tree being exploded, for the write check below. */
const explodeRoot = new AsyncLocalStorage<string>();

/**
 * Refuse a write whose real directory is outside the tree: the names are
 * sanitised, but a symlink or junction already inside the tree could still
 * redirect it.
 */
async function assertInsideTree(filePath: string): Promise<void> {
  const root = explodeRoot.getStore();
  if (root === undefined) return;
  // Check the nearest directory that already exists, before creating any:
  // mkdir through a link would already have created directories outside.
  let dir = path.dirname(filePath);
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const real = await realpath(dir);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside the working tree: ${filePath}`);
  }
}

async function writeFileMkdir(filePath: string, data: string): Promise<void> {
  await assertInsideTree(filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  // NO added trailing newline — code strings must round-trip byte-identical.
  await writeFile(filePath, data);
}

async function writeJson(filePath: string, value: Json): Promise<void> {
  await assertInsideTree(filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

// --- explode ---------------------------------------------------------------

/**
 * Recursively extract code leaves from a value tree, IN PLACE (caller passes a
 * clone). `jsonDir` is the directory of the JSON file that will hold this tree;
 * `codeDir` is the directory under which sidecar `.js` files for this tree are
 * written; `prefixParts` accumulates the ancestor key/index chain for fallback
 * naming. `usedPaths` dedupes generated file paths within this resource.
 */
async function extractCode(
  value: Json,
  ctx: {
    jsonDir: string;
    codeDir: string;
    friendly: string | null; // friendly relative path (no extension) if known
    prefixParts: string[]; // ancestor key chain for fallback naming
    usedPaths: Set<string>;
  },
): Promise<Json> {
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(
        await extractCode(value[i] as Json, {
          ...ctx,
          friendly: null,
          prefixParts: [...ctx.prefixParts, String(i)],
        }),
      );
    }
    return out;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  // Recurse, applying friendly-path recognition for known Mirth structures.
  return extractFromObject(value, ctx);
}

async function extractFromObject(
  obj: Record<string, Json>,
  ctx: {
    jsonDir: string;
    codeDir: string;
    friendly: string | null;
    prefixParts: string[];
    usedPaths: Set<string>;
  },
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};

  for (const [key, raw] of Object.entries(obj)) {
    // Code leaf? Only extract plain non-empty string leaves.
    if (CODE_KEY_SET.has(key) && typeof raw === 'string') {
      if (raw.trim().length === 0) {
        out[key] = raw; // keep empty/whitespace-only inline (no file)
        continue;
      }
      const friendlyBase =
        key in CHANNEL_SCRIPT_FRIENDLY
          ? `scripts/${CHANNEL_SCRIPT_FRIENDLY[key]}`
          : // One filename segment: config keys are untrusted and may hold '/' or '..'.
            ctx.friendly ?? `_code/${slug([...ctx.prefixParts, key].join('.'))}`;
      const filePath = resolveUnique(ctx.codeDir, `${friendlyBase}.js`, ctx.usedPaths);
      await writeFileMkdir(filePath, raw);
      out[key] = { '@file': relPosix(ctx.jsonDir, filePath) };
      continue;
    }

    // Recurse into children.
    out[key] = await extractCode(raw as Json, {
      ...ctx,
      friendly: null,
      prefixParts: [...ctx.prefixParts, key],
    });
  }

  return out;
}

/** Resolve a unique absolute file path for a friendly-or-fallback rel path. */
function resolveUnique(baseDir: string, relName: string, used: Set<string>): string {
  const ext = path.extname(relName);
  const dir = path.dirname(relName);
  const stem = path.basename(relName, ext);
  const dirSlug = dir === '.' ? '' : dir;
  // Build slugged segments for the directory portion (preserve structure).
  const segs = dirSlug.split('/').filter(Boolean);
  // Case-insensitive, like uniqueSlug.
  let rel = [...segs, `${stem}${ext}`].join('/');
  for (let n = 2; used.has(rel.toLowerCase()); n += 1) rel = [...segs, `${stem}-${n}${ext}`].join('/');
  used.add(rel.toLowerCase());
  const full = path.resolve(baseDir, ...rel.split('/'));
  if (!full.startsWith(path.resolve(baseDir) + path.sep)) throw new Error(`script path escapes its directory: ${relName}`);
  return full;
}

/**
 * Walk a channel object giving friendly paths to its scripts and connector
 * transformer/filter steps, extracting code leaves in place. Returns the
 * transformed channel object. `dir` is the channel's directory (also the dir of
 * its `channel.json`). `usedPaths` dedupes within the channel.
 */
async function explodeChannelTree(
  channel: Record<string, Json>,
  dir: string,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};

  for (const [key, raw] of Object.entries(channel)) {
    // Channel-level scripts -> scripts/<friendly>.js
    if (key in CHANNEL_SCRIPT_FRIENDLY && typeof raw === 'string') {
      if (raw.trim().length === 0) {
        out[key] = raw;
        continue;
      }
      const filePath = resolveUnique(dir, `scripts/${CHANNEL_SCRIPT_FRIENDLY[key]}.js`, usedPaths);
      await writeFileMkdir(filePath, raw);
      out[key] = { '@file': relPosix(dir, filePath) };
      continue;
    }

    if (key === 'sourceConnector' && isPlainObject(raw)) {
      out[key] = await explodeConnector(raw, dir, 'source', 'source/receiver', usedPaths);
      continue;
    }

    if (key === 'destinationConnectors' && isPlainObject(raw)) {
      out[key] = await explodeDestinationConnectors(raw, dir, usedPaths);
      continue;
    }

    // Everything else: generic extraction (covers unknown structures / code).
    out[key] = await extractCode(raw as Json, {
      jsonDir: dir,
      codeDir: dir,
      friendly: null,
      prefixParts: [key],
      usedPaths,
    });
  }

  return out;
}

/**
 * Explode a connector (source or a single destination). `baseRel` is the
 * relative directory prefix within the channel dir for this connector's
 * transformer/filter steps (e.g. `source` or `destinations/<slug>`).
 * `scriptFileBase` is the friendly path (no extension) for the connector's own
 * reader/writer code at `properties.script` (e.g. `source/receiver` or
 * `destinations/<slug>/writer`).
 */
async function explodeConnector(
  connector: Record<string, Json>,
  channelDir: string,
  baseRel: string,
  scriptFileBase: string,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};

  for (const [key, raw] of Object.entries(connector)) {
    if (key === 'transformer' && isPlainObject(raw)) {
      out[key] = await explodeStepContainer(raw, channelDir, `${baseRel}/transformer`, usedPaths);
      continue;
    }
    if (key === 'responseTransformer' && isPlainObject(raw)) {
      out[key] = await explodeStepContainer(
        raw,
        channelDir,
        `${baseRel}/responseTransformer`,
        usedPaths,
      );
      continue;
    }
    if (key === 'filter' && isPlainObject(raw)) {
      out[key] = await explodeStepContainer(raw, channelDir, `${baseRel}/filter`, usedPaths);
      continue;
    }
    if (key === 'properties' && isPlainObject(raw)) {
      out[key] = await explodeConnectorProperties(raw, channelDir, scriptFileBase, usedPaths);
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: channelDir,
      codeDir: channelDir,
      friendly: null,
      prefixParts: [baseRel, key],
      usedPaths,
    });
  }

  return out;
}

/**
 * Explode a connector's `properties` object. The JavaScript Reader/Writer
 * connectors carry their body directly at `properties.script`; extract it to a
 * friendly `<scriptFileBase>.js`. Anything else recurses generically.
 */
async function explodeConnectorProperties(
  properties: Record<string, Json>,
  channelDir: string,
  scriptFileBase: string,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (key === 'script' && typeof raw === 'string') {
      if (raw.trim().length === 0) {
        out[key] = raw;
        continue;
      }
      const filePath = resolveUnique(channelDir, `${scriptFileBase}.js`, usedPaths);
      await writeFileMkdir(filePath, raw);
      out[key] = { '@file': relPosix(channelDir, filePath) };
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: channelDir,
      codeDir: channelDir,
      friendly: null,
      prefixParts: ['properties', key],
      usedPaths,
    });
  }
  return out;
}

async function explodeDestinationConnectors(
  container: Record<string, Json>,
  channelDir: string,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  const usedDestSlugs = new Set<string>();

  for (const [key, raw] of Object.entries(container)) {
    if (key === 'connector') {
      const connectors = asArray<Record<string, Json>>(raw);
      const wasArray = Array.isArray(raw);
      const transformed: Record<string, Json>[] = [];
      for (const conn of connectors) {
        const name = isPlainObject(conn) ? conn['name'] : undefined;
        const destSlug = uniqueSlug(slug(name), usedDestSlugs);
        transformed.push(
          isPlainObject(conn)
            ? await explodeConnector(
                conn,
                channelDir,
                `destinations/${destSlug}`,
                `destinations/${destSlug}/writer`,
                usedPaths,
              )
            : conn,
        );
      }
      out[key] = wasArray ? transformed : (transformed[0] as Json);
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: channelDir,
      codeDir: channelDir,
      friendly: null,
      prefixParts: ['destinationConnectors', key],
      usedPaths,
    });
  }

  return out;
}

/**
 * Explode a transformer/filter/responseTransformer container. Mirth nests the
 * actual steps under an `elements` key. In REAL data `elements` is an OBJECT
 * keyed by the step's fully-qualified Java class name (e.g.
 * `com.mirth.connect.plugins.javascriptstep.JavaScriptStep`), whose value is an
 * array of step objects:
 *
 *   elements: { "com.mirth...JavaScriptStep": [ { name, sequenceNumber, script } ] }
 *
 * An empty transformer/filter serializes `elements` as the empty string `""`.
 * We give each step a friendly `<baseRel>/<n>.<slug(step name)>.js` path, where
 * `n` is `sequenceNumber + 1` (string-parsed) falling back to a running index.
 * Unknown shapes fall back to generic extraction so we never crash.
 */
async function explodeStepContainer(
  container: Record<string, Json>,
  channelDir: string,
  baseRel: string,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};

  for (const [key, raw] of Object.entries(container)) {
    if (key === 'elements' && (Array.isArray(raw) || isPlainObject(raw))) {
      out[key] = await explodeElementsContainer(
        raw as Json[] | Record<string, Json>,
        channelDir,
        baseRel,
        usedPaths,
      );
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: channelDir,
      codeDir: channelDir,
      friendly: null,
      prefixParts: [baseRel, key],
      usedPaths,
    });
  }

  return out;
}

/** Does an object look like a single step (carries a code leaf or step metadata)? */
function isStepLike(obj: Record<string, Json>): boolean {
  return (
    typeof obj['script'] === 'string' ||
    typeof obj['code'] === 'string' ||
    'sequenceNumber' in obj ||
    'name' in obj
  );
}

/**
 * Dispatch the `elements` value of a step container, numbering steps globally
 * in encounter order. Handles three shapes:
 *   - ARRAY of step objects (a legacy / hand-written form).
 *   - a single step OBJECT (`elements` collapsed to one step).
 *   - the REAL Mirth form: an OBJECT keyed by fully-qualified class name whose
 *     values are arrays (or single objects) of step objects.
 */
async function explodeElementsContainer(
  elements: Json[] | Record<string, Json>,
  channelDir: string,
  baseRel: string,
  usedPaths: Set<string>,
): Promise<Json> {
  const counter = { i: 0 };

  if (Array.isArray(elements)) {
    return explodeStepArray(elements, channelDir, baseRel, usedPaths, counter);
  }

  // A single step object directly under `elements`.
  if (isStepLike(elements)) {
    return explodeStep(elements, channelDir, baseRel, counter.i++, usedPaths);
  }

  // Class-keyed map of step buckets (the real shape).
  const out: Record<string, Json> = {};
  for (const [className, raw] of Object.entries(elements)) {
    // Attributes (`@_...`), adapter metadata (`#order`, `#comment`) and nulls
    // are passed through generically, not numbered as steps.
    if (className.startsWith('@_') || className.startsWith('#') || raw == null) {
      out[className] = await extractCode(raw as Json, {
        jsonDir: channelDir,
        codeDir: channelDir,
        friendly: null,
        prefixParts: [baseRel, 'elements', className],
        usedPaths,
      });
      continue;
    }
    if (Array.isArray(raw)) {
      out[className] = await explodeStepArray(raw, channelDir, baseRel, usedPaths, counter);
      continue;
    }
    if (isPlainObject(raw) && isStepLike(raw)) {
      out[className] = await explodeStep(raw, channelDir, baseRel, counter.i++, usedPaths);
      continue;
    }
    out[className] = await extractCode(raw as Json, {
      jsonDir: channelDir,
      codeDir: channelDir,
      friendly: null,
      prefixParts: [baseRel, 'elements', className],
      usedPaths,
    });
  }
  return out;
}

async function explodeStepArray(
  steps: Json[],
  channelDir: string,
  baseRel: string,
  usedPaths: Set<string>,
  counter: { i: number },
): Promise<Json[]> {
  const transformed: Json[] = [];
  for (const step of steps) {
    transformed.push(await explodeStep(step, channelDir, baseRel, counter.i++, usedPaths));
  }
  return transformed;
}

async function explodeStep(
  step: Json,
  channelDir: string,
  baseRel: string,
  index: number,
  usedPaths: Set<string>,
): Promise<Json> {
  if (!isPlainObject(step)) {
    return step;
  }

  // Sequence number (Mirth) is 0-based; prefer it, else fall back to index.
  const seqRaw = step['sequenceNumber'];
  let seq = index;
  if (typeof seqRaw === 'number') seq = seqRaw;
  else if (typeof seqRaw === 'string' && seqRaw.trim() !== '' && !Number.isNaN(Number(seqRaw))) {
    seq = Number(seqRaw);
  }
  const n = seq + 1;
  const stepName = step['name'];
  // Many real steps have no `name`; fall back to a bare `<n>` segment so the
  // file reads as e.g. `1.js` rather than `1.unnamed.js`.
  const hasName = typeof stepName === 'string' && stepName.trim().length > 0;
  const friendlyBase = hasName ? `${baseRel}/${n}.${slug(stepName)}` : `${baseRel}/${n}`;

  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(step)) {
    if (CODE_KEY_SET.has(key) && typeof raw === 'string') {
      if (raw.trim().length === 0) {
        out[key] = raw;
        continue;
      }
      const filePath = resolveUnique(channelDir, `${friendlyBase}.js`, usedPaths);
      await writeFileMkdir(filePath, raw);
      out[key] = { '@file': relPosix(channelDir, filePath) };
      continue;
    }
    // Recurse generically into anything else (handles nested unknowns).
    out[key] = await extractCode(raw as Json, {
      jsonDir: channelDir,
      codeDir: channelDir,
      friendly: null,
      prefixParts: [baseRel, String(index), key],
      usedPaths,
    });
  }
  return out;
}

/**
 * Split the three known top-level collections into per-resource JSON files,
 * replacing each element with an `@ref` marker (order preserved). Each split-out
 * resource is itself code-extracted under its own directory.
 *
 * Returns the rewritten container value (object or array preserved as-is) with
 * `@ref` markers, or null if the collection was absent.
 */
async function splitCollection(
  parent: Record<string, Json>,
  containerKey: string, // e.g. 'channels'
  elementKey: string, // e.g. 'channel'
  root: string,
  serverDir: string, // dir holding configuration.json (markers are relative to it)
  targetFor: (name: unknown, slugName: string) => { jsonFile: string; resourceDir: string },
  usedSlugs: Set<string>,
  explodeResource: (
    el: Record<string, Json>,
    resourceDir: string,
  ) => Promise<Record<string, Json>>,
): Promise<void> {
  const container = parent[containerKey];
  if (!isPlainObject(container)) return;
  const raw = container[elementKey];
  if (raw == null) return;

  const wasArray = Array.isArray(raw);
  const elements = asArray<Json>(raw);
  const refs: Json[] = [];

  for (const el of elements) {
    if (!isPlainObject(el)) {
      // Non-object element: keep inline (cannot meaningfully split).
      refs.push(el);
      continue;
    }
    const slugName = uniqueSlug(slug(el['name']), usedSlugs);
    const { jsonFile, resourceDir } = targetFor(el['name'], slugName);
    const transformed = await explodeResource(el, resourceDir);
    await writeJson(jsonFile, transformed);
    refs.push({ '@ref': relPosix(serverDir, jsonFile) });
  }

  // Preserve object-vs-array shape of the element container.
  container[elementKey] = wasArray ? refs : (refs[0] as Json);
}

async function explode(config: CanonicalConfig, opts: ExplodeOptions): Promise<void> {
  await mkdir(opts.root, { recursive: true });
  await explodeRoot.run(await realpath(opts.root), () => explodeInto(config, opts));
}

async function explodeInto(config: CanonicalConfig, opts: ExplodeOptions): Promise<void> {
  const root = opts.root;
  const serverDir = path.join(root, 'server');
  const skeleton = deepClone(config) as Record<string, Json>;

  // 1. channels.channel[] -> channels/<slug>/channel.json
  if (isPlainObject(skeleton['channels'])) {
    const channelSlugs = new Set<string>();
    await splitCollection(
      skeleton,
      'channels',
      'channel',
      root,
      serverDir,
      (_name, slugName) => {
        const resourceDir = path.join(root, 'channels', slugName);
        return { jsonFile: path.join(resourceDir, 'channel.json'), resourceDir };
      },
      channelSlugs,
      async (el, resourceDir) => explodeChannelTree(el, resourceDir, new Set<string>()),
    );
  }

  // 2. codeTemplateLibraries.codeTemplateLibrary[] -> codeTemplates/<slug>/library.json
  if (isPlainObject(skeleton['codeTemplateLibraries'])) {
    const libSlugs = new Set<string>();
    await splitCollection(
      skeleton,
      'codeTemplateLibraries',
      'codeTemplateLibrary',
      root,
      serverDir,
      (_name, slugName) => {
        const resourceDir = path.join(root, 'codeTemplates', slugName);
        return { jsonFile: path.join(resourceDir, 'library.json'), resourceDir };
      },
      libSlugs,
      async (el, resourceDir) => explodeLibrary(el, resourceDir),
    );
  }

  // 3. channelGroups.channelGroup[] -> channelGroups/<slug>.json
  if (isPlainObject(skeleton['channelGroups'])) {
    const groupSlugs = new Set<string>();
    await splitCollection(
      skeleton,
      'channelGroups',
      'channelGroup',
      root,
      serverDir,
      (_name, slugName) => {
        const resourceDir = path.join(root, 'channelGroups');
        return { jsonFile: path.join(resourceDir, `${slugName}.json`), resourceDir };
      },
      groupSlugs,
      async (el, resourceDir) =>
        // group json lives in channelGroups/; sidecar code (rare) under same dir
        extractCode(el, {
          jsonDir: resourceDir,
          codeDir: resourceDir,
          friendly: null,
          prefixParts: ['channelGroup'],
          usedPaths: new Set<string>(),
        }) as Promise<Record<string, Json>>,
    );
  }

  // 4. Extract code in the remaining skeleton (e.g. globalScripts) and write it.
  const finalSkeleton = await extractCode(skeleton, {
    jsonDir: serverDir,
    codeDir: serverDir,
    friendly: null,
    prefixParts: [],
    usedPaths: new Set<string>(),
  });

  await writeJson(path.join(serverDir, 'configuration.json'), finalSkeleton);
}

/**
 * Explode a code template library: split-out resource. Each template's `code`
 * leaf -> `<slug(template name)>.js` next to library.json (resourceDir).
 */
async function explodeLibrary(
  library: Record<string, Json>,
  resourceDir: string,
): Promise<Record<string, Json>> {
  const used = new Set<string>();
  const usedTemplateSlugs = new Set<string>();
  const out: Record<string, Json> = {};

  for (const [key, raw] of Object.entries(library)) {
    if (key === 'codeTemplates' && isPlainObject(raw)) {
      out[key] = await explodeLibraryTemplates(raw, resourceDir, usedTemplateSlugs, used);
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: resourceDir,
      codeDir: resourceDir,
      friendly: null,
      prefixParts: [key],
      usedPaths: used,
    });
  }
  return out;
}

async function explodeLibraryTemplates(
  container: Record<string, Json>,
  resourceDir: string,
  usedTemplateSlugs: Set<string>,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(container)) {
    if (key === 'codeTemplate' && raw != null) {
      const wasArray = Array.isArray(raw);
      const templates = asArray<Json>(raw);
      const transformed: Json[] = [];
      for (const t of templates) {
        transformed.push(
          await explodeCodeTemplate(t, resourceDir, usedTemplateSlugs, usedPaths),
        );
      }
      out[key] = wasArray ? transformed : (transformed[0] as Json);
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: resourceDir,
      codeDir: resourceDir,
      friendly: null,
      prefixParts: ['codeTemplates', key],
      usedPaths,
    });
  }
  return out;
}

async function explodeCodeTemplate(
  template: Json,
  resourceDir: string,
  usedTemplateSlugs: Set<string>,
  usedPaths: Set<string>,
): Promise<Json> {
  if (!isPlainObject(template)) return template;
  const friendlyBase = uniqueSlug(slug(template['name']), usedTemplateSlugs);
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(template)) {
    // In real Mirth data the body lives at `properties.code`; handle that and
    // (defensively) a `code`/`script` leaf directly on the template object.
    if (key === 'properties' && isPlainObject(raw)) {
      out[key] = await explodeTemplateProperties(raw, resourceDir, friendlyBase, usedPaths);
      continue;
    }
    if (CODE_KEY_SET.has(key) && typeof raw === 'string') {
      if (raw.trim().length === 0) {
        out[key] = raw;
        continue;
      }
      const filePath = resolveUnique(resourceDir, `${friendlyBase}.js`, usedPaths);
      await writeFileMkdir(filePath, raw);
      out[key] = { '@file': relPosix(resourceDir, filePath) };
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: resourceDir,
      codeDir: resourceDir,
      friendly: null,
      prefixParts: ['codeTemplate', key],
      usedPaths,
    });
  }
  return out;
}

/**
 * Explode a code template's `properties` object, whose `code` leaf is the
 * template body -> friendly `<friendlyBase>.js` next to library.json.
 */
async function explodeTemplateProperties(
  properties: Record<string, Json>,
  resourceDir: string,
  friendlyBase: string,
  usedPaths: Set<string>,
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (CODE_KEY_SET.has(key) && typeof raw === 'string') {
      if (raw.trim().length === 0) {
        out[key] = raw;
        continue;
      }
      const filePath = resolveUnique(resourceDir, `${friendlyBase}.js`, usedPaths);
      await writeFileMkdir(filePath, raw);
      out[key] = { '@file': relPosix(resourceDir, filePath) };
      continue;
    }
    out[key] = await extractCode(raw as Json, {
      jsonDir: resourceDir,
      codeDir: resourceDir,
      friendly: null,
      prefixParts: ['codeTemplate', 'properties', key],
      usedPaths,
    });
  }
  return out;
}

// --- implode ---------------------------------------------------------------

/**
 * Resolve a marker path relative to `jsonDir` and assert it stays inside the
 * working-tree `root`. Legitimate markers DO use `..` (e.g. `server/`'s config
 * references `../channelGroups/*.json`), so `..` is allowed — only escaping the
 * tree root is rejected. Working trees are shared/cloned git repos, so marker
 * values are attacker-influenceable input; without this check a crafted
 * `{"@file": "../../../../etc/passwd"}` would be read into the imploded config
 * (and, via `push`, uploaded to a live server).
 */
function resolveWithinRoot(root: string, jsonDir: string, rel: string): string {
  const target = path.resolve(jsonDir, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`marker path escapes the working tree: ${rel}`);
  }
  return target;
}

/**
 * Read a marker target, re-checking containment on the real path: the text
 * check above can't see a symlink or junction inside the tree that points
 * outside it.
 */
async function readWithinRoot(root: string, target: string, rel: string): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`marker path escapes the working tree through a link: ${rel}`);
  }
  return readFile(realTarget, 'utf8');
}

/**
 * Recursively resolve markers in a parsed JSON value. `jsonDir` is the directory
 * of the JSON file this value came from (markers are relative to it); `root` is
 * the working-tree root that every marker target must stay within.
 */
async function resolveMarkers(value: Json, jsonDir: string, root: string): Promise<Json> {
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (const item of value) {
      // A collection member whose file is gone was deleted from the tree
      // (e.g. `rm -r channels/<name>`), so it is dropped, not an error.
      if (isRefMarker(item) && !existsSync(resolveWithinRoot(root, jsonDir, item['@ref']))) continue;
      out.push(await resolveMarkers(item, jsonDir, root));
    }
    return out;
  }

  if (isFileRef(value)) {
    const target = resolveWithinRoot(root, jsonDir, value['@file']);
    // Raw read, NO trimming — byte-identical round-trip.
    return readWithinRoot(root, target, value['@file']);
  }

  if (isRefMarker(value)) {
    const target = resolveWithinRoot(root, jsonDir, value['@ref']);
    const text = await readWithinRoot(root, target, value['@ref']);
    const parsed = JSON.parse(text) as Json;
    return resolveMarkers(parsed, path.dirname(target), root);
  }

  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      // Same for a one-member collection, which explode stores as a bare marker.
      if (isRefMarker(v) && !existsSync(resolveWithinRoot(root, jsonDir, v['@ref']))) continue;
      out[k] = await resolveMarkers(v, jsonDir, root);
    }
    return out;
  }

  return value;
}

async function implode(opts: ExplodeOptions): Promise<CanonicalConfig> {
  const root = path.resolve(opts.root);
  const serverDir = path.join(root, 'server');
  const configPath = path.join(serverDir, 'configuration.json');
  const text = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(text) as Json;
  const resolved = await resolveMarkers(parsed, serverDir, root);
  return resolved as CanonicalConfig;
}

// --- factory ---------------------------------------------------------------

export function createExplodeEngine(): ExplodeEngine {
  return { explode, implode };
}
