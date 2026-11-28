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
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { Command, CommanderError } from 'commander';

import { createExplodeEngine } from './explode/index.js';
import { XmlConfigAdapter } from './xml/index.js';
import { createMirthClient, presentedFingerprint, UNTRUSTED_CERT_CODES, type MirthClientExt } from './client/index.js';
import { connectionJson, describeConnection, profileOwning, resolveConnection, urlOf, type Connection, type ConnectionFlags } from './connection.js';
import {
  credentialsFile, formatFingerprint, isLoopback, loadProfiles, normalizeFingerprint, PROFILE_NAME, profileProblems, profilesFile,
  readCredentials, ReasonError, saveProfiles, setCredential, type Profile, type Profiles,
} from './profiles.js';
import { canonical, isWithin, resolvedPath, samePath } from './paths.js';
import {
  adoptTarget,
  changedSince,
  channelsOf,
  knownAfterPush,
  librariesOf,
  savedChangeMatches,
  knownFrom,
  newerOnServer,
  normalizeEolDeep,
  withoutVolatile,
  planPush,
  resourceIds,
  sameServerConfig,
  type Change,
  type Known,
  type Plan,
  type Scope,
} from './push/index.js';
import { applyPlan, deployChannels, refreshRevisions } from './push/apply.js';
import {
  baselineAfterPush,
  configMapBaseline,
  configMapMoved,
  configMapOf,
  mergeConfigMap,
  otherDifferingKeys,
  planConfigMap,
  sameEntry,
  UnknownConfigMapKey,
  withSortedConfigMap,
  type ConfigMapBaseline,
  type ConfigMapChange,
  type ConfigMapPlan,
} from './push/configMap.js';
import { readConfigMapBaseline, writeConfigMapBaseline } from './configMapBaselines.js';
import { configMapKeyOf, placeholderNames, placeholderUse, redactKnownSecrets, render, templatize } from './secrets/index.js';
import { backupEnvFile, ensureEnvIgnored, readEnvFile, updateEnvFile } from './secrets/envfile.js';
import { findEchoes, formatFindings, scanSecrets, type AllowEntry } from './secrets/detect.js';
import { backupName, backupsOf, compareVersions, configuredName, DEFAULT_KEEP, defaultBackupDir, LEGACY_BACKUP_DIR, MANIFEST, numericVersion, originOf, originsIn, saveBackup, writePrivate } from './backup/index.js';
import { readJson } from './json.js';
import { forbiddenXmlChars, xmlSafetyProblem } from './xml/chars.js';
import type { ApiError, CanonicalConfig, ClientConfig, Json } from './types.js';
import { JOURNAL, lockTree, MANAGED_DIRS, pendingEnvFile, recoverTree, replaceTree, STAGING_DIR, treeFiles } from './tree/transaction.js';

const engine = createExplodeEngine();
const xml = new XmlConfigAdapter();

/** From package.json, one level up from both src/cli.ts and dist/cli.js. */
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

// --- helpers --------------------------------------------------------------

/** A user-facing error: printed without a stack trace, with its reason code when it has one. */
class CliError extends ReasonError {}

/**
 * Abort the command. Throws rather than calling process.exit so open
 * connections close first; exiting while undici sockets are closing crashes
 * Node on Windows with a libuv assertion.
 */
function fail(message: string, reason?: string): never {
  throw new CliError(message, reason);
}

/** Exit status for an error. `diff` uses 2, because its 1 means "differences found". */
let errorExitCode = 1;

/**
 * Recursive-remove options. `maxRetries` is essential on Windows, where a
 * recursive delete can transiently fail with EBUSY/ENOTEMPTY/EPERM while the OS
 * releases just-closed handles; `fs.rm` retries those specific errors.
 */
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

function addConnectionFlags(cmd: Command): Command {
  return cmd
    .option('--profile <name>', 'saved connection profile (env MIRTH_PROFILE); see `channelvault profile list`')
    .option('--host <host>', 'Mirth server host (env MIRTH_HOST)')
    .option('--port <port>', 'Mirth server port (env MIRTH_PORT)')
    .option('--user <user>', 'username (env MIRTH_USER)')
    .option('--pass <pass>', 'password (env MIRTH_PASS)')
    .option('--tls-fingerprint <sha256>', 'accept only the server certificate with this SHA-256 fingerprint (env MIRTH_TLS_FINGERPRINT)')
    .option('--insecure', 'turn TLS certificate verification off (prefer --tls-fingerprint)', false)
    .option('--no-https', 'use http instead of https');
}

function clientConfigOf(conn: Connection): ClientConfig {
  return {
    host: conn.host,
    port: conn.port,
    username: conn.user,
    password: conn.password,
    https: conn.https,
    disableTlsCheck: conn.insecure,
    ...(conn.tlsFingerprint ? { tlsFingerprint: conn.tlsFingerprint } : {}),
    // Opt-in: error bodies can echo credentials (see `scrub`, applied to all output).
    includeResponseBodies: Boolean(process.env.CHANNELVAULT_DEBUG),
  };
}

/** The connection in use, for the error hints printed after a failure. */
let activeConnection: Connection | undefined;
let loadedProfiles: Profiles = {};

/**
 * Resolve this command's connection once, before anything connects. `root`
 * is the tree whose committed serverId can select a profile and must match an
 * explicit one; `write` applies the typed-profile rule for real writes.
 */
async function selectConnection(root: string | undefined, flags: ConnectionFlags & { yes?: boolean }, opts: { write?: boolean; explicit?: boolean } = {}): Promise<Connection> {
  loadedProfiles = await loadProfiles();
  const meta = root ? await readMeta(root) : null;
  const conn = resolveConnection({
    flags,
    env: process.env,
    profiles: loadedProfiles,
    credentials: await readCredentials(),
    ...(meta?.serverId ? { treeServerId: meta.serverId } : {}),
    write: opts.write === true,
    yes: flags.yes === true,
    explicit: opts.explicit === true,
  });
  rememberSecret(conn.password, { stdout: true });
  activeConnection = conn;
  return conn;
}

/** For people: the URL, and the profile when one was used. */
function targetOf(conn: Connection): string {
  return conn.profile ? `${urlOf(conn)} (profile ${conn.profile})` : urlOf(conn);
}

/**
 * Log in, verify which installation answered, and print where the command is
 * going (stderr; under --json it goes into the document instead).
 */
