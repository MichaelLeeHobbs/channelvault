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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import { createExplodeEngine } from './explode/index.js';
import { XmlConfigAdapter } from './xml/index.js';
import { createMirthClient, type MirthClientExt } from './client/index.js';
import { channelsOf, planPush, type Scope } from './push/index.js';
import { applyPlan, deployChannels, refreshRevisions } from './push/apply.js';
import { render, templatize } from './secrets/index.js';
import { ensureEnvIgnored, readEnvFile, updateEnvFile } from './secrets/envfile.js';
import type { CanonicalConfig, ClientConfig, Json } from './types.js';

const engine = createExplodeEngine();
const xml = new XmlConfigAdapter();

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

/** Directories under a working tree that `explode` owns (cleared before a pull). */
const MANAGED_DIRS = ['server', 'channels', 'codeTemplates', 'channelGroups'];

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
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
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
}

async function writeMeta(root: string, source: string, config: CanonicalConfig): Promise<void> {
  const meta: SyncMeta = {
    tool: 'channelvault',
    version: '0.1.0',
    source,
    pulledAt: new Date().toISOString(),
    // XML adapter yields `@_version`; the live JSON API yields `@version` (Jackson).
    engineVersion:
      typeof config['@_version'] === 'string'
        ? (config['@_version'] as string)
        : typeof config['@version'] === 'string'
          ? (config['@version'] as string)
          : null,
  };
  await writeFile(path.join(root, 'channelvault.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

// --- secrets / env ----------------------------------------------------------

interface EnvFlags {
  envFile?: string;
}

function envFilePath(root: string, flags: EnvFlags): string {
  return flags.envFile ? path.resolve(flags.envFile) : path.join(root, '.env');
}

/** The env file overlaid with the process environment (which wins, as in CI). */
async function loadEnv(file: string): Promise<Record<string, string | undefined>> {
  return { ...(await readEnvFile(file)), ...process.env };
}

function addEnvFlag(cmd: Command): Command {
  return cmd.option('--env-file <path>', 'env file holding secrets and per-environment values (default <dir>/.env)');
}

/** The tree as stored, placeholders unresolved; null if there is no tree yet. */
async function existingTree(root: string): Promise<CanonicalConfig | null> {
  return existsSync(path.join(root, 'server', 'configuration.json')) ? engine.implode({ root }) : null;
}

/** The tree with placeholders filled from the env file; fails listing any missing names. */
async function renderedTree(root: string, flags: EnvFlags): Promise<CanonicalConfig> {
  return render(await engine.implode({ root }), await loadEnv(envFilePath(root, flags)));
}

/**
 * Write a fetched config into the tree with credentials swapped for
 * placeholders; their values go to the env file, never to the tree.
 */
async function writeTree(root: string, fetched: CanonicalConfig, source: string, flags: EnvFlags): Promise<void> {
  const envFile = envFilePath(root, flags);
  const { config, envUpdates, notes } = templatize(fetched, await existingTree(root), await loadEnv(envFile));
  await clearManaged(root);
  await engine.explode(config, { root });
  await writeMeta(root, source, config);
  await updateEnvFile(envFile, envUpdates);
  const rel = path.relative(root, envFile);
  if (existsSync(envFile) && !rel.startsWith('..') && !path.isAbsolute(rel)) await ensureEnvIgnored(root);
  const updated = Object.keys(envUpdates).length;
  if (updated > 0) process.stdout.write(`stored ${updated} secret value(s) in ${envFile}\n`);
  for (const note of notes) process.stderr.write(`note: ${note}\n`);
}

async function clearManaged(root: string): Promise<void> {
  await Promise.all(MANAGED_DIRS.map((d) => rm(path.join(root, d), RM_OPTS)));
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
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as SyncMeta;
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
        `so pushing would upload a config the Mirth API cannot parse. Seed the tree with 'pull' instead, or pass --force to override.`
      : `this working tree was pulled from a live server, but 'implode' writes a backup XML. ` +
        `The two transports use different config shapes and the normalization bridge is not implemented yet, ` +
        `so imploding would produce malformed XML. Re-create the tree with 'explode' from a backup, or pass --force to override.`;
  fail(msg);
}

/** Commander collector for a repeatable option; undefined until first used. */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

// --- scoped push ----------------------------------------------------------

async function scopedPush(
  client: MirthClientExt,
  root: string,
  local: CanonicalConfig,
  scope: Scope,
  target: string,
  flags: { allowDeletes?: boolean; deploy?: boolean; force?: boolean; yes?: boolean },
): Promise<void> {
  const remote = await client.getServerConfiguration();
  const plan = planPush(local, remote, scope);
  const deletes = plan.changes.filter((c) => c.op === 'delete');
  const names = new Map(
    [...channelsOf(remote), ...channelsOf(local)].map((c) => [String(c['id']), String(c['name'])] as const),
  );

  if (plan.changes.length === 0) {
    process.stdout.write(`nothing to push: ${target} already matches the tree\n`);
  } else {
    process.stdout.write(`Push to ${target}:\n`);
    const kindLabel: Record<string, string> = {
      channel: 'channel',
      library: 'library',
      codeTemplate: 'code template',
      globalScripts: '',
    };
    for (const c of plan.changes) {
      process.stdout.write(`  ${c.op.padEnd(6)}  ${`${kindLabel[c.kind]} ${c.label}`.trim()}\n`);
    }
    if (flags.deploy && plan.deployIds.length > 0) {
      process.stdout.write(`then redeploy: ${plan.deployIds.map((id) => names.get(id) ?? id).join(', ')}\n`);
    }
  }
  if (plan.notPushed.length > 0) {
    process.stdout.write(`not pushed (differs; use --whole-server): ${plan.notPushed.join(', ')}\n`);
  }
  if (plan.changes.length === 0) return;

  if (plan.conflicts.length > 0 && !flags.force) {
    fail(
      `changed on the server since the last pull:\n  ${plan.conflicts.join('\n  ')}\n` +
        `pull (and merge) first, or pass --force to overwrite the server's version`,
    );
  }
  if (deletes.length > 0 && !flags.allowDeletes) {
    fail(`the plan deletes ${deletes.length} resource(s) from the server; pass --allow-deletes, or narrow with --channel/--library`);
  }
  if (!flags.yes && !(await confirm('Continue?'))) {
    process.stdout.write('aborted.\n');
    return;
  }

  const result = await applyPlan(client, plan, local, remote, scope);
  // Record the server's new revisions even after a partial failure, so the
  // resources that did go through don't read as conflicts next time.
  if (result.touchedIds.size > 0) {
    await refreshRevisions(root, await client.getServerConfiguration(), result.touchedIds);
  }
  if (result.failed) {
    const { change, error } = result.failed;
    fail(`applied ${result.applied.length} of ${plan.changes.length}; ${change.op} ${change.label} failed: ${error}`);
  }
  process.stdout.write(`pushed ${result.applied.length} change(s)\n`);

  if (flags.deploy && plan.deployIds.length > 0) {
    const failures = await deployChannels(client, plan.deployIds, (id) => names.get(id) ?? id);
    const ok = plan.deployIds.length - failures.length;
    process.stdout.write(`deployed ${ok} of ${plan.deployIds.length} channel(s)\n`);
    for (const f of failures) process.stderr.write(`deploy failed: ${f.name}: ${f.error}\n`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

// --- commands -------------------------------------------------------------

const program = new Command();
program
  .name('channelvault')
  .description('Git-style pull/push/diff for Mirth Connect')
  .version('0.1.0');

addEnvFlag(
  program
    .command('explode')
    .description('Explode a Mirth backup XML into a working tree')
    .argument('<backup.xml>', 'path to a Mirth backup config XML file')
    .argument('<dir>', 'output working-tree directory'),
).action(async (backupPath: string, dir: string, flags: EnvFlags) => {
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

addEnvFlag(addConnectionFlags(
  program
    .command('pull')
    .description('Pull the live server configuration into a working tree')
    .argument('<dir>', 'working-tree directory'),
)).action(async (dir: string, flags: ConnectionFlags & EnvFlags) => {
  const root = path.resolve(dir);
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
    .option('--force', 'push even if the server changed since the last pull, or the tree came from an XML backup', false)
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
    },
  ) => {
    const root = path.resolve(dir);
    assertTree(root);
    const config = await renderedTree(root, flags);
    await assertCompatibleOrigin(root, config, 'live', flags.force === true);
    const cfg = resolveClientConfig(flags);
    const target = `${cfg.https === false ? 'http' : 'https'}://${cfg.host}:${cfg.port}`;
    if (!flags.yes && !process.stdin.isTTY) {
      fail('no terminal to confirm on; review with `diff` and pass --yes');
    }
    if (!flags.wholeServer) {
      const scope: Scope = { channels: flags.channel, libraries: flags.library, globalScripts: flags.globalScripts };
      await withClient(flags, (client) => scopedPush(client, root, config, scope, target, flags));
      return;
    }
    const s = summarize(config);

    if (!flags.yes) {
      process.stdout.write(
        `About to overwrite the ENTIRE server configuration at ${target}\n` +
          `  ${s.channels} channels, ${s.codeTemplates} code templates` +
          (flags.deploy ? ', then redeploy all channels' : '') +
          '\n',
      );
      if (!(await confirm('Continue?'))) {
        process.stdout.write('aborted.\n');
        return;
      }
    }

    await withClient(flags, (client) =>
      client.putServerConfiguration(config, {
        deploy: flags.deploy === true,
        overwriteConfigMap: flags.overwriteConfigMap === true,
      }),
    );
    process.stdout.write(`pushed ${root} -> ${target}\n`);
  },
);

addEnvFlag(addConnectionFlags(
  program
    .command('diff')
    .description('Diff a working tree against the live server configuration')
    .argument('<dir>', 'working-tree directory'),
)).action(async (dir: string, flags: ConnectionFlags & EnvFlags) => {
  const root = path.resolve(dir);
  assertTree(root);

  const fetched = await withClient(flags, (client) => client.getServerConfiguration());
  // Compare like with like: the server's credentials become the placeholders
  // the tree holds. Values that differ from the env file are named, never shown.
  const { config: remote, envUpdates, notes } = templatize(
    fetched,
    await engine.implode({ root }),
    await loadEnv(envFilePath(root, flags)),
  );
  for (const name of Object.keys(envUpdates)) {
    process.stderr.write(`note: ${name} differs between the server and the env file\n`);
  }
  for (const note of notes) process.stderr.write(`note: ${note}\n`);
  const tmp = await mkdtemp(path.join(tmpdir(), 'channelvault-diff-'));
  try {
    await engine.explode(remote, { root: tmp });
    // Compare only what explode owns, so the user's own files (.gitignore, .env,
    // a README) and our channelvault.json bookkeeping never show as deletions.
    // Per-directory, because git diff --no-index takes exactly two paths.
    const empty = path.join(tmp, '.empty');
    await mkdir(empty);
    const chunks: string[] = [];
    for (const d of MANAGED_DIRS) {
      const local = existsSync(path.join(root, d)) ? path.join(root, d) : empty;
      const server = existsSync(path.join(tmp, d)) ? path.join(tmp, d) : empty;
      if (local === empty && server === empty) continue;
      // Pin line-ending handling so the answer doesn't depend on the user's git
      // config, and match push, which ignores CR-only differences.
      const result = spawnSync(
        'git',
        ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--ignore-cr-at-eol', local, server],
        { encoding: 'utf8' },
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
    if (out === '') {
      process.stdout.write('no differences — working tree matches the server.\n');
    } else {
      process.stdout.write(out + '\n');
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
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as SyncMeta;
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
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  if (!(err instanceof CliError) && err instanceof Error && process.env.CHANNELVAULT_DEBUG) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exitCode = 1;
});
