/**
 * Connection profiles: `profiles.json` (no secrets) and `credentials` (one
 * `name=password` line per profile, owner-only) in channelvault's user-level
 * folder, outside every repository and worktree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { writePrivate } from './backup/index.js';
import { readJson } from './json.js';
import { resolvedPathSync, samePath } from './paths.js';
import { readEnvFile, updateEnvFile } from './secrets/envfile.js';

/** An error with a stable reason code, printed as `error: [reason] message`. */
export class ReasonError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

function problem(message: string, reason: string): never {
  throw new ReasonError(message, reason);
}

/** channelvault's user-level folder, outside every repository and worktree: `CHANNELVAULT_CONFIG_DIR`, else `~/.channelvault`. */
export function configDir(): string {
  const override = process.env.CHANNELVAULT_CONFIG_DIR;
  if (!override) return path.join(homedir(), '.channelvault');
  const dir = path.resolve(override);
  // The credentials file must never be committable.
  let existing = dir;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: existing, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim() === 'true') {
    problem(`CHANNELVAULT_CONFIG_DIR (${dir}) is inside a git work tree; keep channelvault's folder outside every repository`, 'config-in-repo');
  }
  return dir;
}

export const PROFILES_FILE = 'profiles.json';
export const CREDENTIALS_FILE = 'credentials';

export interface Profile {
  host: string;
  port: number;
  user: string;
  /** Default true. */
  https?: boolean;
  /** Loopback hosts only. */
  insecure?: boolean;
  /** SHA-256 of the server certificate, lowercase hex without colons. */
  tlsFingerprint?: string;
  /** The installation (`GET /server/id`) this profile must reach. */
  serverId?: string;
  /** Absolute path of the env file for trees pulled with this profile. */
  dotenv?: string;
}

export type Profiles = Record<string, Profile>;

const FIELDS: ReadonlyArray<keyof Profile> = ['host', 'port', 'user', 'https', 'insecure', 'tlsFingerprint', 'serverId', 'dotenv'];

/** Names double as `credentials` keys and shell arguments. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `ab:CD:…` or `abcd…` as 64 lowercase hex digits; null if it is not a SHA-256 fingerprint. */
export function normalizeFingerprint(value: string): string | null {
  const hex = value.replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** `AB:CD:…`, the form browsers and openssl print. */
export function formatFingerprint(hex: string): string {
  return hex.toUpperCase().match(/../g)!.join(':');
}

/** Every reason `profiles` cannot be used, by name; empty when it is valid. */
export function profileProblems(profiles: unknown): string[] {
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) return ['profiles must be an object of named profiles'];
  const problems: string[] = [];
  const dotenvs: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(profiles as Record<string, unknown>)) {
    const at = `profile ${name}`;
    if (!PROFILE_NAME.test(name)) problems.push(`${at}: a name is letters, digits, '.', '_' and '-', starting with a letter or digit`);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at}: must be an object`);
      continue;
    }
    const p = raw as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (key === 'password') problems.push(`${at}: a password does not belong in profiles.json; remove it and run \`channelvault profile set-password ${name}\` at a terminal`);
      else if (!(FIELDS as readonly string[]).includes(key)) problems.push(`${at}: unknown field ${key} (fields: ${FIELDS.join(', ')})`);
    }
    if (typeof p.host !== 'string' || p.host === '' || /[\s/]/.test(p.host)) problems.push(`${at}: host must be a host name or address`);
    if (!Number.isInteger(p.port) || (p.port as number) < 1 || (p.port as number) > 65535) problems.push(`${at}: port must be a whole number from 1 to 65535`);
    if (typeof p.user !== 'string' || p.user === '') problems.push(`${at}: user must be a non-empty string`);
    for (const flag of ['https', 'insecure'] as const) {
      if (p[flag] !== undefined && typeof p[flag] !== 'boolean') problems.push(`${at}: ${flag} must be true or false`);
    }
    if (p.serverId !== undefined && (typeof p.serverId !== 'string' || p.serverId === '')) problems.push(`${at}: serverId must be a non-empty string`);
    if (p.tlsFingerprint !== undefined && (typeof p.tlsFingerprint !== 'string' || normalizeFingerprint(p.tlsFingerprint) === null)) {
      problems.push(`${at}: tlsFingerprint must be a SHA-256 certificate fingerprint (64 hex digits, colons allowed)`);
    }
    if (p.dotenv !== undefined) {
      if (typeof p.dotenv !== 'string' || !path.isAbsolute(p.dotenv)) problems.push(`${at}: dotenv must be an absolute path`);
      else dotenvs.push([name, resolvedPathSync(p.dotenv)]);
    }
    if (typeof p.host === 'string' && !isLoopback(p.host)) {
      if (p.https === false) problems.push(`${at}: https cannot be false for ${p.host}; plain http sends the password readable on the network (only loopback hosts may use it)`);
      if (p.insecure === true) problems.push(`${at}: insecure is refused for ${p.host}; pin the certificate with tlsFingerprint instead (only loopback hosts may turn verification off)`);
    }
    if (p.https === false && p.tlsFingerprint !== undefined) problems.push(`${at}: tlsFingerprint needs https`);
    if (p.insecure === true && p.tlsFingerprint !== undefined) problems.push(`${at}: insecure and tlsFingerprint cannot both be set`);
  }
  for (let i = 0; i < dotenvs.length; i++) {
    for (let j = i + 1; j < dotenvs.length; j++) {
      if (samePath(dotenvs[i]![1], dotenvs[j]![1])) problems.push(`profiles ${dotenvs[i]![0]} and ${dotenvs[j]![0]} share the env file ${dotenvs[i]![1]}; each server needs its own`);
    }
  }
  return problems;
}

export function profilesFile(): string {
  return path.join(configDir(), PROFILES_FILE);
}

export function credentialsFile(): string {
  return path.join(configDir(), CREDENTIALS_FILE);
}

/** The saved profiles, validated; empty when there is no profiles file. */
export async function loadProfiles(): Promise<Profiles> {
  const file = profilesFile();
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = await readJson(file);
  } catch {
    // Not the parser's message: it can quote the file's contents.
    problem(`${file} is not valid JSON; fix or remove it`, 'profiles-invalid');
  }
  const profiles = (parsed as { profiles?: unknown } | null)?.profiles;
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  const problems = keys.some(k => k !== 'profiles') || profiles === undefined
    ? [`the file holds one object, { "profiles": { "<name>": { ... } } }`]
    : profileProblems(profiles);
  if (problems.length > 0) problem(`${file} cannot be used:\n  ${problems.join('\n  ')}`, 'profiles-invalid');
  const out: Profiles = {};
  for (const [name, p] of Object.entries(profiles as Profiles)) {
    out[name] = { ...p, ...(p.tlsFingerprint ? { tlsFingerprint: normalizeFingerprint(p.tlsFingerprint)! } : {}) };
  }
  return out;
}

async function ensureConfigDir(): Promise<string> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function saveProfiles(profiles: Profiles): Promise<void> {
  const problems = profileProblems(profiles);
  if (problems.length > 0) problem(`not saved:\n  ${problems.join('\n  ')}`, 'profiles-invalid');
  await ensureConfigDir();
  await writePrivate(profilesFile(), `${JSON.stringify({ profiles }, null, 2)}\n`);
}

/** Read with the env-file parser, so nothing in the process environment can stand in for a password. */
export async function readCredentials(): Promise<Record<string, string>> {
  return readEnvFile(credentialsFile());
}

export async function setCredential(name: string, password: string): Promise<void> {
  await ensureConfigDir();
  await updateEnvFile(credentialsFile(), { [name]: password });
}
