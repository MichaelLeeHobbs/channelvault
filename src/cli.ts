#!/usr/bin/env node
/**
 * channelvault CLI — git-style pull/push/diff for Mirth Connect.
 *
 *   channelvault explode <backup.xml> <dir>   XML  -> tree
 *   channelvault implode <dir> <backup.xml>   tree -> XML
 *   channelvault pull <dir>                    live server -> tree
 *   channelvault push <dir>                    tree -> live server
 *   channelvault diff <dir>                    tree vs live server
 *   channelvault status <dir>                  summary of the working tree
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command, CommanderError } from 'commander';

import { createExplodeEngine } from './explode/index.js';
import { XmlConfigAdapter } from './xml/index.js';
import { createMirthClient, UNTRUSTED_CERT_CODES, type MirthClientExt } from './client/index.js';
import {
  changedSince,
  channelsOf,
  knownAfterPush,
  librariesOf,
  savedChangeMatches,
  knownFrom,
  normalizeEolDeep,
  planPush,
  resourceIds,
  sameServerConfig,
  type Change,
  type Known,
  type Plan,
  type Scope,
} from './push/index.js';
import { applyPlan, deployChannels, refreshRevisions } from './push/apply.js';
import { mapLeaves, redactKnownSecrets, render, templatize } from './secrets/index.js';
import { backupEnvFile, ensureEnvIgnored, readEnvFile, updateEnvFile } from './secrets/envfile.js';
import { findEchoes, formatFindings, scanSecrets, type AllowEntry } from './secrets/detect.js';
import { readJson } from './json.js';
import type { CanonicalConfig, ClientConfig, Json } from './types.js';

const engine = createExplodeEngine();
const xml = new XmlConfigAdapter();

/** From package.json, one level up from both src/cli.ts and dist/cli.js. */
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

// --- helpers --------------------------------------------------------------

/** A user-facing error: printed without a stack trace. */
class CliError extends Error {}

/**
 * Abort the command. Throws rather than calling process.exit so open
 * connections close first; exiting while undici sockets are closing crashes
 * Node on Windows with a libuv assertion.
 */
function fail(message: string): never {
  throw new CliError(message);
}

/** Exit status for an error. `diff` uses 2, because its 1 means "differences found". */
let errorExitCode = 1;

/** Directories under a working tree that `explode` owns (cleared before a pull). */
const MANAGED_DIRS = ['server', 'channels', 'codeTemplates', 'channelGroups'];

/** Where `replaceTree` explodes before swapping in; removed before and after. */
const STAGING_DIR = '.channelvault-staging';

/**
 * Recursive-remove options. `maxRetries` is essential on Windows, where a
 * recursive delete can transiently fail with EBUSY/ENOTEMPTY/EPERM while the OS
 * releases just-closed handles; `fs.rm` retries those specific errors.
 */
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

interface ConnectionFlags {
  host?: string;
  port?: string;
  user?: string;
  pass?: string;
  insecure?: boolean;
  https?: boolean;
}

/** Resolve server connection from flags, falling back to MIRTH_* env vars. */
function resolveClientConfig(flags: ConnectionFlags): ClientConfig {
  const host = flags.host ?? process.env.MIRTH_HOST;
  const portStr = flags.port ?? process.env.MIRTH_PORT;
  const username = flags.user ?? process.env.MIRTH_USER;
  const password = flags.pass ?? process.env.MIRTH_PASS;

  if (!host) fail('no server host (pass --host or set MIRTH_HOST)');
  if (!portStr) fail('no server port (pass --port or set MIRTH_PORT)');
  if (!username) fail('no username (pass --user or set MIRTH_USER)');
  if (password == null) fail('no password (pass --pass or set MIRTH_PASS)');

  const port = Number(portStr);
  if (!Number.isInteger(port)) fail(`invalid port: ${portStr}`);

  return {
    host,
    port,
    username,
    password,
    https: flags.https !== false,
    disableTlsCheck: flags.insecure === true,
  };
}

function addConnectionFlags(cmd: Command): Command {
  return cmd
    .option('--host <host>', 'Mirth server host (env MIRTH_HOST)')
    .option('--port <port>', 'Mirth server port (env MIRTH_PORT)')
    .option('--user <user>', 'username (env MIRTH_USER)')
    .option('--pass <pass>', 'password (env MIRTH_PASS)')
    .option('--insecure', 'allow self-signed TLS certificates', false)
    .option('--no-https', 'use http instead of https');
}