async function withClient<T>(
  conn: Connection,
  fn: (client: MirthClientExt, serverId: string) => Promise<T>,
  opts: { envFile?: string; quiet?: boolean } = {},
): Promise<T> {
  const client = createMirthClient(clientConfigOf(conn));
  try {
    await client.login();
    const serverId = await client.getServerId();
    if (conn.serverId && serverId !== conn.serverId) {
      fail(`profile ${conn.profile} is installation ${conn.serverId}, but ${urlOf(conn)} answered as installation ${serverId}; nothing was done. ` +
        'If the server was reinstalled, check it with the administrator and update the profile', 'server-mismatch');
    }
    const owner = conn.source === 'env' ? profileOwning(loadedProfiles, serverId) : undefined;
    if (owner) fail(`MIRTH_HOST reaches installation ${serverId}, which is profile ${owner}; use --profile ${owner}, or unset MIRTH_HOST`, 'env-shadowed');
    if (!opts.quiet) process.stderr.write(`${describeConnection(conn, serverId, opts.envFile)}\n`);
    return await fn(client, serverId);
  } finally {
    await client.logout().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

// --- JSON output --------------------------------------------------------------

interface JsonFlags {
  json?: boolean;
}

/**
 * `--json`: one JSON document on stdout, for scripts and agents. Errors still
 * go to stderr with the command's exit code; notes move into the document.
 */
function addJsonFlag(cmd: Command): Command {
  return cmd.option('--json', 'print the result as one JSON document on stdout', false);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// --- backups ------------------------------------------------------------------

interface BackupFlags {
  backupDir?: string;
  keep?: string;
  /** false with --no-backup (push). */
  backup?: boolean;
}

function addBackupDirFlags(cmd: Command): Command {
  return cmd
    .option('--backup-dir <dir>', 'where backups are kept (default ~/.channelvault/backups, shared by every checkout)')
    .option('--keep <n>', `backups kept per server (default ${DEFAULT_KEEP})`);
}

function backupDirOf(flags: BackupFlags): string {
  return path.resolve(flags.backupDir ?? defaultBackupDir());
}

function keepOf(flags: BackupFlags): number {
  if (flags.keep === undefined) return DEFAULT_KEEP;
  const n = Number(flags.keep);
  if (!Number.isInteger(n) || n < 1) fail(`--keep must be a whole number of at least 1, not ${flags.keep}`);
  return n;
}

/** The name a server's backups are filed under; the host and port when it has no configured name. */
function serverNameOf(config: CanonicalConfig, conn: Connection): string {
  return backupName(config, `${conn.host}-${conn.port}`);
}

/** Parse backup XML, naming the file in the error. */
function parseBackup(text: string, where: string): CanonicalConfig {
  try {
    return xml.parse(text);
  } catch (err) {
    fail(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Save the server's configuration `text` as its newest backup and say where. */
async function saveServerBackup(
  client: MirthClientExt,
  text: string,
  conn: Connection,
  flags: BackupFlags,
  protect?: string,
): Promise<string> {
  const config = parseBackup(text, 'the server configuration');
  const origin = { serverId: await client.getServerId(), host: hostOf(conn) };
  const file = await saveBackup(backupDirOf(flags), serverNameOf(config, conn), text, { keep: keepOf(flags), origin, protect });
  if (gitWouldCommit(file)) {
    process.stderr.write(`warning: git does not ignore ${file}, which holds credentials in plain text; add it to .gitignore\n`);
  }
  return file;
}

/** Before a push changes anything: a backup to undo it with, unless --no-backup. */
async function backupBeforePush(client: MirthClientExt, conn: Connection, flags: BackupFlags & { overwriteConfigMap?: boolean; deploy?: boolean }): Promise<void> {
  if (flags.backup === false) return;
  const file = await saveServerBackup(client, await client.getServerConfigurationXml(), conn, flags);
  process.stdout.write(`backed up the server to ${file} (undo with: ${undoCommand(file, conn, flags)})\n`);
  printUndoLimits(conn, flags);
}

/** Literal arguments for the user's shell; never include a connection password. */
function shellArgument(value: string): string {
  return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Never `--yes`: an undo is a whole-server replace and gets its own review. */
function undoCommand(file: string, conn: Connection, flags: BackupFlags & { overwriteConfigMap?: boolean }): string {
  const args = ['channelvault', 'restore', shellArgument(file)];
  if (conn.profile) {
    args.push('--profile', shellArgument(conn.profile));
  } else {
    args.push('--host', shellArgument(conn.host), '--port', String(conn.port), '--user', shellArgument(conn.user));
    if (!conn.https) args.push('--no-https');
    if (conn.tlsFingerprint) args.push('--tls-fingerprint', conn.tlsFingerprint);
    else if (conn.insecure) args.push('--insecure');
  }
  args.push('--backup-dir', shellArgument(backupDirOf(flags)));
  if (flags.overwriteConfigMap) args.push('--overwrite-config-map');
  return args.join(' ');
}

function printUndoLimits(conn: Connection, flags: { deploy?: boolean }): void {
  if (conn.passwordSource === '--pass') process.stdout.write('undo authentication: supply this server\'s password through MIRTH_PASS; it is omitted from the command\n');
  if (flags.deploy) process.stdout.write('the undo restores saved configuration; runtime deployment state is not in the backup. Review targeted redeployment separately\n');
}

/** `host:port`, for telling people which server a backup came from. */
function hostOf(conn: Connection): string {
  return `${conn.host}:${conn.port}`;
}

/** With `secret`, nothing typed is echoed. */
async function ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  let output: NodeJS.WritableStream = process.stdout;
  if (opts.secret) {
    process.stdout.write(question);
    output = new Writable({ write: (_chunk, _enc, done) => done() });
  }
  const rl = createInterface({ input: process.stdin, output, terminal: opts.secret ? Boolean(process.stdin.isTTY) : undefined });
  const controller = new AbortController();
  rl.once('close', () => controller.abort());
  rl.once('SIGINT', () => controller.abort());
  try {
    const answer = await rl.question(opts.secret ? '' : question, { signal: controller.signal });
    if (opts.secret) process.stdout.write('\n');
    return opts.secret ? answer : answer.trim();
  } catch (err) {
    if (controller.signal.aborted) fail('confirmation interrupted; nothing was changed');
    throw err;
  } finally {
    rl.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
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
  /** Revision histories belong to this installation, independently of its URL or name. */
  serverId?: string;
}

/**
 * Record the server's map for later key pushes. A pull or adopt has done its
 * job without it (a read-only home, say), so a failure is a note: key pushes
 * then refuse for want of a baseline.
 */
async function recordConfigMapBaseline(serverId: string | undefined, baseline: ConfigMapBaseline): Promise<void> {
  if (!serverId) return;
  try {
    await writeConfigMapBaseline(serverId, baseline);
  } catch (err) {
    process.stderr.write(`note: could not record the configuration-map baseline (${err instanceof Error ? err.message : String(err)}); pushing configuration-map keys will need a pull that can\n`);
  }
}

/** The tree's channelvault.json; null when it has none. */
async function readMeta(root: string): Promise<SyncMeta | null> {
  const metaPath = path.join(root, 'channelvault.json');
  if (!existsSync(metaPath)) return null;
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

async function writeMeta(root: string, source: string, config: CanonicalConfig, previous: SyncMeta | null, serverId?: string, resources = resourceIds(config)): Promise<void> {
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
    resources,
    serverId,
  };
  // A pull that changed nothing else must not leave a timestamp-only change
  // for git to show.
  const file = path.join(root, 'channelvault.json');
  if (previous && JSON.stringify({ ...previous, pulledAt: '' }) === JSON.stringify({ ...meta, pulledAt: '' })) meta.pulledAt = previous.pulledAt;
  await writeFile(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

// --- secrets / env ----------------------------------------------------------

interface EnvFlags {
  dotenv?: string;
  extractSecrets?: boolean;
}

/**
 * The env file holding the tree's placeholder values: --dotenv, else the
 * connection profile's `dotenv` when `<dir>/.env` is absent or is that same
 * file, else `<dir>/.env`. Two different candidates are refused rather than
 * guessed between.
 */
async function envFileFor(root: string, flags: EnvFlags, conn?: Connection): Promise<string> {
  if (flags.dotenv) return path.resolve(flags.dotenv);
  const local = path.join(root, '.env');
  if (!conn?.dotenv) return local;
  if (!existsSync(local) || samePath(await canonical(local), await canonical(conn.dotenv))) {
    await assertNoSwapPending(conn.dotenv);
    return conn.dotenv;
  }
  fail(`both ${local} and profile ${conn.profile}'s env file ${conn.dotenv} exist; pass --dotenv to choose one, or remove the one that is stale`, 'env-ambiguous');
}

/**
 * A pull in another checkout replaces a profile's env file by renaming copies
 * beside it (`<file>.channelvault-<id>.next` / `.previous`); while they exist the
 * file may be absent or about to change.
 */
async function assertNoSwapPending(file: string): Promise<void> {
  const dir = path.dirname(file);
  if (!existsSync(dir)) return;
  const prefix = `${path.basename(file)}.channelvault-`;
  const pending = (await readdir(dir)).filter(n => n.startsWith(prefix) && /\.(next|previous)$/.test(n));
  if (pending.length > 0) {
    fail(`${file} is being replaced by a pull in another checkout (${pending.join(', ')} beside it); retry when it finishes, or rerun that checkout's command to finish an interrupted one`, 'env-busy');
  }
}

/** Every env file an interrupted replacement in `root` may legitimately name. */
async function recoveryCandidates(root: string, flags: EnvFlags): Promise<string[]> {
  if (flags.dotenv) return [path.resolve(flags.dotenv)];
  const dotenvs = Object.values(await loadProfiles()).flatMap(p => (p.dotenv ? [p.dotenv] : []));
  return [path.join(root, '.env'), ...dotenvs];
}

/** The env file overlaid with the process environment (which wins, as in CI). */
async function loadEnv(file: string): Promise<Record<string, string | undefined>> {
  return { ...(await readEnvFile(file)), ...process.env };
}

function addEnvFlag(cmd: Command): Command {
  // Not --env-file: Node scans the whole command line for that name and parses
  // the file itself (it fails on a directory and honours NODE_OPTIONS in it).
  return cmd.option('--dotenv <path>', 'env file holding the tree\'s placeholder values, not the login (default <dir>/.env)');
}

function addExtractFlag(cmd: Command): Command {
  return cmd.option('--extract-secrets', 'move secrets found inside values (URLs, scripts, headers) to the env file', false);
}

/** The tree as stored, placeholders unresolved; null if there is no tree yet. */
async function existingTree(root: string): Promise<CanonicalConfig | null> {
  return existsSync(path.join(root, 'server', 'configuration.json')) ? engine.implode({ root }) : null;
}

/** The tree with placeholders filled from the env file; fails listing any missing names. */
async function renderedTree(root: string, envFile: string): Promise<CanonicalConfig> {
  const tree = await engine.implode({ root });
  const env = await loadEnv(envFile);
  rememberSecrets(tree, env);
  return render(tree, env);
}

/**
 * The values behind the tree's placeholders, and the connection password. A
 * server's error can echo what was sent, so everything printed about a failure
 * goes through `scrub`; the connection password is scrubbed from every line.
 */
const knownSecrets = new Set<string>();
const everywhereSecrets = new Set<string>();

function rememberSecret(value: string | undefined, opts: { stdout?: boolean } = {}): void {
  // Shorter values (a port, "true") would redact ordinary words in error text;
  // on every line, so would a short password ("admin" in "administrator").
  if (value === undefined || value.length < 4) return;
  knownSecrets.add(value);
  if (opts.stdout && value.length >= 8) everywhereSecrets.add(value);
}

function rememberSecrets(tree: CanonicalConfig, env: Record<string, string | undefined>): void {
  for (const name of placeholderNames(tree)) rememberSecret(env[name]);
}

/**
 * Fail when a placeholder compared with the server has no value. Without it
 * the secret would compare as changed, which reads as drift rather than as a
 * checkout that can't compare secrets. Returns the names that have no value
 * yet but are used only by resources the server doesn't have.
 */
function assertEnvComplete(tree: CanonicalConfig, server: CanonicalConfig, env: Record<string, string | undefined>, envFile: string, conn: Connection): string[] {
  const { compared, treeOnly } = placeholderUse(tree, server);
  const unset = (names: Set<string>) => [...names].filter((name) => env[name] === undefined).sort();
  const missing = unset(compared);
  if (missing.length > 0) {
    const fix = conn.dotenv && samePath(envFile, conn.dotenv)
      ? `set them in profile ${conn.profile}'s env file, or pass --dotenv <file>`
      : `pass --dotenv <file>, or ${conn.profile ? `set profile ${conn.profile}'s dotenv` : 'use a connection profile with a dotenv'}`;
    const what = `no value for ${missing.join(', ')}, so those secrets can't be compared`;
    if (!existsSync(envFile)) fail(`there is no env file at ${envFile}: ${what}; ${fix}`, 'env-missing');
    fail(`${envFile} has ${what}; add them, or ${fix}`, 'env-incomplete');
  }
  return unset(treeOnly);
}

for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (everywhereSecrets.size === 0) return write(chunk, ...rest);
    if (typeof chunk === 'string') return write(scrub(chunk, everywhereSecrets), ...rest);
    if (Buffer.isBuffer(chunk)) return write(Buffer.from(scrub(chunk.toString('utf8'), everywhereSecrets), 'utf8'), ...rest);
    return write(chunk, ...rest);
  }) as typeof stream.write;
}

/**
 * `text` with every known secret value replaced, longest first. Error bodies
 * reach here decoded (see `readableBody`); the encoded forms cover text that
 * quotes a secret some other way.
 */
function scrub(text: string, secrets: ReadonlySet<string> = knownSecrets): string {
  const forms = [...secrets].flatMap((s) => [
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
async function writeTree(root: string, fetched: CanonicalConfig, source: string, flags: EnvFlags, envFile: string, serverId?: string): Promise<void> {
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

  const rel = path.relative(root, envFile);
  const envInTree = !rel.startsWith('..') && !path.isAbsolute(rel);
  let backup: string | null = null;
  await replaceTree(root, envFile, async next => {
    await engine.explode(config, { root: next });
    await writeMeta(next, source, fetched, previousMeta, serverId);
    if (Object.keys(envUpdates).length > 0) {
      const history = path.join(root, '.secrets');
      if (existsSync(history)) {
        if ((await lstat(history)).isSymbolicLink()) fail(`refusing a linked secret history directory: ${history}`);
        await cp(history, path.join(next, '.secrets'), { recursive: true });
      }
      const stagedBackup = await backupEnvFile(envFile, envUpdates, path.join(next, '.secrets'));
      if (stagedBackup) backup = path.join(root, '.secrets', path.basename(stagedBackup));
      if (backup || envInTree) {
        const ignore = path.join(root, '.gitignore');
        if (existsSync(ignore)) await writeFile(path.join(next, '.gitignore'), await readFile(ignore));
        await ensureEnvIgnored(next, envInTree ? envFile : undefined, root);
      }
      const stagedEnv = path.join(next, '.env');
      if (existsSync(envFile)) await writeFile(stagedEnv, await readFile(envFile), { mode: 0o600 });
      await updateEnvFile(stagedEnv, envUpdates);
    }
  });
  // Only a live pull knows the installation; an XML backup's map may be long stale.
  await recordConfigMapBaseline(serverId, configMapBaseline(fetched));
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
  const doomed = [...MANAGED_DIRS, STAGING_DIR, JOURNAL, 'channelvault.json', '.gitignore', '.secrets'].find(
    (d) => isWithin(path.resolve(envFile), path.resolve(root, d)) || isWithin(realEnv, path.join(realRoot, d)),
  );
  if (doomed) fail(`the env file ${envFile} is inside ${doomed}/, which this command replaces; keep it elsewhere`);

  const meta = await readMeta(root);
  if (meta) return meta;
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
  try {
    const meta = await readMeta(root);
    if (typeof meta?.source === 'string') {
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

async function bindingProblems(root: string, serverId: string): Promise<string[]> {
  const meta = await readMeta(root);
  if (meta?.serverId === serverId) return [];
  return [`this tree's baseline belongs to ${meta?.serverId ? `installation ${meta.serverId}` : 'an unknown installation'}, not the target (${serverId}); pull the target and merge your edits, or review with 'adopt <dir> --plan-only' and run 'adopt <dir>' to establish its baseline; --force does not bypass installation binding`];
}

async function xmlProblems(root: string, config: CanonicalConfig): Promise<string[]> {
  const problem = await xmlSafetyProblem(config, root);
  return problem ? [problem] : [];
}

async function assertBinding(client: MirthClientExt, root: string): Promise<void> {
  const problems = await bindingProblems(root, await client.getServerId());
  if (problems.length) fail(problems.join('\n'));
}

/** Resource ids recorded at the last pull, if this tree has them. */
async function readKnown(root: string): Promise<Known | undefined> {
  const meta = await readMeta(root);
  return meta ? knownFrom(meta.resources) : undefined;
}

async function writeKnown(root: string, known: Known): Promise<void> {
  const meta = await readMeta(root);
  if (!meta?.resources) return; // no metadata, or an older tree: leave it to the next pull
  meta.resources = known;
  await writeFile(path.join(root, 'channelvault.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/**
 * A whole replace carries the server and environment name along; say so, or
 * the server silently starts calling itself by another's name.
 */
function printNameChange(incoming: CanonicalConfig, current: CanonicalConfig): void {
  const [to, from] = [configuredName(incoming), configuredName(current)];
  if (to !== from) process.stdout.write(`server name changes: ${from || '(none)'} -> ${to || '(none)'}\n`);
}

/** A plan as shown and reported: resource changes plus configuration-map keys. */
type ShownPlan = Omit<Plan, 'changes'> & { changes: Array<Change | ConfigMapChange> };

function withConfigMap(plan: Plan, map: ConfigMapPlan): ShownPlan {
  return { ...plan, changes: [...map.changes, ...plan.changes], conflicts: [...map.conflicts, ...plan.conflicts] };
}

function printChanges(plan: ShownPlan): void {
  const kindLabel: Record<ShownPlan['changes'][number]['kind'], string> = {
    channel: 'channel', library: 'library', codeTemplate: 'code template', globalScripts: '', configMapKey: 'configuration-map key',
  };
  for (const c of plan.changes) process.stdout.write(`  ${c.op.padEnd(6)}  ${`${kindLabel[c.kind]} ${c.label}`.trim()}\n`);
}

/** Refuse conflicts and deletions unless the user opted in. */
function planProblems(plan: ShownPlan, flags: { allowDeletes?: boolean; force?: boolean }): string[] {
  const problems: string[] = [];
  if (plan.conflicts.length > 0 && !flags.force) {
    problems.push(
      `changed on the server since the last pull:\n  ${plan.conflicts.join('\n  ')}\n` +
        `pull (and merge) first, or pass --force to overwrite the server's version`,
    );
  }
  const deletes = plan.changes.filter((c) => c.op === 'delete').length;
  if (deletes > 0 && !flags.allowDeletes) {
    problems.push(`the plan deletes ${deletes} resource(s) from the server; pass --allow-deletes, or narrow the push`);
  }
  return problems;
}

/** What stops a whole-server replace: the scoped checks, plus resources the tree never had (deleted by a replace). */
function wholeServerProblems(plan: Plan, flags: { allowDeletes?: boolean; force?: boolean }): string[] {
  const problems: string[] = [];
  if (plan.serverOnly.length > 0 && !flags.force) {
    problems.push('the replace would delete resources created on the server since the last pull; pull first, or pass --force (and --allow-deletes)');
  }
  const deletions = plan.changes.filter((c) => c.op === 'delete').length + plan.serverOnly.length;
  if (deletions > 0 && !flags.allowDeletes) problems.push(`the replace deletes ${deletions} resource(s) from the server; pass --allow-deletes`);
  if (plan.conflicts.length > 0 && !flags.force) problems.push(...planProblems({ ...plan, changes: [] }, flags));
  return problems;
}

/** `push --plan-only`: report the plan and what would stop it, change nothing. */
function reportPlanOnly(
  flags: PushFlags,
  plan: ShownPlan,
  problems: string[],
  live: Live,
  extra: { target: string; mode: 'scoped' | 'whole-server' | 'adopt'; redeploy?: string[]; notRedeployed?: string[] },
): void {
  if (flags.json) {
    writeJson({
      target: extra.target,
      mode: extra.mode,
      serverId: live.serverId,
      connection: connectionJson(live.conn, live.serverId, live.envFile),
      changes: plan.changes,
      conflicts: plan.conflicts,
      serverOnly: plan.serverOnly,
      notPushed: plan.notPushed,
      ...(extra.redeploy ? { redeploy: extra.redeploy, notRedeployed: extra.notRedeployed ?? [] } : {}),
      wouldStop: problems,
    });
    return;
  }
  for (const p of problems) process.stdout.write(`a push would stop: ${p}\n`);
  process.stdout.write('plan only: nothing was changed\n');
}

/** Where a live command is connected: the resolved connection, the installation that answered, the env file in use. */
interface Live {
  conn: Connection;
  serverId: string;
  envFile?: string;
}

interface PushFlags extends ConnectionFlags, BackupFlags, JsonFlags {
  /** --plan-only: report the plan and what would stop it; change nothing. */
  planOnly?: boolean;
  allowDeletes?: boolean;
  deploy?: boolean;
  force?: boolean;
  yes?: boolean;
  overwriteConfigMap?: boolean;
  configMapKey?: string[];
}

const mapKeyLabel = (key: string): string => `configuration-map key "${key}"`;

/**
 * Save the named keys: read the map again right before the save, so the other
 * keys go back as the server holds them and a named key edited since `planned`
 * is caught, then check what was saved. Mirth offers no conditional save, so
 * an edit landing between that read and the save can't be caught here.
 */
async function pushConfigMapKeys(
  client: MirthClientExt,
  local: CanonicalConfig,
  planned: CanonicalConfig,
  named: string[],
  changed: string[],
  baseline: ConfigMapBaseline | undefined,
  serverId: string,
  flags: PushFlags,
): Promise<void> {
  const current = await client.getServerConfiguration();
  const moved = configMapMoved(named, planned, current);
  if (moved.length > 0 && !flags.force) {
    fail(`changed on the server just before saving the configuration map: ${moved.map(mapKeyLabel).join(', ')}; nothing was saved. Pull and try again, or pass --force`);
  }
  try {
    await client.putConfigurationMap(mergeConfigMap(current, local, changed));
  } catch (err) {
    fail(`saving the configuration map failed; nothing else was pushed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let after: CanonicalConfig;
  try {
    after = await client.getServerConfiguration();
  } catch (err) {
    fail(`saved the configuration map, but could not read it back to check it: ${err instanceof Error ? err.message : String(err)}. Nothing else was pushed. ${exportBrokenHint(flags)}`);
  }
  const tree = new Map(configMapOf(local).map((e) => [configMapKeyOf(e), e] as const));
  const saved = new Map(configMapOf(after).map((e) => [configMapKeyOf(e), e] as const));
  const wrong = changed.filter((k) => !sameEntry(tree.get(k), saved.get(k)));
  if (wrong.length > 0) {
    fail(`saved the configuration map, but these keys do not read back as the tree has them: ${wrong.join(', ')}. Nothing else was pushed. Review the server; the undo command above restores the whole server as it was before this push`);
  }
  // Most likely someone saving the map at the same time: undoing would discard their edit too.
  const others = otherDifferingKeys(current, after, changed);
  if (others.length > 0) {
    fail(`saved the named configuration-map keys, but other keys changed at the same time (probably a concurrent edit): ${others.join(', ')}. Nothing else was pushed. Review them on the server before pushing again`);
  }
  const next = baselineAfterPush(baseline, after, changed);
  if (next) await recordConfigMapBaseline(serverId, next);
  process.stdout.write(`saved ${changed.length} configuration-map key(s): ${changed.join(', ')}\n`);
}

async function scopedPush(
  client: MirthClientExt,
  root: string,
  local: CanonicalConfig,
  scope: Scope,
  target: string,
  flags: PushFlags,
  live: Live,
): Promise<void> {
  const remote = await client.getServerConfiguration();
  const known = await readKnown(root);
  const plan = planPush(local, remote, scope, known);
  const mapKeys = flags.configMapKey ?? [];
  const mapBaseline = mapKeys.length > 0 ? await readConfigMapBaseline(live.serverId) : undefined;
  let mapPlan: ConfigMapPlan = { changes: [], conflicts: [], unchanged: [] };
  try {
    if (mapKeys.length > 0) mapPlan = planConfigMap(local, remote, mapKeys, mapBaseline);
  } catch (err) {
    if (err instanceof UnknownConfigMapKey) fail(err.message, 'config-map-key-unknown');
    throw err;
  }
  const mapChanged = mapPlan.changes.map((c) => c.id);
  const shown = withConfigMap(plan, mapPlan);
  const problems = [...await bindingProblems(root, live.serverId), ...planProblems(shown, flags), ...await xmlProblems(root, local)];
  const names = new Map(
    [...channelsOf(remote), ...channelsOf(local)].map((c) => [String(c['id']), String(c['name'])] as const),
  );
  const nameOf = (id: string): string => names.get(id) ?? id;

  // --deploy refreshes what is running; it never starts a channel that is not
  // deployed now (an operator may have taken it down on purpose).
  const deployed = flags.deploy && plan.deployIds.length > 0 ? await client.getDeployedChannelIds() : new Set<string>();
  const toDeploy = plan.deployIds.filter((id) => deployed.has(id));
  const notDeployed = flags.deploy ? plan.deployIds.filter((id) => !deployed.has(id)) : [];

  if (flags.planOnly && flags.json) {
    const redeploy = flags.deploy ? { redeploy: toDeploy.map(nameOf), notRedeployed: notDeployed.map(nameOf) } : {};
    reportPlanOnly(flags, shown, problems, live, { target, mode: 'scoped', ...redeploy });
    return;
  }
  if (shown.changes.length === 0) {
    process.stdout.write(`nothing to push: ${target} already matches the tree\n`);
  } else {
    process.stdout.write(`Push to ${target}:\n`);
    printChanges(shown);
    if (toDeploy.length > 0) process.stdout.write(`then redeploy: ${toDeploy.map(nameOf).join(', ')}\n`);
    if (notDeployed.length > 0) {
      process.stdout.write(`not redeployed (not deployed on the server now): ${notDeployed.map(nameOf).join(', ')}\n`);
    }
  }
  if (plan.notPushed.length > 0) {
    const mapHint = plan.notPushed.includes('configurationMap') ? ', or --config-map-key for named configuration-map keys' : '';
    process.stdout.write(`not pushed (differs; use --whole-server${mapHint}): ${plan.notPushed.join(', ')}\n`);
  }
  if (mapPlan.unchanged.length > 0) process.stdout.write(`configuration-map keys already as in the tree: ${mapPlan.unchanged.join(', ')}\n`);
  if (mapKeys.length > 0) {
    const others = otherDifferingKeys(local, remote, mapKeys);
    if (others.length > 0) process.stdout.write(`other configuration-map keys differ (not pushed): ${others.join(', ')}\n`);
  }
  if (plan.serverOnly.length > 0) {
    process.stdout.write(`left alone (created on the server since the last pull; pull to get them): ${plan.serverOnly.join(', ')}\n`);
  }
  if (flags.planOnly) {
    reportPlanOnly(flags, shown, problems, live, { target, mode: 'scoped' });
    return;
  }
  if (problems.length > 0) fail(problems.join('\n'));
  if (shown.changes.length === 0) return;
  if (!flags.yes && !(await confirm('Continue?'))) {
    process.stdout.write('aborted.\n');
    return;
  }

  // The prompt may have been open for a while: re-check that nothing in the
  // plan changed on the server meanwhile. Each channel save re-checks its own
  // revision once more; the gap after that last check can't be closed from
  // here, because Mirth accepts a stale revision.
  const fresh = await client.getServerConfiguration();
  const moved = [...configMapMoved(mapKeys, remote, fresh).map(mapKeyLabel), ...changedSince(plan, remote, fresh)];
  if (moved.length > 0 && !flags.force) {
    fail(`changed on the server while this push was being confirmed:\n  ${moved.join('\n  ')}\npull and try again, or pass --force`);
  }
  // Apply against the fresh snapshot, so whatever is sent for resources
  // outside the plan (the rest of the library list) is the server's latest.
  // The undo has to put the map back too.
  await backupBeforePush(client, live.conn, { ...flags, overwriteConfigMap: mapChanged.length > 0 });
  const afterBackup = await client.getServerConfiguration();
  const changedDuringBackup = [...configMapMoved(mapKeys, fresh, afterBackup).map(mapKeyLabel), ...changedSince(plan, fresh, afterBackup)];
  if (!flags.force && changedDuringBackup.length) {
    fail(`changed on the server during backup: ${changedDuringBackup.join(', ')}; pull and try again`);
  }
  await assertBinding(client, root);
  // Before the resources: a channel saved or redeployed by this push may read the new key.
  if (mapChanged.length > 0) await pushConfigMapKeys(client, local, afterBackup, mapKeys, mapChanged, mapBaseline, live.serverId, flags);
  const result = await applyPlan(client, plan, local, afterBackup, scope, { force: flags.force === true });
  // Record the server's new revisions even after a partial failure, so the
  // resources that did go through don't read as conflicts next time. The
  // baseline is local bookkeeping: failing to refresh it does not stop the
  // redeploy of changes that are saved.
  let baselineError: string | undefined;
  let changedAgain: string[] = [];
  let unverified: string[] = [];
  let after: CanonicalConfig | undefined;
  try {
    after = await client.getServerConfiguration();
  } catch (err) {
    baselineError = `could not read the server configuration back: ${err instanceof Error ? err.message : String(err)}. ${exportBrokenHint(flags)}`;
    ({ changed: changedAgain, unverified } = await changedAgainSingly(client, result.applied, local));
  }
  if (after) {
    try {
      const refreshedLibraries: Change[] = librariesOf(local)
        .filter(l => result.touchedIds.has(String(l['id'])))
        .map(l => ({ kind: 'library', op: 'update', id: String(l['id']), label: String(l['name']) }));
      const membershipSent = result.sentLibraries
        ? { ...local, codeTemplateLibraries: { codeTemplateLibrary: result.sentLibraries } }
        : local;
      const saved = after;
      changedAgain = [...new Set([...result.applied, ...refreshedLibraries]
        .filter(c => !savedChangeMatches(c, c.kind === 'library' ? membershipSent : local, saved))
        .map(c => c.label))];
      if (changedAgain.length === 0) {
        if (result.touchedIds.size > 0) await refreshRevisions(root, after, result.touchedIds);
        if (known) await writeKnown(root, knownAfterPush(known, result.applied, result.touchedIds, after));
      }
    } catch (err) {
      baselineError = err instanceof Error ? err.message : String(err);
    }
  }
  const notRedeployed = toDeploy.length > 0
    ? `\n${toDeploy.length} channel(s) NOT redeployed: ${toDeploy.map(nameOf).join(', ')}; redeploy them from the Administrator once the server is as intended`
    : '';
  const againNote = changedAgain.length > 0 ? `\nchanged again after saving (pull and review before retrying): ${changedAgain.join(', ')}` : '';
  if (result.failed) {
    if (baselineError) process.stderr.write(`warning: could not refresh the local sync baseline: ${scrub(baselineError)}\n`);
    const { change, error } = result.failed;
    fail(`applied ${result.applied.length + mapChanged.length} of ${shown.changes.length}; ${change.op} ${change.label} failed: ${error}${againNote}${notRedeployed}`);
  }
  // Someone else's edit landed on a pushed resource; a redeploy would put it live unreviewed.
  if (changedAgain.length > 0) {
    fail(`applied ${result.applied.length + mapChanged.length} change(s), but these changed again after saving: ${changedAgain.join(', ')}; pull and review before retrying${notRedeployed}${baselineError ? `\n${baselineError}` : ''}`);
  }
  process.stdout.write(`pushed ${result.applied.length + mapChanged.length} change(s)\n`);

  if (toDeploy.length > 0) {
    const { deployed, skipped, failures } = await deployChannels(client, toDeploy, nameOf);
    process.stdout.write(`deployed ${deployed.length} of ${toDeploy.length} channel(s)\n`);
    if (skipped.length) process.stdout.write(`redeploy skipped (no longer deployed): ${skipped.join(', ')}\n`);
    for (const f of failures) process.stderr.write(`deploy failed: ${f.name}: ${scrub(f.error)}\n`);
    if (failures.length > 0) process.exitCode = 1;
  }
  if (baselineError) {
    const note = unverified.length > 0 ? `\nnot checked after saving (these cannot be read one at a time): ${unverified.join(', ')}` : '';
    fail(`pushed ${result.applied.length + mapChanged.length} change(s), but could not refresh the local sync baseline: ${baselineError}${note}`);
  }
  printCommitHint(root);
}

/** After a push the tree's revisions and channelvault.json change; name them, since they belong in the same commit. */
function printCommitHint(root: string): void {
  // -z: plain porcelain quotes paths with spaces (most channel names) and escapes non-ASCII.
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return;
  const entries = r.stdout.split('\0');
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // A rename or copy is followed by its source path.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  if (files.length === 0) return;
  const shown = files.length > 10 ? [...files.slice(0, 10), `and ${files.length - 10} more`] : files;
  process.stdout.write(`commit the refreshed baseline with your change (paths from the repository root): ${shown.join(', ')}\n`);
}

function exportBrokenHint(flags: BackupFlags): string {
  const undo = flags.backup === false
    ? ''
    : ' (including the undo command above, unless you add --export-broken to it, which restores without a preview or an undo backup)';
  return `If the server cannot export its configuration, pull, diff, push and restore${undo} fail until the resource that broke it is fixed in the Administrator; then pull or adopt to refresh the baseline`;
}

/**
 * The redeploy guard when the server export fails: Mirth still serves
 * channels and code templates one at a time. Libraries and global scripts
 * have no such endpoint here, so they are reported as unchecked.
 */
async function changedAgainSingly(
  client: MirthClientExt,
  applied: Change[],
  local: CanonicalConfig,
): Promise<{ changed: string[]; unverified: string[] }> {
  const changed: string[] = [];
  const unverified: string[] = [];
  for (const c of applied) {
    if (c.kind !== 'channel' && c.kind !== 'codeTemplate') {
      unverified.push(c.label);
      continue;
    }
    try {
      const current = (c.kind === 'channel' ? await client.getChannel(c.id) : await client.getCodeTemplate(c.id)) as Record<string, Json> | null;
      const held = current ? [current] : [];
      const server = (c.kind === 'channel'
        ? { channels: { channel: held } }
        : { codeTemplateLibraries: { codeTemplateLibrary: [{ codeTemplates: { codeTemplate: held } }] } }) as CanonicalConfig;
      if (!savedChangeMatches(c, local, server)) changed.push(c.label);
    } catch {
      changed.push(`${c.label} (could not be read)`);
    }
  }
  return { changed, unverified };
}

/** The full replace, gated like a scoped push: it lists and guards deletions and conflicts too. */
async function wholeServerPush(
  client: MirthClientExt,
  root: string,
  local: CanonicalConfig,
  target: string,
  flags: PushFlags,
  live: Live,
): Promise<void> {
  const remote = await client.getServerConfiguration();
  const known = await readKnown(root);
  const plan = planPush(local, remote, {}, known, { wholeReplace: true });
  const problems = [...await bindingProblems(root, live.serverId), ...wholeServerProblems(plan, flags), ...await xmlProblems(root, local)];
  if (flags.planOnly && flags.json) {
    reportPlanOnly(flags, plan, problems, live, { target, mode: 'whole-server' });
    return;
  }
  const s = summarize(local);
  process.stdout.write(
    `Replace the ENTIRE server configuration at ${target} (${s.channels} channels, ${s.codeTemplates} code templates` +
      `${flags.deploy ? ', then redeploy all channels' : ''}).\n`,
  );
  printNameChange(local, remote);
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
  if (flags.planOnly) {
    reportPlanOnly(flags, plan, problems, live, { target, mode: 'whole-server' });
    return;
  }
  if (problems.length > 0) fail(problems.join('\n'));
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
  const freshPlan = planPush(local, fresh, {}, known, { wholeReplace: true });
  if (!flags.allowDeletes && (freshPlan.serverOnly.length > 0 || freshPlan.changes.some(c => c.op === 'delete'))) {
    fail('the replace now deletes resources from the server; review the new plan and pass --allow-deletes');
  }
  await backupBeforePush(client, live.conn, flags);
  const afterBackup = await client.getServerConfiguration();
  if (!sameServerConfig(fresh, afterBackup) && !flags.force) fail('the server changed during backup; pull and try again');
  const finalPlan = planPush(local, afterBackup, {}, known, { wholeReplace: true });
  if (!flags.allowDeletes && (finalPlan.serverOnly.length || finalPlan.changes.some(c => c.op === 'delete'))) {
    fail('the replace now deletes resources from the server; review the new plan and pass --allow-deletes');
  }
  await assertBinding(client, root);
  await client.putServerConfiguration(local, {
    deploy: flags.deploy === true,
    overwriteConfigMap: flags.overwriteConfigMap === true,
  });
  let after: CanonicalConfig;
  try {
    after = await client.getServerConfiguration();
  } catch (err) {
    fail(`replaced the configuration at ${target}${flags.deploy ? ' (Mirth redeploys as part of the replace)' : ''}, but could not read it back: ${err instanceof Error ? err.message : String(err)}. ` +
      `The tree's baseline was not refreshed. ${exportBrokenHint(flags)}`);
  }
  if (planPush(local, after, {}, undefined, { wholeReplace: true }).changes.length > 0) {
    fail('applied the whole-server replacement, but resources changed again after saving; pull and review before retrying');
  }
  const ids = resourceIds(local);
  await refreshRevisions(root, after, new Set([...Object.keys(ids.channels), ...Object.keys(ids.libraries), ...Object.keys(ids.codeTemplates)]));
  if (known) await writeKnown(root, resourceIds(after));
  if (flags.overwriteConfigMap) await recordConfigMapBaseline(live.serverId, configMapBaseline(after));
  process.stdout.write(`pushed ${root} -> ${target}\n`);
  printCommitHint(root);
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
  await writeTree(root, config, `file:${path.resolve(backupPath)}`, flags, await envFileFor(root, flags));
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
    const config = await renderedTree(root, await envFileFor(root, flags));
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
  const conn = await selectConnection(root, flags);
  const envFile = await envFileFor(root, flags, conn);
  // Another worktree's pull may be writing the same profile env file.
  if (!isWithin(path.resolve(envFile), root)) await lockAlso(envFile);
  const previous = await preflightTree(root, envFile); // before fetching a whole server for nothing
  const { config, serverId } = await withClient(conn, async (client, serverId) => {
    if (previous?.serverId && previous.serverId !== serverId) {
      fail(`this tree belongs to installation ${previous.serverId}, but ${urlOf(conn)} is installation ${serverId}; nothing was written. ` +
        "Pull into another directory, or rebind this tree deliberately with 'adopt <dir> --plan-only' and 'adopt <dir>'", 'installation-mismatch');
    }
    const config = await client.getServerConfiguration();
    if (await client.getServerId() !== serverId) fail('the installation changed while pulling; nothing was written');
    return { config, serverId };
  }, { envFile });
  await writeTree(root, config, urlOf(conn), flags, envFile, serverId);
  const s = summarize(config);
  process.stdout.write(`pulled ${s.channels} channels, ${s.codeTemplates} code templates -> ${root}\n`);
});

addJsonFlag(addEnvFlag(addConnectionFlags(
  program.command('adopt')
    .description('Review and capture this installation as the tree baseline, preserving local content; writes no server resources')
    .argument('<dir>', 'working-tree directory')
    .option('--plan-only', 'preview the resulting push plan without changing the tree', false)
    .option('-y, --yes', 'accept the reviewed destination baseline without a prompt', false),
))).action(async (dir: string, flags: ConnectionFlags & EnvFlags & JsonFlags & { planOnly?: boolean; yes?: boolean }) => {
  const root = path.resolve(dir);
  assertTree(root);
  if (flags.json && !flags.planOnly) fail('--json needs --plan-only');
  if (!flags.yes && !flags.planOnly && !process.stdin.isTTY) fail('no terminal to confirm on; review with `adopt --plan-only` and pass --yes');
  // Adopting rebinds the tree, so its current serverId neither selects nor has to match the profile.
  const conn = await selectConnection(undefined, flags, { write: !flags.planOnly, explicit: true });
  const envFile = await envFileFor(root, flags, conn);
  const previous = await preflightTree(root, envFile);
  const stored = await engine.implode({ root });
  const local = await renderedTree(root, envFile);
  await assertCompatibleOrigin(root, local, 'live', false);
  const target = urlOf(conn);
  await withClient(conn, async (client, serverId) => {
    const remote = await client.getServerConfiguration();
    const adopted = adoptTarget(local, remote);
    const plan = planPush(adopted.config, remote, {}, adopted.known);
    if (!flags.json) {
      process.stdout.write(`Adopt ${targetOf(conn)} (installation ${serverId}) as this tree's baseline.\nLocal content is preserved; the following differences become reviewed edits for a subsequent push:\n`);
      printChanges(plan);
      if (plan.serverOnly.length) process.stdout.write(`left alone: ${plan.serverOnly.join(', ')}\n`);
      if (plan.notPushed.length) process.stdout.write(`not pushed by scoped push: ${plan.notPushed.join(', ')}\n`);
    }
    if (flags.planOnly) {
      reportPlanOnly(flags, plan, planProblems(plan, {}), { conn, serverId, envFile }, { target, mode: 'adopt' });
      return;
    }
    if (!flags.yes && !(await confirm('Accept this baseline?'))) {
      process.stdout.write('aborted.\n');
      return;
    }
    if (await client.getServerId() !== serverId || !sameServerConfig(remote, await client.getServerConfiguration())) {
      fail('the target changed while adopting; nothing was written. Review the new baseline and try again');
    }
    if (!sameServerConfig(stored, await engine.implode({ root }))) fail('the local tree changed while adopting; nothing was written');
    await replaceTree(root, envFile, async next => {
      const rebased = adoptTarget(stored, remote);
      await engine.explode(rebased.config, { root: next });
      await writeMeta(next, target, rebased.config, previous, serverId, adopted.known);
    });
    await recordConfigMapBaseline(serverId, configMapBaseline(remote));
    process.stdout.write(`adopted installation ${serverId}; review with push --plan-only before writing the server\n`);
  }, { envFile, quiet: flags.json });
});

addBackupDirFlags(addEnvFlag(addConnectionFlags(
  program
    .command('push')
    .description('Push changed channels, code templates and global scripts to the live server')
    .argument('<dir>', 'working-tree directory')
    .option('--channel <name>', 'only this channel (name or id); repeatable', collect)
    .option('--library <name>', 'only this code template library (name or id); repeatable', collect)
    .option('--global-scripts', 'with --channel/--library: also push global scripts')
    .option('--config-map-key <name>', 'push this configuration-map key (alone: only the named keys); repeatable', collect)
    .option('--allow-deletes', 'delete server resources that are missing from the tree', false)
    .option('--deploy', 'redeploy the changed channels and the channels using changed code templates', false)
    .option('--force', "push even if the server changed since the last pull (overwrites the server's version)", false)
    .option('--ignore-origin', 'push a tree that was exploded from an XML backup (normally refused)', false)
    .option('--whole-server', 'replace the entire server configuration instead (settings, config map, groups too)', false)
    .option('--overwrite-config-map', 'with --whole-server: also overwrite the configuration map', false)
    .option('--no-backup', 'skip the backup of the server taken before anything changes')
    .option('--plan-only', 'show what would be pushed and what would stop it; change nothing (no prompt)', false)
    .option('--json', 'with --plan-only: print the plan as one JSON document', false)
    .option('-y, --yes', 'skip the confirmation prompt', false),
))).action(
  async (
    dir: string,
    flags: PushFlags & EnvFlags & {
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
    if (flags.wholeServer && (flags.channel || flags.library || flags.globalScripts || flags.configMapKey)) {
      fail('--whole-server replaces everything; it cannot be combined with --channel, --library, --global-scripts or --config-map-key');
    }
    if (flags.overwriteConfigMap && !flags.wholeServer) fail('--overwrite-config-map needs --whole-server');
    const root = path.resolve(dir);
    assertTree(root);
    if (flags.json && !flags.planOnly) fail('--json needs --plan-only');
    if (!flags.yes && !flags.planOnly && !process.stdin.isTTY) {
      fail('no terminal to confirm on; review with `push --plan-only` or `diff`, and pass --yes');
    }
    const conn = await selectConnection(root, flags, { write: !flags.planOnly });
    const envFile = await envFileFor(root, flags, conn);
    const config = await renderedTree(root, envFile);
    await assertCompatibleOrigin(root, config, 'live', flags.ignoreOrigin === true);
    const target = targetOf(conn);
    const quiet = flags.json === true;
    if (flags.wholeServer) {
      await withClient(conn, (client, serverId) => wholeServerPush(client, root, config, target, flags, { conn, serverId, envFile }), { envFile, quiet });
      return;
    }
    const keysOnly = flags.configMapKey !== undefined && !flags.channel && !flags.library && !flags.globalScripts;
    const scope: Scope = keysOnly
      ? { channels: [], libraries: [] }
      : { channels: flags.channel, libraries: flags.library, globalScripts: flags.globalScripts };
    await withClient(conn, (client, serverId) => scopedPush(client, root, config, scope, target, flags, { conn, serverId, envFile }), { envFile, quiet });
  },
);

addBackupDirFlags(addConnectionFlags(
  program
    .command('backup')
    .description('Save the server configuration as <server>-<UTC time>.xml in ~/.channelvault/backups (holds credentials in plain text)')
    .option('--out <file>', 'write to this file instead (no rotation)'),
)).action(async (flags: ConnectionFlags & BackupFlags & { out?: string }) => {
  const conn = await selectConnection(undefined, flags);
  const target = targetOf(conn);
  const file = await withClient(conn, async (client) => {
    const text = await client.getServerConfigurationXml();
    if (!flags.out) return saveServerBackup(client, text, conn, flags);
    const out = path.resolve(flags.out);
    parseBackup(text, 'the server configuration');
    if (existsSync(out)) fail(`${out} already exists; choose another name`);
    await mkdir(path.dirname(out), { recursive: true });
    await writePrivate(out, text);
    if (gitWouldCommit(out)) {
      process.stderr.write(`warning: git does not ignore ${out}, which holds credentials in plain text; add it to .gitignore\n`);
    }
    return out;
  });
  process.stdout.write(`backed up ${target} to ${file}\n`);
});

interface RestoreFlags extends ConnectionFlags, BackupFlags {
  deploy?: boolean;
  overwriteConfigMap?: boolean;
  yes?: boolean;
  force?: boolean;
  exportBroken?: boolean;
}

/** The backup named, else the newest taken from this server (by server ID: the name in the file name travels with the configuration). */
async function chooseBackup(dir: string, file: string | undefined, serverId: string, target: string): Promise<string> {
  if (file) {
    const chosen = path.resolve(file);
    if (!existsSync(chosen)) fail(`${chosen} does not exist`);
    return chosen;
  }
  const mine = await backupsOf(dir, serverId);
  if (mine.length === 0) {
    const others = (await originsIn(dir)).map((o) => o.host);
    const legacy = path.resolve(LEGACY_BACKUP_DIR);
    const inLegacy = legacy !== dir && (await backupsOf(legacy, serverId)).length > 0;
    fail(`no backups of ${target} in ${dir}${others.length ? ` (it has backups of: ${others.join(', ')})` : ''}` +
      (inLegacy ? `; ${legacy} has backups of this server (the default before 0.3.0-rc.3): pass --backup-dir ${shellArgument(legacy)}` : ''));
  }
  return mine[mine.length - 1]!.file;
}

/**
 * Restore without reading the current configuration, for a server whose
 * export fails (HTTP 500 after a resource holding a character XML forbids was
 * saved, seen on 4.5.0): no preview, no undo backup, no name or version check.
 */
async function restoreWithBrokenExport(client: MirthClientExt, serverId: string, file: string | undefined, flags: RestoreFlags, target: string): Promise<void> {
  try {
    await client.getServerConfigurationXml();
    fail('the server can export its configuration; run restore without --export-broken, which shows a preview and saves an undo backup first');
  } catch (err) {
    if (err instanceof CliError) throw err;
    // A proxy timeout or a dropped connection on a healthy server must not unlock a restore without preview or undo.
    if ((err as Partial<ApiError>).status !== 500) {
      fail(`cannot tell whether the export is broken: ${err instanceof Error ? err.message : String(err)}; --export-broken only proceeds when the server answers its export with HTTP 500`);
    }
  }
  const dir = backupDirOf(flags);
  const chosen = await chooseBackup(dir, file, serverId, target);
  const text = await readFile(chosen, 'utf8');
  const backup = parseBackup(text, chosen);
  const unsafe = await xmlSafetyProblem(backup);
  if (unsafe) fail(`${chosen} holds ${unsafe}`);
  const origin = await originOf(dir, chosen);
  if (!origin && !flags.force) {
    fail(`${chosen} is not in ${path.join(dir, MANIFEST)}, and without the server's export its name cannot be compared either; pass --force to restore it anyway`);
  }
  if (origin && origin.serverId !== serverId && !flags.force) {
    fail(`${chosen} was taken from ${origin.host} (server ID ${origin.serverId}), not this server (${serverId}); pass --force to restore it here anyway`);
  }
  process.stdout.write(
    `Restore ${chosen}\nto ${target} (installation ${serverId}), replacing its ENTIRE configuration${flags.deploy ? ', then redeploy all channels' : ''}.\n` +
      'The server cannot export its configuration, so there is no preview, no undo backup and no version check.\n',
  );
  if (!flags.yes && (await ask(`Type the installation ID (${serverId}) to continue: `)) !== serverId) {
    process.stdout.write('aborted.\n');
    return;
  }
  await client.putServerConfigurationXml(text, { deploy: flags.deploy === true, overwriteConfigMap: flags.overwriteConfigMap === true });
  let afterText: string;
  try {
    afterText = await client.getServerConfigurationXml();
  } catch (err) {
    fail(`sent ${chosen} to ${target}, but the server still cannot export its configuration: ${err instanceof Error ? err.message : String(err)}; inspect it in the Administrator`);
  }
  const differ = planPush(backup, parseBackup(afterText, 'the server configuration'), {}, undefined, { wholeReplace: true }).changes;
  if (differ.length > 0) {
    fail(`restored, but these differ from the backup afterwards: ${differ.map((c) => c.label).join(', ')}; inspect the server`);
  }
  process.stdout.write(`restored ${chosen} to ${target}; the server exports its configuration again\n`);
}

addBackupDirFlags(addConnectionFlags(
  program
    .command('restore')
    .description('Replace the entire server configuration with a backup (default: the newest backup of this server)')
    .argument('[file]', 'backup XML to restore')
    .option('--deploy', 'redeploy all channels afterwards', false)
    .option('--overwrite-config-map', 'also replace the configuration map', false)
    .option('--force', 'restore a backup taken from another server', false)
    .option('--export-broken', 'the server cannot export its configuration (HTTP 500): restore without a preview, undo backup or version check', false)
    .option('-y, --yes', 'skip the confirmation prompt', false),
)).action(async (file: string | undefined, flags: RestoreFlags) => {
  if (!flags.yes && !process.stdin.isTTY) fail('no terminal to confirm on; pass --yes');
  const conn = await selectConnection(undefined, flags, { write: true });
  const target = targetOf(conn);
  const dir = backupDirOf(flags);
  await withClient(conn, async (client, serverId) => {
    if (flags.exportBroken) {
      await restoreWithBrokenExport(client, serverId, file, flags, target);
      return;
    }
    let currentText: string;
    try {
      currentText = await client.getServerConfigurationXml();
    } catch (err) {
      fail(`cannot read the server's current configuration: ${err instanceof Error ? err.message : String(err)}. ` +
        'If its export is broken (for example HTTP 500), restore with --export-broken, which skips the preview and the undo backup');
    }
    const current = parseBackup(currentText, 'the server configuration');
    const chosen = await chooseBackup(dir, file, serverId, target);
    const text = await readFile(chosen, 'utf8');
    const backup = parseBackup(text, chosen);
    const unsafe = await xmlSafetyProblem(backup);
    if (unsafe) fail(`${chosen} holds ${unsafe}`);

    // A backup of another server would replace this one's configuration with it.
    const origin = await originOf(dir, chosen);
    if (origin) {
      if (origin.serverId !== serverId && !flags.force) {
        fail(`${chosen} was taken from ${origin.host} (server ID ${origin.serverId}), not this server (${serverId}); pass --force to restore it here anyway`);
      }
    } else {
      // Not one of this directory's backups: only the names can be compared.
      const [fromContent, fromServer] = [configuredName(backup), configuredName(current)];
      if (fromContent !== '' && fromServer !== '' && fromContent !== fromServer && !flags.force) {
        fail(`${chosen} is a backup of ${fromContent}, not ${fromServer}; pass --force to restore it here anyway`);
      }
      process.stderr.write(`warning: ${chosen} is not in ${path.join(dir, MANIFEST)}, so which server it came from cannot be checked\n`);
    }

    // Older servers cannot read a newer configuration; Mirth converts older ones.
    const [bv, sv] = [backup['@_version'], current['@_version']];
    if (typeof bv === 'string' && typeof sv === 'string' && numericVersion(bv) && numericVersion(sv)) {
      if (compareVersions(bv, sv) > 0) fail(`${chosen} is from Mirth ${bv}, newer than this server (${sv}); it cannot be restored here`);
      if (compareVersions(bv, sv) < 0) process.stderr.write(`note: ${chosen} is from Mirth ${bv}; the server (${sv}) will convert it\n`);
    } else {
      process.stderr.write(`warning: cannot compare the backup's Mirth version (${String(bv ?? 'none')}) with the server's (${String(sv ?? 'none')})\n`);
    }

    const plan = planPush(backup, current, {}, undefined, { wholeReplace: true });
    process.stdout.write(`Restore ${chosen}\nto ${target}, replacing its ENTIRE configuration${flags.deploy ? ', then redeploy all channels' : ''}.\n`);
    printNameChange(backup, current);
    if (plan.changes.length > 0) {
      process.stdout.write('Channel, library and template changes:\n');
      printChanges(plan);
    }
    const keptMap = plan.notPushed.includes('configurationMap') && !flags.overwriteConfigMap;
    const replaced = plan.notPushed.filter((k) => !(keptMap && k === 'configurationMap'));
    if (replaced.length > 0) process.stdout.write(`also replaced: ${replaced.join(', ')}\n`);
    if (keptMap) process.stdout.write('configuration map differs but is kept (--overwrite-config-map replaces it)\n');
    if (!flags.yes && !(await confirm('Continue?'))) {
      process.stdout.write('aborted.\n');
      return;
    }

    // What the preview showed must still be what gets replaced; --force does
    // not cover this (it is about which server the backup is from).
    const freshText = await client.getServerConfigurationXml();
    if (!sameServerConfig(parseBackup(freshText, 'the server configuration'), current)) {
      fail('the server changed while this restore was being confirmed; nothing was restored. Run it again to review the new state');
    }
    // The undo: the configuration about to be replaced. The backup being
    // restored is protected from rotation.
    const undo = await saveServerBackup(client, freshText, conn, flags, chosen);
    process.stdout.write(`saved the current configuration to ${undo} (undo with: ${undoCommand(undo, conn, flags)})\n`);
    printUndoLimits(conn, flags);

    const afterBackup = parseBackup(await client.getServerConfigurationXml(), 'the server configuration');
    if (!sameServerConfig(parseBackup(freshText, 'the server configuration'), afterBackup)) {
      fail('the server changed during the undo backup; nothing was restored. Run it again to review the new state');
    }

    await client.putServerConfigurationXml(text, { deploy: flags.deploy === true, overwriteConfigMap: flags.overwriteConfigMap === true });
    const after = parseBackup(await client.getServerConfigurationXml(), 'the server configuration');
    const differ = planPush(backup, after, {}, undefined, { wholeReplace: true }).changes;
    if (differ.length > 0) {
      fail(`restored, but these differ from the backup afterwards: ${differ.map((c) => c.label).join(', ')}; inspect the server`);
    }
    process.stdout.write(`restored ${chosen} to ${target}\n`);
  });
});

addJsonFlag(addEnvFlag(addConnectionFlags(
  program
    .command('diff')
    .description('Diff a working tree against the live server configuration (exit 0 = same, 1 = differences, 2 = error)')
    .argument('<dir>', 'working-tree directory')
    // Usage errors must not read as "differences found" either.
    .exitOverride((err) => {
      process.exitCode = err.exitCode === 0 ? 0 : 2;
      throw err;
    }),
))).action(async (dir: string, flags: ConnectionFlags & EnvFlags & JsonFlags) => {
  errorExitCode = 2;
  const root = path.resolve(dir);
  assertTree(root);

  const conn = await selectConnection(root, flags);
  const envFile = await envFileFor(root, flags, conn);
  const treeServerId = (await readMeta(root))?.serverId;
  const { fetched, serverId } = await withClient(conn, async (client, serverId) => {
    // Against another installation every resource would read as a difference.
    if (treeServerId && treeServerId !== serverId) {
      fail(`this tree belongs to installation ${treeServerId}, but ${urlOf(conn)} is installation ${serverId}; choose the server this tree was pulled from`, 'installation-mismatch');
    }
    return { fetched: await client.getServerConfiguration(), serverId };
  }, { envFile, quiet: flags.json });
  const tree = await engine.implode({ root });
  const env = await loadEnv(envFile);
  const unsetTreeOnly = assertEnvComplete(tree, fetched, env, envFile, conn);
  // Compare like with like: the server's credentials become the placeholders
  // the tree holds. Values that differ from the env file are named, never shown.
  const { config: templatedRemote, envUpdates, notes } = templatize(fetched, tree, env);
  const messages: string[] = [
    ...Object.keys(envUpdates).map((name) => `${name} differs between the server and the env file`),
    ...notes,
    ...(unsetTreeOnly.length > 0 ? [`no value yet for ${unsetTreeOnly.join(', ')}, used only by resources the server doesn't have`] : []),
    ...await xmlProblems(root, tree),
  ];
  // Redact both sides the same way, so neither can print a secret and a raw
  // secret held on both sides doesn't read as a difference.
  const allow = await readAllow(root);
  // Line endings are normalised too: push ignores them because Mirth rewrites them on save.
  // So are revisions and timestamps, which Mirth bumps on any save or restore:
  // compare content, and report newer revisions separately.
  const staleRevisions = newerOnServer(tree, templatedRemote);
  if (staleRevisions.length > 0) {
    messages.push(`${staleRevisions.length} resource(s) have a newer revision on the server; pull to update the tree's baseline, or adopt it when the content already matches`);
  }
  const treeView = scanSecrets(redactKnownSecrets(normalizeEolDeep(withSortedConfigMap(withoutVolatile(tree)))), { mode: 'redact', allow });
  const serverView = scanSecrets(redactKnownSecrets(normalizeEolDeep(withSortedConfigMap(withoutVolatile(templatedRemote)))), { mode: 'redact', allow });
  if (treeView.findings.length > 0) {
    messages.push(`the tree holds ${treeView.findings.length} unextracted secret(s), redacted below; pull --extract-secrets`);
  }
  if (serverView.findings.length > 0) messages.push(`${serverView.findings.length} possible secret(s) on the server are redacted below`);
  if (!flags.json) for (const m of messages) process.stderr.write(`note: ${m}\n`);

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
    const clean = out === '' && secretDrift.length === 0;
    if (!clean) process.exitCode = 1;
    if (flags.json) {
      const files = await changedFiles(path.join(tmp, 'tree'), path.join(tmp, 'server'));
      writeJson({ clean, serverId, connection: connectionJson(conn, serverId, envFile), files, secretDrift, staleRevisions, notes: messages, patch: out });
    } else if (clean) {
      process.stdout.write('no differences — working tree matches the server.\n');
    } else {
      if (out !== '') process.stdout.write(out + '\n');
      if (secretDrift.length > 0) {
        process.stdout.write(`secret values differ between the server and the env file: ${secretDrift.join(', ')}\n`);
      }
    }
  } finally {
    await rm(tmp, RM_OPTS);
  }
});

/**
 * Files that differ between two exploded trees, by path relative to the
 * working tree. Both sides were normalised to LF before exploding, so a byte
 * comparison agrees with the patch.
 */
async function changedFiles(treeDir: string, serverDir: string): Promise<Array<{ path: string; change: 'modified' | 'only-in-tree' | 'only-on-server' }>> {
  const [local, remote] = await Promise.all([treeFiles(treeDir), treeFiles(serverDir)]);
  const remoteSet = new Set(remote);
  const files: Array<{ path: string; change: 'modified' | 'only-in-tree' | 'only-on-server' }> = [];
  for (const p of local) {
    if (!remoteSet.has(p)) files.push({ path: p, change: 'only-in-tree' });
    else if ((await readFile(path.join(treeDir, p), 'utf8')) !== (await readFile(path.join(serverDir, p), 'utf8'))) files.push({ path: p, change: 'modified' });
  }
  const localSet = new Set(local);
  for (const p of remote) if (!localSet.has(p)) files.push({ path: p, change: 'only-on-server' });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

addJsonFlag(addEnvFlag(
  program
    .command('status')
    .description('Summarize a working tree, and say which connection profile live commands would use')
    .argument('<dir>', 'working-tree directory'),
)).action(async (dir: string, flags: JsonFlags & EnvFlags) => {
  const root = path.resolve(dir);
  assertTree(root);
  const config = await engine.implode({ root });
  const s = summarize(config);
  const meta = await readMeta(root);
  const connection = await offlineConnection(meta?.serverId);
  if (flags.json) {
    writeJson({
      root, source: meta?.source ?? null, pulledAt: meta?.pulledAt ?? null, engineVersion: meta?.engineVersion ?? null,
      serverId: meta?.serverId ?? null, connection, counts: s,
      xmlForbiddenChars: forbiddenXmlChars(config),
    });
    return;
  }
  for (const p of await xmlProblems(root, config)) process.stderr.write(`warning: ${p}\n`);
  if (meta) {
    process.stdout.write(`source:  ${meta.source}\n`);
    process.stdout.write(`pulled:  ${meta.pulledAt}\n`);
    process.stdout.write(`engine:  ${meta.engineVersion ?? 'unknown'}\n`);
    if (meta.serverId) process.stdout.write(`server:  installation ${meta.serverId}\n`);
  }
  process.stdout.write(`connect: ${'problem' in connection
    ? connection.problem
    : `${connection.profile ? `profile ${connection.profile}` : 'no profile'}, ${connection.url} as ${connection.user}, chosen by ${connection.source}` +
      `${connection.passwordConfigured ? '' : ' (no password configured)'}`}\n`);
  process.stdout.write(
    `channels:               ${s.channels}\n` +
      `channel groups:         ${s.channelGroups}\n` +
      `code template libs:     ${s.codeTemplateLibraries}\n` +
      `code templates:         ${s.codeTemplates}\n`,
  );
});

/** Which connection a read of this tree would use, without connecting or needing its password. */
async function offlineConnection(treeServerId: string | undefined): Promise<
  { profile: string | null; url: string; user: string; source: string; passwordConfigured: boolean } | { problem: string }
> {
  try {
    const profiles = await loadProfiles();
    const credentials = await readCredentials();
    const conn = resolveConnection({
      flags: {},
      env: process.env,
      profiles,
      // Resolve as if every password were set, then report the real state.
      credentials: Object.fromEntries(Object.keys(profiles).map(n => [n, ''])),
      ...(treeServerId ? { treeServerId } : {}),
    });
    const passwordConfigured = conn.profile ? Object.prototype.hasOwnProperty.call(credentials, conn.profile) : true;
    return { profile: conn.profile ?? null, url: urlOf(conn), user: conn.user, source: conn.source, passwordConfigured };
  } catch (err) {
    if (!(err instanceof ReasonError)) throw err;
    return { problem: `${err.reason ? `[${err.reason}] ` : ''}${err.message}` };
  }
}

// --- profiles -----------------------------------------------------------------

function needTerminal(what: string): void {
  if (!process.stdin.isTTY) fail(`${what} asks at a terminal; run it yourself in a terminal (agents cannot)`, 'no-terminal');
}

async function askPassword(prompt: string): Promise<string> {
  const password = await ask(prompt, { secret: true });
  if (password.length < 8) fail('a profile password needs at least 8 characters; nothing was saved', 'weak-password');
  return password;
}

function connectionOfProfile(name: string, profile: Profile, password: string): Connection {
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password,
    https: profile.https !== false,
    insecure: profile.insecure === true,
    ...(profile.tlsFingerprint ? { tlsFingerprint: profile.tlsFingerprint } : {}),
    source: 'profile-flag',
    passwordSource: 'credentials',
    profile: name,
    ...(profile.serverId ? { serverId: profile.serverId } : {}),
  };
}

/** Log in as the profile and return the installation that answered. */
async function loginCheck(conn: Connection): Promise<string> {
  rememberSecret(conn.password, { stdout: true });
  activeConnection = conn;
  return withClient(conn, async (_client, serverId) => serverId, { quiet: true });
}

function existingProfile(profiles: Profiles, name: string): Profile {
  const profile = profiles[name];
  if (!profile) fail(`no profile named ${name} (${Object.keys(profiles).join(', ') || 'none saved'})`, 'profile-unknown');
  return profile;
}

const profileCommand = program.command('profile').description(`Manage connection profiles (${path.join('~', '.channelvault', 'profiles.json')}; passwords in its credentials file)`);

addJsonFlag(profileCommand.command('list').description('List the saved profiles (never their passwords)')).action(async (flags: JsonFlags) => {
  const profiles = await loadProfiles();
  const credentials = await readCredentials();
  const rows = Object.entries(profiles).map(([name, p]) => ({
    name,
    url: urlOf({ https: p.https !== false, host: p.host, port: p.port }),
    user: p.user,
    serverId: p.serverId ?? null,
    tlsFingerprint: p.tlsFingerprint ?? null,
    insecure: p.insecure === true,
    dotenv: p.dotenv ?? null,
    passwordConfigured: Object.prototype.hasOwnProperty.call(credentials, name),
  }));
  if (flags.json) {
    writeJson({ profilesFile: profilesFile(), profiles: rows });
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`no profiles in ${profilesFile()}; add one at a terminal with: channelvault profile add <name> --host <host> --port <port> --user <user>\n`);
    return;
  }
  for (const r of rows) {
    const tls = r.tlsFingerprint ? `pinned ${formatFingerprint(r.tlsFingerprint).slice(0, 11)}…` : r.insecure ? 'certificate not checked' : r.url.startsWith('https') ? 'CA-verified' : 'plain http';
    process.stdout.write(`${r.name}  ${r.url} as ${r.user}  installation ${r.serverId ?? '(not recorded)'}  ${tls}` +
      `${r.dotenv ? `  env file ${r.dotenv}` : ''}${r.passwordConfigured ? '' : '  (no password: run profile set-password)'}\n`);
  }
});

profileCommand.command('add')
  .description('Add a profile at a terminal: confirm the server and its certificate, enter the password, record its installation')
  .argument('<name>', 'profile name (letters, digits, ".", "_", "-")')
  .requiredOption('--host <host>', 'Mirth server host')
  .requiredOption('--port <port>', 'Mirth server port')
  .requiredOption('--user <user>', 'username')
  .option('--dotenv <path>', "env file for this server's trees, used when a tree has no .env of its own")
  .option('--tls-fingerprint <sha256>', "the certificate's SHA-256 fingerprint, when you have it from the administrator")
  .option('--insecure', 'turn certificate verification off (loopback hosts only)', false)
  .option('--no-https', 'use http (loopback hosts only)')
  .action(async (name: string, flags: { host: string; port: string; user: string; dotenv?: string; tlsFingerprint?: string; insecure?: boolean; https?: boolean }) => {
    needTerminal('profile add');
    if (!PROFILE_NAME.test(name)) fail(`profile names are letters, digits, '.', '_' and '-', starting with a letter or digit: ${name}`, 'profile-invalid');
    const profiles = await loadProfiles();
    if (profiles[name]) fail(`profile ${name} already exists; change its password with \`channelvault profile set-password ${name}\`, or edit ${profilesFile()}`, 'profile-exists');
    const port = Number(flags.port);
    const profile: Profile = { host: flags.host, port, user: flags.user };
    if (flags.https === false) profile.https = false;
    if (flags.insecure) profile.insecure = true;
    if (flags.dotenv) profile.dotenv = path.resolve(flags.dotenv);
    if (flags.tlsFingerprint !== undefined) {
      const pin = normalizeFingerprint(flags.tlsFingerprint);
      if (!pin) fail('--tls-fingerprint must be a SHA-256 certificate fingerprint: 64 hex digits, colons allowed', 'bad-fingerprint');
      profile.tlsFingerprint = pin;
    }
    const problems = profileProblems({ ...profiles, [name]: profile });
    if (problems.length > 0) fail(problems.join('\n'), 'profile-invalid');
    const conn = connectionOfProfile(name, profile, '');
    process.stdout.write(`Add profile ${name}: ${urlOf(conn)} as ${profile.user}\n`);
    if (conn.https && !conn.insecure) {
      const presented = await presentedFingerprint(profile.host, port);
      if (profile.tlsFingerprint && presented !== profile.tlsFingerprint) {
        fail(`the server presents certificate SHA-256 ${formatFingerprint(presented)}, not the --tls-fingerprint given; nothing was saved`, 'tls-pin-mismatch');
      }
      profile.tlsFingerprint = presented;
      process.stdout.write(`certificate SHA-256 ${formatFingerprint(presented)}\n` +
        'channelvault will accept only this certificate from this server. Compare it with the one the server administrator gave you.\n');
    }
    if (!(await confirm('Is this the right server?'))) {
      process.stdout.write('aborted.\n');
      return;
    }
    const password = await askPassword(`Password for ${profile.user}: `);
    profile.serverId = await loginCheck(connectionOfProfile(name, profile, password));
    // Another process may have saved profiles while this one was waiting at the prompts.
    const latest = await loadProfiles();
    if (latest[name]) fail(`profile ${name} was added meanwhile; nothing was saved`, 'profile-exists');
    await saveProfiles({ ...latest, [name]: profile });
    await setCredential(name, password);
    process.stdout.write(`added profile ${name} (installation ${profile.serverId}); password stored in ${credentialsFile()}\n`);
  });

profileCommand.command('set-password')
  .description("Change a profile's stored password at a terminal; it is checked by logging in first")
  .argument('<name>', 'profile name')
  .action(async (name: string) => {
    needTerminal('profile set-password');
    const profile = existingProfile(await loadProfiles(), name);
    process.stdout.write(`Profile ${name}: ${urlOf(connectionOfProfile(name, profile, ''))} as ${profile.user}\n`);
    const password = await askPassword(`New password for ${profile.user}: `);
    await loginCheck(connectionOfProfile(name, profile, password));
    await setCredential(name, password);
    process.stdout.write(`stored the password for profile ${name}\n`);
  });

addJsonFlag(profileCommand.command('check')
  .description('Log in with each profile (or the one named) and verify its certificate and installation')
  .argument('[name]', 'profile name')).action(async (name: string | undefined, flags: JsonFlags) => {
  const profiles = await loadProfiles();
  const credentials = await readCredentials();
  if (name) existingProfile(profiles, name);
  const names = name ? [name] : Object.keys(profiles);
  if (names.length === 0) fail(`no profiles in ${profilesFile()}`, 'no-connection');
  const results: Array<{ name: string; ok: boolean; serverId: string | null; problem: string | null }> = [];
  for (const n of names) {
    const password = credentials[n];
    if (password === undefined) {
      results.push({ name: n, ok: false, serverId: null, problem: `[no-password] run \`channelvault profile set-password ${n}\` at a terminal` });
      continue;
    }
    try {
      results.push({ name: n, ok: true, serverId: await loginCheck(connectionOfProfile(n, profiles[n]!, password)), problem: null });
    } catch (err) {
      results.push({ name: n, ok: false, serverId: null, problem: scrub(describeError(err)) });
    }
  }
  if (results.some(r => !r.ok)) process.exitCode = 1;
  if (flags.json) {
    writeJson({ profiles: results });
    return;
  }
  for (const r of results) process.stdout.write(r.ok ? `${r.name}: ok, installation ${r.serverId}\n` : `${r.name}: FAILED ${r.problem}\n`);
});

profileCommand.command('repin')
  .description("Pin a profile's server certificate again after it was replaced, at a terminal")
  .argument('<name>', 'profile name')
  .action(async (name: string) => {
    needTerminal('profile repin');
    const profiles = await loadProfiles();
    const profile = existingProfile(profiles, name);
    if (profile.https === false || profile.insecure) fail(`profile ${name} does not check certificates, so there is nothing to pin`, 'profile-invalid');
    const password = (await readCredentials())[name];
    if (password === undefined) fail(`profile ${name} has no password yet; run \`channelvault profile set-password ${name}\` first`, 'no-password');
    const presented = await presentedFingerprint(profile.host, profile.port);
    if (presented === profile.tlsFingerprint) {
      process.stdout.write(`profile ${name} already pins the certificate ${profile.host}:${profile.port} presents\n`);
      return;
    }
    process.stdout.write(`Profile ${name}: ${profile.host}:${profile.port}\n` +
      `pinned:    ${profile.tlsFingerprint ? formatFingerprint(profile.tlsFingerprint) : '(none)'}\n` +
      `presented: ${formatFingerprint(presented)}\n` +
      'Accept the new certificate only if the administrator replaced it and gave you this fingerprint; otherwise someone may be impersonating the server.\n');
    if (!(await confirm('Pin the presented certificate?'))) {
      process.stdout.write('aborted.\n');
      return;
    }
    const repinned = { ...profile, tlsFingerprint: presented };
    await loginCheck(connectionOfProfile(name, repinned, password));
    const latest = await loadProfiles();
    await saveProfiles({ ...latest, [name]: { ...existingProfile(latest, name), tlsFingerprint: presented } });
    process.stdout.write(`profile ${name} now pins ${formatFingerprint(presented)}\n`);
  });

// --- locks, recovery, errors -------------------------------------------------------

const unlocks: Array<() => Promise<void>> = [];
const locked: string[] = [];

/** Lock an env file outside the tree, the same way the tree is locked; once per file, since recovery may already hold it. */
async function lockAlso(file: string): Promise<void> {
  const key = await canonical(file);
  if (locked.some(l => samePath(l, key))) return;
  unlocks.push(await lockTree(path.resolve(file)));
  locked.push(key);
}

program.hook('preAction', async (_program, command) => {
  const name = command.name();
  if (!['explode', 'pull', 'adopt', 'push', 'implode', 'diff', 'status'].includes(name) || command.parent !== program) return;
  if (name === 'diff') errorExitCode = 2;
  const root = path.resolve(String(command.processedArgs[name === 'explode' ? 1 : 0]));
  unlocks.push(await lockTree(root));
  // Recovery runs before the connection is chosen, so it accepts any env file this tree could have used.
  const pending = await pendingEnvFile(root);
  if (pending === null) return;
  if (!isWithin(pending, await resolvedPath(root))) await lockAlso(pending);
  await recoverTree(root, await recoveryCandidates(root, command.opts<EnvFlags>()));
});

/** The message with its reason code, as printed after `error:`. */
function describeError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const reason = err instanceof ReasonError ? err.reason : code === 'TLS_PIN_MISMATCH' ? 'tls-pin-mismatch' : undefined;
  return `${reason ? `[${reason}] ` : ''}${err instanceof Error ? err.message : String(err)}`;
}

/** What to do about a certificate the client refused. */
async function certificateHint(code: string): Promise<string | undefined> {
  const conn = activeConnection;
  if (code === 'TLS_PIN_MISMATCH') {
    return conn?.profile
      ? `if the administrator replaced the certificate, check its new fingerprint with them and run \`channelvault profile repin ${conn.profile}\` at a terminal`
      : 'if the administrator replaced the certificate, check its new fingerprint with them and update --tls-fingerprint (or MIRTH_TLS_FINGERPRINT)';
  }
  if (!UNTRUSTED_CERT_CODES.has(code)) return undefined;
  const presented = conn ? await presentedFingerprint(conn.host, conn.port, 5_000).catch(() => undefined) : undefined;
  const pin = presented ? ` It presents SHA-256 ${formatFingerprint(presented)}.` : '';
  const loopback = conn ? isLoopback(conn.host) : false;
  return `the server's TLS certificate is not trusted (Mirth's default certificate is self-signed).${pin} ` +
    'Confirm that fingerprint with the server administrator, then save a profile at a terminal with ' +
    '`channelvault profile add <name> --host <host> --port <port> --user <user>`, which pins it' +
    `${presented ? `, or pass --tls-fingerprint ${presented} (or set MIRTH_TLS_FINGERPRINT)` : ', or pass --tls-fingerprint'}` +
    `${loopback ? '. For this loopback test server, --insecure turns verification off' : ''}.`;
}

program.parseAsync().catch(async (err: unknown) => {
  // Commander has already printed it and set the exit code.
  if (err instanceof CommanderError) return;
  process.stderr.write(`error: ${scrub(describeError(err))}\n`);
  const code = (err as { code?: unknown } | null)?.code;
  const hint = typeof code === 'string' ? await certificateHint(code) : undefined;
  if (hint) process.stderr.write(`hint: ${hint}\n`);
  if (!(err instanceof ReasonError) && err instanceof Error && process.env.CHANNELVAULT_DEBUG) {
    process.stderr.write(`${scrub(err.stack ?? '')}\n`);
  }
  process.exitCode = errorExitCode;
}).finally(async () => {
  for (const unlock of unlocks.reverse()) {
    try { await unlock(); }
    catch (err) {
      process.stderr.write(`error: could not release a lock: ${scrub(err instanceof Error ? err.message : String(err))}\n`);
      process.exitCode = errorExitCode;
    }
  }
});