async function withClient<T>(flags: ConnectionFlags, fn: (client: MirthClientExt) => Promise<T>): Promise<T> {
  const client = createMirthClient(resolveClientConfig(flags));
  try {
    await client.login();
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  rl.once('close', () => controller.abort());
  rl.once('SIGINT', () => controller.abort());
  try {
    const answer = (await rl.question(`${question} [y/N] `, { signal: controller.signal })).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch (err) {
    if (controller.signal.aborted) fail('confirmation interrupted; nothing was pushed');
    throw err;
  } finally {
    rl.close();
  }
}

/** Walk a canonical config and tally headline resource counts for `status`. */
function summarize(config: CanonicalConfig): Record<string, number> {
  const asArray = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const channels = asArray((config.channels as Record<string, Json> | undefined)?.channel);
  const libraries = asArray(
    (config.codeTemplateLibraries as Record<string, Json> | undefined)?.codeTemplateLibrary,
  );
  const groups = asArray((config.channelGroups as Record<string, Json> | undefined)?.channelGroup);

  let codeTemplates = 0;
  for (const lib of libraries) {
    if (lib && typeof lib === 'object' && !Array.isArray(lib)) {
      const cts = (lib.codeTemplates as Record<string, Json> | undefined)?.codeTemplate;
      codeTemplates += asArray(cts).length;
    }
  }

  return {
    channels: channels.length,
    channelGroups: groups.length,
    codeTemplateLibraries: libraries.length,
    codeTemplates,
  };
}

interface SyncMeta {
  tool: string;
  version: string;
  source: string;
  pulledAt: string;
  engineVersion: string | null;
  /** Resource ids the tree held at pull time (see Known in src/push). Absent in older trees. */
  resources?: Known;
}

async function writeMeta(root: string, source: string, config: CanonicalConfig, previous: SyncMeta | null): Promise<void> {
  const meta: SyncMeta = {
    tool: 'channelvault',
    version: VERSION,
    source,
    pulledAt: new Date().toISOString(),
    // XML adapter yields `@_version`; the live JSON API yields `@version` (Jackson).
    engineVersion:
      typeof config['@_version'] === 'string'
        ? (config['@_version'] as string)
        : typeof config['@version'] === 'string'
          ? (config['@version'] as string)
          : null,
    resources: resourceIds(config),
  };
  // A pull that changed nothing else must not leave a timestamp-only change
  // for git to show.
  const file = path.join(root, 'channelvault.json');
  if (previous && JSON.stringify({ ...previous, pulledAt: '' }) === JSON.stringify({ ...meta, pulledAt: '' })) return;
  await writeFile(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

// --- secrets / env ----------------------------------------------------------

interface EnvFlags {
  dotenv?: string;
  extractSecrets?: boolean;
}

function envFilePath(root: string, flags: EnvFlags): string {
  return flags.dotenv ? path.resolve(flags.dotenv) : path.join(root, '.env');
}

/** The env file overlaid with the process environment (which wins, as in CI). */
async function loadEnv(file: string): Promise<Record<string, string | undefined>> {
  return { ...(await readEnvFile(file)), ...process.env };
}

function addEnvFlag(cmd: Command): Command {
  // Not --env-file: Node scans the whole command line for that name and parses
  // the file itself (it fails on a directory and honours NODE_OPTIONS in it).
  return cmd.option('--dotenv <path>', 'env file holding secrets and per-environment values (default <dir>/.env)');
}

function addExtractFlag(cmd: Command): Command {
  return cmd.option('--extract-secrets', 'move secrets found inside values (URLs, scripts, headers) to the env file', false);
}

/** The tree as stored, placeholders unresolved; null if there is no tree yet. */
async function existingTree(root: string): Promise<CanonicalConfig | null> {
  return existsSync(path.join(root, 'server', 'configuration.json')) ? engine.implode({ root }) : null;
}

/** The tree with placeholders filled from the env file; fails listing any missing names. */
async function renderedTree(root: string, flags: EnvFlags): Promise<CanonicalConfig> {
  const tree = await engine.implode({ root });
  const env = await loadEnv(envFilePath(root, flags));
  rememberSecrets(tree, env);
  return render(tree, env);
}

/**
 * The values behind the tree's placeholders. A server's error can echo what
 * was sent, so everything printed about a failure goes through `scrub`.
 */
const knownSecrets = new Set<string>();

function rememberSecrets(tree: CanonicalConfig, env: Record<string, string | undefined>): void {
  mapLeaves(tree, (value) => {
    for (const m of value.matchAll(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
      const secret = env[m[1]!];
      // Shorter values (a port, "true") would redact ordinary words.
      if (secret !== undefined && secret.length >= 4) knownSecrets.add(secret);
    }
    return value;
  });
}

/**
 * `text` with every known secret value replaced, longest first. Error bodies
 * reach here decoded (see `readableBody`); the encoded forms cover text that
 * quotes a secret some other way.
 */
function scrub(text: string): string {
  const forms = [...knownSecrets].flatMap((s) => [
    s,
    JSON.stringify(s).slice(1, -1),
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'),
    encodeURIComponent(s),
  ]);
  return [...new Set(forms)].sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join('<redacted>'), text);
}

/**
 * Write a fetched config into the tree with credentials swapped for
 * placeholders; their values go to the env file, never to the tree.
 */
const ALLOW_FILE = 'channelvault.allow.json';

/** Known false positives, committed with the tree: `{ "ignore": [{ "location", "kind", "note"? }] }`. */
async function readAllow(root: string): Promise<AllowEntry[]> {
  const file = path.join(root, ALLOW_FILE);
  if (!existsSync(file)) return [];
  const parsed = await readJson<{ ignore?: AllowEntry[] }>(file);
  return parsed.ignore ?? [];
}

/**
 * Write a fetched config into the tree with credentials swapped for
 * placeholders; their values go to the env file, never to the tree. Anything
 * that still looks like a secret stops the write unless --extract-secrets.
 */
async function writeTree(root: string, fetched: CanonicalConfig, source: string, flags: EnvFlags): Promise<void> {
  const envFile = envFilePath(root, flags);
  const previousMeta = await preflightTree(root, envFile);
  const env = await loadEnv(envFile);
  const templated = templatize(fetched, await existingTree(root), env);
  const scan = scanSecrets(templated.config, {
    mode: flags.extractSecrets ? 'extract' : 'find',
    allow: await readAllow(root),
    env: { ...env, ...templated.envUpdates },
  });
  if (scan.findings.length > 0 && !flags.extractSecrets) {
    fail(
      `found ${scan.findings.length} possible secret(s) that would be stored in plain text; nothing was written:\n` +
        `${formatFindings(scan.findings)}\n` +
        `Rerun with --extract-secrets to move them to ${envFile}, or list false positives in ${ALLOW_FILE}.`,
    );
  }
  const config = scan.config;
  const envUpdates = { ...templated.envUpdates, ...scan.envUpdates };
  rememberSecrets(config, { ...env, ...envUpdates });
  // A known secret repeated somewhere no rule recognised is still in plain
  // text; say where (the env file's own values only, not all of process.env).
  const echoes = findEchoes(config, { ...(await readEnvFile(envFile)), ...envUpdates });

  // Secrets first: a tree whose placeholders have no values behind them is
  // the one state a pull must never leave. If the env file can't be written,
  // the tree is untouched.
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(envFile), { recursive: true });
  const rel = path.relative(root, envFile);
  const envInTree = !rel.startsWith('..') && !path.isAbsolute(rel);
  const backup = await backupEnvFile(envFile, envUpdates, path.join(root, '.secrets'));
  if (backup || (envInTree && Object.keys(envUpdates).length > 0)) await ensureEnvIgnored(root, envInTree ? envFile : undefined);
  await updateEnvFile(envFile, envUpdates);

  await replaceTree(root, config);
  await writeMeta(root, source, fetched, previousMeta);
  if (scan.findings.length > 0) process.stdout.write(`extracted ${scan.findings.length} secret(s) found in values\n`);
  const updated = Object.keys(envUpdates).length;
  if (updated > 0) process.stdout.write(`stored ${updated} secret value(s) in ${envFile}\n`);
  if (backup) process.stdout.write(`previous env file kept as ${backup}\n`);
  for (const note of templated.notes) process.stderr.write(`note: ${note}\n`);
  for (const e of echoes) {
    process.stderr.write(`warning: the value of ${e.name} also appears in plain text at ${e.where}\n`);
  }
  if (existsSync(envFile) && gitWouldCommit(envFile)) {
    process.stderr.write(`warning: git does not ignore ${envFile}, so its secret values could be committed; add it to .gitignore\n`);
  }
}

/**
 * True when `file` is inside a git work tree and not ignored there (or is
 * already tracked). Outside a repository, or without git, there is nothing to
 * commit it to.
 */
function gitWouldCommit(file: string): boolean {
  const r = spawnSync('git', ['check-ignore', '-q', path.basename(file)], { cwd: path.dirname(file) });
  return r.status === 1;
}

/** `p` with links resolved as far as it exists (the rest may not be created yet). */
async function resolvedPath(p: string): Promise<string> {
  const abs = path.resolve(p);
  let existing = abs;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(await realpath(existing), path.relative(existing, abs));
}

/** `child` is `parent` or inside it (case-insensitively on Windows). */
function isWithin(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(parent), norm(child));
  // `..runtime.env` is a file name, not a step up.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Everything that can stop `pull`/`explode` must be checked before either
 * writes: they update the env file, then replace the managed directories,
 * then rewrite `channelvault.json`. Returns the existing metadata, if any.
 */
async function preflightTree(root: string, envFile: string): Promise<SyncMeta | null> {
  // The swap deletes these, so the env file must not live in one: neither by
  // the path given (a link inside one is removed with it) nor by where links
  // lead.
  const [realRoot, realEnv] = await Promise.all([resolvedPath(root), resolvedPath(envFile)]);
  const doomed = [...MANAGED_DIRS, STAGING_DIR].find(
    (d) => isWithin(path.resolve(envFile), path.resolve(root, d)) || isWithin(realEnv, path.join(realRoot, d)),
  );
  if (doomed) fail(`the env file ${envFile} is inside ${doomed}/, which this command replaces; keep it elsewhere`);

  const metaPath = path.join(root, 'channelvault.json');
  if (existsSync(metaPath)) {
    let meta: unknown;
    try {
      meta = await readJson(metaPath);
    } catch (err) {
      meta = err;
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || meta instanceof Error || typeof (meta as SyncMeta).source !== 'string') {
      fail(
        `${metaPath} is unreadable or not channelvault metadata${meta instanceof Error ? ` (${meta.message})` : ''}; nothing was written. ` +
          'Restore it (for example `git checkout -- channelvault.json`) and retry.',
      );
    }
    return meta as SyncMeta;
  }
  // The managed directories must be ones channelvault wrote.
  const foreign = MANAGED_DIRS.filter((d) => existsSync(path.join(root, d)));
  if (foreign.length > 0) {
    fail(
      `${root} is not a channelvault tree (no channelvault.json) but has ${foreign.map((d) => `${d}/`).join(', ')}, ` +
        'which this command would replace; nothing was written. Use a new or empty directory ' +
        '(or, if an earlier pull or explode into it was interrupted, delete those directories).',
    );
  }
  return null;
}

/**
 * Explode into a staging directory inside the tree, then swap it in one
 * managed directory at a time. A failure while exploding leaves the old tree
 * as it was; only the swap itself (a few renames) can be interrupted.
 */
async function replaceTree(root: string, config: CanonicalConfig): Promise<void> {
  const staging = path.join(root, STAGING_DIR);
  await rm(staging, RM_OPTS);
  try {
    await engine.explode(config, { root: staging });
    for (const d of MANAGED_DIRS) {
      await rm(path.join(root, d), RM_OPTS);
      if (existsSync(path.join(staging, d))) await rename(path.join(staging, d), path.join(root, d));
    }
  } finally {
    await rm(staging, RM_OPTS);
  }
}


function assertTree(root: string): void {
  if (!existsSync(path.join(root, 'server', 'configuration.json'))) {
    fail(`${root} is not a channelvault tree (missing server/configuration.json). Run 'pull' or 'explode' first.`);
  }
}

/**
 * Which transport a working tree came from. The XML adapter and the live REST
 * API produce structurally DIFFERENT canonical configs (fast-xml-parser
 * `@_version`/`#text`/all-strings vs Jackson `@version`/native types), and the
 * normalization bridge between them is not implemented yet. So an XML-exploded
 * tree cannot be `push`ed to a live server, and a live-pulled tree cannot be
 * `implode`d to XML, without silent corruption. These helpers detect the origin
 * so those cross-path operations can be refused.
 */
type TreeOrigin = 'xml' | 'live' | 'unknown';

/** Read the recorded origin from `channelvault.json` (`source` field). */
async function readTreeOrigin(root: string): Promise<TreeOrigin> {
  const metaPath = path.join(root, 'channelvault.json');
  if (!existsSync(metaPath)) return 'unknown';
  try {
    const meta = await readJson<SyncMeta>(metaPath);
    if (typeof meta.source === 'string') {
      if (meta.source.startsWith('file:')) return 'xml';
      if (/^https?:\/\//i.test(meta.source)) return 'live';
    }
  } catch {
    /* unreadable meta -> fall back to shape detection */
  }
  return 'unknown';
}

/** Infer origin from the config's attribute-key convention when meta is absent. */
function detectConfigShape(config: CanonicalConfig): TreeOrigin {
  if ('@_version' in config) return 'xml';
  if ('@version' in config) return 'live';
  return 'unknown';
}

/**
 * Resolve a tree's transport, preferring recorded provenance and falling back
 * to the imploded config's shape. Refuses the operation when the tree's origin
 * is incompatible with `wants` (unless `force`).
 */
async function assertCompatibleOrigin(
  root: string,
  config: CanonicalConfig,
  wants: 'xml' | 'live',
  force: boolean,
): Promise<void> {
  if (force) return;
  const origin = await readTreeOrigin(root);
  const effective = origin !== 'unknown' ? origin : detectConfigShape(config);
  if (effective === 'unknown' || effective === wants) return;

  const msg =
    wants === 'live'
      ? `this working tree was exploded from an XML backup, but 'push' sends to a live server. ` +
        `The two transports use different config shapes and the normalization bridge is not implemented yet, ` +
        `so pushing would upload a config the Mirth API cannot parse. Seed the tree with 'pull' instead, or pass --ignore-origin to override.`
      : `this working tree was pulled from a live server, but 'implode' writes a backup XML. ` +
        `The two transports use different config shapes and the normalization bridge is not implemented yet, ` +
        `so imploding would produce malformed XML. Re-create the tree with 'explode' from a backup, or pass --force to override.`;
  fail(msg);
}

/** Commander collector for a repeatable option; undefined until first used. */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

// --- push ---------------------------------------------------------------------

/** Resource ids recorded at the last pull, if this tree has them. */
async function readKnown(root: string): Promise<Known | undefined> {
  const metaPath = path.join(root, 'channelvault.json');
  if (!existsSync(metaPath)) return undefined;
  return knownFrom((await readJson<SyncMeta>(metaPath)).resources);
}

async function writeKnown(root: string, known: Known): Promise<void> {
  const metaPath = path.join(root, 'channelvault.json');
  if (!existsSync(metaPath)) return;
  const meta = await readJson<SyncMeta>(metaPath);
  if (!meta.resources) return; // an older tree: leave it to the next pull
  meta.resources = known;
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

function printChanges(plan: Plan): void {
  const kindLabel: Record<Change['kind'], string> = { channel: 'channel', library: 'library', codeTemplate: 'code template', globalScripts: '' };
  for (const c of plan.changes) process.stdout.write(`  ${c.op.padEnd(6)}  ${`${kindLabel[c.kind]} ${c.label}`.trim()}\n`);
}

/** Refuse conflicts and deletions unless the user opted in. */
function checkPlan(plan: Plan, flags: { allowDeletes?: boolean; force?: boolean }): void {
  if (plan.conflicts.length > 0 && !flags.force) {
    fail(
      `changed on the server since the last pull:\n  ${plan.conflicts.join('\n  ')}\n` +
        `pull (and merge) first, or pass --force to overwrite the server's version`,
    );
  }
  const deletes = plan.changes.filter((c) => c.op === 'delete').length;
  if (deletes > 0 && !flags.allowDeletes) {
    fail(`the plan deletes ${deletes} resource(s) from the server; pass --allow-deletes, or narrow with --channel/--library`);
  }
}

interface PushFlags {
  allowDeletes?: boolean;
  deploy?: boolean;
  force?: boolean;
  yes?: boolean;
  overwriteConfigMap?: boolean;
}

async function scopedPush(
  client: MirthClientExt,
  root: string,
  local: CanonicalConfig,
  scope: Scope,
  target: string,
  flags: PushFlags,
): Promise<void> {
  const remote = await client.getServerConfiguration();
  const known = await readKnown(root);
  const plan = planPush(local, remote, scope, known);
  const names = new Map(
    [...channelsOf(remote), ...channelsOf(local)].map((c) => [String(c['id']), String(c['name'])] as const),
  );
  const nameOf = (id: string): string => names.get(id) ?? id;

  // --deploy refreshes what is running; it never starts a channel that is not
  // deployed now (an operator may have taken it down on purpose).
  const deployed = flags.deploy && plan.deployIds.length > 0 ? await client.getDeployedChannelIds() : new Set<string>();
  const toDeploy = plan.deployIds.filter((id) => deployed.has(id));
  const notDeployed = flags.deploy ? plan.deployIds.filter((id) => !deployed.has(id)) : [];

  if (plan.changes.length === 0) {
    process.stdout.write(`nothing to push: ${target} already matches the tree\n`);
  } else {
    process.stdout.write(`Push to ${target}:\n`);
    printChanges(plan);
    if (toDeploy.length > 0) process.stdout.write(`then redeploy: ${toDeploy.map(nameOf).join(', ')}\n`);
    if (notDeployed.length > 0) {
      process.stdout.write(`not redeployed (not deployed on the server now): ${notDeployed.map(nameOf).join(', ')}\n`);
    }
  }
  if (plan.notPushed.length > 0) {
    process.stdout.write(`not pushed (differs; use --whole-server): ${plan.notPushed.join(', ')}\n`);
  }
  if (plan.serverOnly.length > 0) {
    process.stdout.write(`left alone (created on the server since the last pull; pull to get them): ${plan.serverOnly.join(', ')}\n`);
  }
  if (plan.changes.length === 0) return;

  checkPlan(plan, flags);
  if (!flags.yes && !(await confirm('Continue?'))) {
    process.stdout.write('aborted.\n');
    return;
  }

  // The prompt may have been open for a while: re-check that nothing in the
  // plan changed on the server meanwhile. Each channel save re-checks its own
  // revision once more; the gap after that last check can't be closed from
  // here, because Mirth accepts a stale revision.
  const fresh = await client.getServerConfiguration();
  const moved = changedSince(plan, remote, fresh);
  if (moved.length > 0 && !flags.force) {
    fail(`changed on the server while this push was being confirmed:\n  ${moved.join('\n  ')}\npull and try again, or pass --force`);
  }
  // Apply against the fresh snapshot, so whatever is sent for resources
  // outside the plan (the rest of the library list) is the server's latest.
  const result = await applyPlan(client, plan, local, fresh, scope, { force: flags.force === true });
  // Record the server's new revisions even after a partial failure, so the
  // resources that did go through don't read as conflicts next time.
  try {
    const after = await client.getServerConfiguration();
    const refreshedLibraries: Change[] = librariesOf(local)
      .filter(l => result.touchedIds.has(String(l['id'])))
      .map(l => ({ kind: 'library', op: 'update', id: String(l['id']), label: String(l['name']) }));
    const changedAgain = [...result.applied, ...refreshedLibraries].filter(c => !savedChangeMatches(c, local, after));
    if (changedAgain.length > 0) fail(`changed again after saving: ${[...new Set(changedAgain.map(c => c.label))].join(', ')}; pull and review before retrying`);
    if (result.touchedIds.size > 0) await refreshRevisions(root, after, result.touchedIds);
    if (known) await writeKnown(root, knownAfterPush(known, result.applied, result.touchedIds, after));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!result.failed) fail(`applied ${result.applied.length} change(s), but could not refresh the local sync baseline: ${message}; inspect the server before retrying`);
    process.stderr.write(`warning: could not refresh the local sync baseline: ${scrub(message)}\n`);
  }
  if (result.failed) {
    const { change, error } = result.failed;
    fail(`applied ${result.applied.length} of ${plan.changes.length}; ${change.op} ${change.label} failed: ${error}`);
  }
  process.stdout.write(`pushed ${result.applied.length} change(s)\n`);

  if (toDeploy.length > 0) {
    const failures = await deployChannels(client, toDeploy, nameOf);
    process.stdout.write(`deployed ${toDeploy.length - failures.length} of ${toDeploy.length} channel(s)\n`);
    for (const f of failures) process.stderr.write(`deploy failed: ${f.name}: ${scrub(f.error)}\n`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

/** The full replace, gated like a scoped push: it lists and guards deletions and conflicts too. */
async function wholeServerPush(
  client: MirthClientExt,
  root: string,
  local: CanonicalConfig,
  target: string,
  flags: PushFlags,
): Promise<void> {
  const remote = await client.getServerConfiguration();
  const known = await readKnown(root);
  const plan = planPush(local, remote, {}, known);
  const s = summarize(local);
  process.stdout.write(
    `Replace the ENTIRE server configuration at ${target} (${s.channels} channels, ${s.codeTemplates} code templates` +
      `${flags.deploy ? ', then redeploy all channels' : ''}).\n`,
  );
  if (plan.changes.length > 0) {
    process.stdout.write('Channel, library and template changes:\n');
    printChanges(plan);
  }
  // A full replace also deletes what the server has and the tree never had
  // (created since the pull). That is both a deletion and someone else's
  // work: it needs --allow-deletes and --force, and the preview names it.
  for (const r of plan.serverOnly) process.stdout.write(`  delete  ${r} (created on the server since the last pull)\n`);
  // Mirth keeps its own configuration map unless told to overwrite it.
  const keptMap = plan.notPushed.includes('configurationMap') && !flags.overwriteConfigMap;
  const replaced = plan.notPushed.filter((k) => !(keptMap && k === 'configurationMap'));
  if (replaced.length > 0) process.stdout.write(`also replaced: ${replaced.join(', ')}\n`);
  if (keptMap) process.stdout.write('configuration map differs but is kept (--overwrite-config-map replaces it)\n');
  if (plan.serverOnly.length > 0 && !flags.force) {
    fail('the replace would delete resources created on the server since the last pull; pull first, or pass --force (and --allow-deletes)');
  }
  const deletions = plan.changes.filter((c) => c.op === 'delete').length + plan.serverOnly.length;
  if (deletions > 0 && !flags.allowDeletes) {
    fail(`the replace deletes ${deletions} resource(s) from the server; pass --allow-deletes`);
  }
  checkPlan(plan, flags);
  if (!flags.yes && !(await confirm('Continue?'))) {
    process.stdout.write('aborted.\n');
    return;
  }
  // The preview was made from `remote`; anything changed since would be
  // overwritten without having been shown.
  const fresh = await client.getServerConfiguration();
  if (!sameServerConfig(remote, fresh) && !flags.force) {
    fail('the server changed while this push was being confirmed; pull and try again, or pass --force');
  }
  // Force permits concurrent edits, but never grants deletion consent.
  const freshPlan = planPush(local, fresh, {}, known);
  if (!flags.allowDeletes && (freshPlan.serverOnly.length > 0 || freshPlan.changes.some(c => c.op === 'delete'))) {
    fail('the replace now deletes resources from the server; review the new plan and pass --allow-deletes');
  }
  await client.putServerConfiguration(local, {
    deploy: flags.deploy === true,
    overwriteConfigMap: flags.overwriteConfigMap === true,
  });
  const after = await client.getServerConfiguration();
  if (planPush(local, after).changes.length > 0) {
    fail('applied the whole-server replacement, but resources changed again after saving; pull and review before retrying');
  }
  const ids = resourceIds(local);
  await refreshRevisions(root, after, new Set([...Object.keys(ids.channels), ...Object.keys(ids.libraries), ...Object.keys(ids.codeTemplates)]));
  if (known) await writeKnown(root, resourceIds(after));
  process.stdout.write(`pushed ${root} -> ${target}\n`);
}

// --- commands -------------------------------------------------------------

const program = new Command();
program
  .name('channelvault')
  .description('Git-style pull/push/diff for Mirth Connect')
  .version(VERSION)
  // An unused argument is almost always a flag lost in transit (e.g. a script
  // runner passing a literal `--`); fail rather than silently drop it.
  // Subcommands defined below inherit this.
  .allowExcessArguments(false);

addExtractFlag(addEnvFlag(
  program
    .command('explode')
    .description('Explode a Mirth backup XML into a working tree')
    .argument('<backup.xml>', 'path to a Mirth backup config XML file')
    .argument('<dir>', 'output working-tree directory'),
)).action(async (backupPath: string, dir: string, flags: EnvFlags) => {
  const config = xml.parse(await readFile(backupPath, 'utf8'));
  const root = path.resolve(dir);
  await writeTree(root, config, `file:${path.resolve(backupPath)}`, flags);
  const s = summarize(config);
  process.stdout.write(`exploded ${s.channels} channels, ${s.codeTemplates} code templates -> ${root}\n`);
});

addEnvFlag(
  program
    .command('implode')
    .description('Reassemble a working tree into a Mirth backup XML')
    .argument('<dir>', 'working-tree directory')
    .argument('<backup.xml>', 'output XML path')
    .option('--force', 'implode even if the tree was pulled from a live server', false),
).action(async (dir: string, outPath: string, flags: EnvFlags & { force?: boolean }) => {
    const root = path.resolve(dir);
    assertTree(root);
    const config = await renderedTree(root, flags);
    await assertCompatibleOrigin(root, config, 'xml', flags.force === true);
    const xmlStr = xml.build(config);
    await writeFile(outPath, xmlStr, 'utf8');
    process.stdout.write(`imploded ${root} -> ${path.resolve(outPath)}\n`);
  });

addExtractFlag(addEnvFlag(addConnectionFlags(
  program
    .command('pull')
    .description('Pull the live server configuration into a working tree')
    .argument('<dir>', 'working-tree directory'),
))).action(async (dir: string, flags: ConnectionFlags & EnvFlags) => {
  const root = path.resolve(dir);
  await preflightTree(root, envFilePath(root, flags)); // before fetching a whole server for nothing
  const config = await withClient(flags, (client) => client.getServerConfiguration());
  const cfg = resolveClientConfig(flags);
  await writeTree(root, config, `${cfg.https === false ? 'http' : 'https'}://${cfg.host}:${cfg.port}`, flags);
  const s = summarize(config);
  process.stdout.write(`pulled ${s.channels} channels, ${s.codeTemplates} code templates -> ${root}\n`);
});

addEnvFlag(addConnectionFlags(
  program
    .command('push')
    .description('Push changed channels, code templates and global scripts to the live server')
    .argument('<dir>', 'working-tree directory')
    .option('--channel <name>', 'only this channel (name or id); repeatable', collect)
    .option('--library <name>', 'only this code template library (name or id); repeatable', collect)
    .option('--global-scripts', 'with --channel/--library: also push global scripts')
    .option('--allow-deletes', 'delete server resources that are missing from the tree', false)
    .option('--deploy', 'redeploy the changed channels and the channels using changed code templates', false)
    .option('--force', "push even if the server changed since the last pull (overwrites the server's version)", false)
    .option('--ignore-origin', 'push a tree that was exploded from an XML backup (normally refused)', false)
    .option('--whole-server', 'replace the entire server configuration instead (settings, config map, groups too)', false)
    .option('--overwrite-config-map', 'with --whole-server: also overwrite the configuration map', false)
    .option('-y, --yes', 'skip the confirmation prompt', false),
)).action(
  async (
    dir: string,
    flags: ConnectionFlags & EnvFlags & {
      channel?: string[];
      library?: string[];
      globalScripts?: boolean;
      allowDeletes?: boolean;
      deploy?: boolean;
      wholeServer?: boolean;
      overwriteConfigMap?: boolean;
      yes?: boolean;
      force?: boolean;
      ignoreOrigin?: boolean;
    },
  ) => {
    if (flags.wholeServer && (flags.channel || flags.library || flags.globalScripts)) {
      fail('--whole-server replaces everything; it cannot be combined with --channel, --library or --global-scripts');
    }
    const root = path.resolve(dir);
    assertTree(root);
    const config = await renderedTree(root, flags);
    await assertCompatibleOrigin(root, config, 'live', flags.ignoreOrigin === true);
    const cfg = resolveClientConfig(flags);
    const target = `${cfg.https === false ? 'http' : 'https'}://${cfg.host}:${cfg.port}`;
    if (!flags.yes && !process.stdin.isTTY) {
      fail('no terminal to confirm on; review with `diff` and pass --yes');
    }
    if (flags.wholeServer) {
      await withClient(flags, (client) => wholeServerPush(client, root, config, target, flags));
      return;
    }
    const scope: Scope = { channels: flags.channel, libraries: flags.library, globalScripts: flags.globalScripts };
    await withClient(flags, (client) => scopedPush(client, root, config, scope, target, flags));
  },
);

addEnvFlag(addConnectionFlags(
  program
    .command('diff')
    .description('Diff a working tree against the live server configuration (exit 0 = same, 1 = differences, 2 = error)')
    .argument('<dir>', 'working-tree directory')
    // Usage errors must not read as "differences found" either.
    .exitOverride((err) => {
      process.exitCode = err.exitCode === 0 ? 0 : 2;
      throw err;
    }),
)).action(async (dir: string, flags: ConnectionFlags & EnvFlags) => {
  errorExitCode = 2;
  const root = path.resolve(dir);
  assertTree(root);

  const fetched = await withClient(flags, (client) => client.getServerConfiguration());
  const tree = await engine.implode({ root });
  // Compare like with like: the server's credentials become the placeholders
  // the tree holds. Values that differ from the env file are named, never shown.
  const { config: templatedRemote, envUpdates, notes } = templatize(fetched, tree, await loadEnv(envFilePath(root, flags)));
  for (const name of Object.keys(envUpdates)) {
    process.stderr.write(`note: ${name} differs between the server and the env file\n`);
  }
  for (const note of notes) process.stderr.write(`note: ${note}\n`);
  // Redact both sides the same way, so neither can print a secret and a raw
  // secret held on both sides doesn't read as a difference.
  const allow = await readAllow(root);
  // Line endings are normalised too: push ignores them because Mirth rewrites them on save.
  const treeView = scanSecrets(redactKnownSecrets(normalizeEolDeep(tree)), { mode: 'redact', allow });
  const serverView = scanSecrets(redactKnownSecrets(normalizeEolDeep(templatedRemote)), { mode: 'redact', allow });
  if (treeView.findings.length > 0) {
    process.stderr.write(`note: the tree holds ${treeView.findings.length} unextracted secret(s), redacted below; pull --extract-secrets\n`);
  }
  if (serverView.findings.length > 0) {
    process.stderr.write(`note: ${serverView.findings.length} possible secret(s) on the server are redacted below\n`);
  }
  const tmp = await mkdtemp(path.join(tmpdir(), 'channelvault-diff-'));
  try {
    // Both sides are exploded fresh from their configs, into tmp/tree and
    // tmp/server, and compared from tmp so paths print as tree/… and server/….
    await engine.explode(treeView.config, { root: path.join(tmp, 'tree') });
    await engine.explode(serverView.config, { root: path.join(tmp, 'server') });
    await mkdir(path.join(tmp, '.empty'));
    const chunks: string[] = [];
    // Only what explode owns; per directory, because git diff --no-index takes two paths.
    for (const d of MANAGED_DIRS) {
      const local = existsSync(path.join(tmp, 'tree', d)) ? `tree/${d}` : '.empty';
      const server = existsSync(path.join(tmp, 'server', d)) ? `server/${d}` : '.empty';
      if (local === '.empty' && server === '.empty') continue;
      // Pin line-ending handling so the answer doesn't depend on the user's git
      // config, and match push, which ignores CR-only differences.
      const result = spawnSync(
        'git',
        ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--ignore-cr-at-eol', local, server],
        { encoding: 'utf8', cwd: tmp },
      );
      // spawnSync does NOT throw when the binary is missing or the spawn fails --
      // it returns { error, status: null }. Treating an empty stdout as "no diff"
      // would print a confident false-clean on the exact gate users run before a
      // destructive push, so inspect the outcome explicitly.
      //   git diff --no-index exits 0 when identical, 1 when differences exist;
      //   any other code (or a spawn error) is a real failure.
      if (result.error) {
        fail(`failed to run git (is it installed and on PATH?): ${result.error.message}`);
      }
      if (result.status !== 0 && result.status !== 1) {
        const stderr = (result.stderr ?? '').trim();
        fail(`git diff failed (exit ${result.status ?? 'null'})${stderr ? `: ${stderr}` : ''}`);
      }
      const chunk = (result.stdout ?? '').trim();
      if (chunk !== '') chunks.push(chunk);
    }
    const out = chunks.join('\n');
    // A secret changed on the server is drift too, even though both sides show
    // the same placeholder; name it, never its value.
    const secretDrift = Object.keys(envUpdates);
    if (out === '' && secretDrift.length === 0) {
      process.stdout.write('no differences — working tree matches the server.\n');
    } else {
      if (out !== '') process.stdout.write(out + '\n');
      if (secretDrift.length > 0) {
        process.stdout.write(`secret values differ between the server and the env file: ${secretDrift.join(', ')}\n`);
      }
      process.exitCode = 1;
    }
  } finally {
    await rm(tmp, RM_OPTS);
  }
});

program
  .command('status')
  .description('Summarize a working tree')
  .argument('<dir>', 'working-tree directory')
  .action(async (dir: string) => {
    const root = path.resolve(dir);
    assertTree(root);
    const config = await engine.implode({ root });
    const s = summarize(config);
    const metaPath = path.join(root, 'channelvault.json');
    if (existsSync(metaPath)) {
      const meta = await readJson<SyncMeta>(metaPath);
      process.stdout.write(`source:  ${meta.source}\n`);
      process.stdout.write(`pulled:  ${meta.pulledAt}\n`);
      process.stdout.write(`engine:  ${meta.engineVersion ?? 'unknown'}\n`);
    }
    process.stdout.write(
      `channels:               ${s.channels}\n` +
        `channel groups:         ${s.channelGroups}\n` +
        `code template libs:     ${s.codeTemplateLibraries}\n` +
        `code templates:         ${s.codeTemplates}\n`,
    );
  });

program.parseAsync().catch((err: unknown) => {
  // Commander has already printed it and set the exit code.
  if (err instanceof CommanderError) return;
  process.stderr.write(`error: ${scrub(err instanceof Error ? err.message : String(err))}\n`);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && UNTRUSTED_CERT_CODES.has(code)) {
    process.stderr.write(
      "hint: the server's TLS certificate is not trusted. For a self-signed certificate (Mirth's default), " +
        'pass --insecure, which turns certificate verification off.\n',
    );
  }
  if (!(err instanceof CliError) && err instanceof Error && process.env.CHANNELVAULT_DEBUG) {
    process.stderr.write(`${scrub(err.stack ?? '')}\n`);
  }
  process.exitCode = errorExitCode;
});
