/**
 * Which server a command talks to, resolved once per command from exactly one
 * source; fields never mix across sources (see README "Profiles").
 */
import { formatFingerprint, normalizeFingerprint, ReasonError, type Profile, type Profiles } from './profiles.js';

export interface ConnectionFlags {
  profile?: string;
  host?: string;
  port?: string;
  user?: string;
  pass?: string;
  insecure?: boolean;
  /** false with --no-https. */
  https?: boolean;
  tlsFingerprint?: string;
}

/** How the connection was chosen, in selection order. */
export type ConnectionSource = 'profile-flag' | 'flags' | 'env-profile' | 'env' | 'tree';

export const SOURCE_LABEL: Record<ConnectionSource, string> = {
  'profile-flag': 'typed --profile',
  flags: 'login flags',
  'env-profile': 'MIRTH_PROFILE',
  env: 'MIRTH_* environment',
  tree: "the tree's serverId",
};

export interface Connection {
  host: string;
  port: number;
  user: string;
  password: string;
  https: boolean;
  insecure: boolean;
  tlsFingerprint?: string;
  source: ConnectionSource;
  passwordSource: 'credentials' | '--pass' | 'MIRTH_PASS';
  /** Set on the three profile sources. */
  profile?: string;
  /** The installation a profile must reach. */
  serverId?: string;
  /** A profile's env file. */
  dotenv?: string;
}

export interface SelectionInput {
  flags: ConnectionFlags;
  env: Record<string, string | undefined>;
  profiles: Profiles;
  credentials: Record<string, string>;
  /** `serverId` from the tree's channelvault.json, when there is one. */
  treeServerId?: string;
  /** A real write: push without --plan-only, restore, adopt without --plan-only. */
  write?: boolean;
  /** --yes: no prompt will name the profile and host before the write. */
  yes?: boolean;
  /** A write that only a typed --profile or --host may target (adopt, which rebinds a tree). */
  explicit?: boolean;
}

function refuse(message: string, reason: string): never {
  throw new ReasonError(message, reason);
}

export function urlOf(conn: Pick<Connection, 'https' | 'host' | 'port'>): string {
  return `${conn.https ? 'https' : 'http'}://${conn.host}:${conn.port}`;
}

function profileList(profiles: Profiles): string {
  const names = Object.keys(profiles);
  return names.length ? `profiles: ${names.join(', ')}` : 'no profiles yet; add one at a terminal with `channelvault profile add <name> --host <host> --port <port> --user <user>`';
}

function sameHost(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fromProfile(name: string, input: SelectionInput, source: ConnectionSource): Connection {
  const profile: Profile | undefined = input.profiles[name];
  if (!profile) refuse(`no profile named ${name} (${profileList(input.profiles)})`, 'profile-unknown');
  const typed = (['host', 'port', 'user', 'pass', 'tlsFingerprint'] as const).filter(k => input.flags[k] !== undefined).map(k => `--${k === 'tlsFingerprint' ? 'tls-fingerprint' : k}`);
  if (input.flags.insecure) typed.push('--insecure');
  if (input.flags.https === false) typed.push('--no-https');
  if (typed.length > 0) refuse(`profile ${name} sets the whole connection; drop ${typed.join(', ')} (or use the login flags without a profile)`, 'flag-conflict');
  const password = input.credentials[name];
  if (password === undefined) refuse(`profile ${name} has no password yet; run \`channelvault profile set-password ${name}\` at a terminal`, 'no-password');
  if (input.treeServerId && profile.serverId && input.treeServerId !== profile.serverId) {
    refuse(`this tree belongs to installation ${input.treeServerId}, but profile ${name} is installation ${profile.serverId}; choose the profile for this tree`, 'profile-mismatch');
  }
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password,
    https: profile.https !== false,
    insecure: profile.insecure === true,
    ...(profile.tlsFingerprint ? { tlsFingerprint: profile.tlsFingerprint } : {}),
    source,
    passwordSource: 'credentials',
    profile: name,
    ...(profile.serverId ? { serverId: profile.serverId } : {}),
    ...(profile.dotenv ? { dotenv: profile.dotenv } : {}),
  };
}

/** The login flags with MIRTH_* filling what was not typed (today's path). */
function fromFlagsAndEnv(input: SelectionInput, source: 'flags' | 'env'): Connection {
  const { flags, env } = input;
  // A typed --host must not borrow a login exported for another server.
  const foreign = flags.host !== undefined && env.MIRTH_HOST && !sameHost(flags.host, env.MIRTH_HOST);
  const fallback = (name: 'MIRTH_PORT' | 'MIRTH_USER' | 'MIRTH_PASS') => (foreign ? undefined : env[name]);
  const host = flags.host ?? env.MIRTH_HOST;
  const portStr = flags.port ?? fallback('MIRTH_PORT');
  const user = flags.user ?? fallback('MIRTH_USER');
  const password = flags.pass ?? fallback('MIRTH_PASS');
  function missing(field: string, envName: string): never {
    if (foreign && env[envName] !== undefined) {
      refuse(`${envName} belongs to MIRTH_HOST=${env.MIRTH_HOST}, not --host ${flags.host}; type the matching --${field}, or use --profile`, 'env-conflict');
    }
    refuse(`no ${field} for ${host ?? 'the server'}: use --profile <name> (${profileList(input.profiles)})`, 'no-connection');
  }
  if (!host) refuse(`no server: use --profile <name> (${profileList(input.profiles)})`, 'no-connection');
  if (portStr === undefined) missing('port', 'MIRTH_PORT');
  if (user === undefined) missing('user', 'MIRTH_USER');
  if (password === undefined) missing('pass', 'MIRTH_PASS');
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse(`invalid port: ${portStr}`, 'bad-port');
  const rawPin = flags.tlsFingerprint ?? (foreign ? undefined : env.MIRTH_TLS_FINGERPRINT);
  const tlsFingerprint = rawPin === undefined ? undefined : normalizeFingerprint(rawPin);
  if (rawPin !== undefined && !tlsFingerprint) refuse('--tls-fingerprint (or MIRTH_TLS_FINGERPRINT) must be a SHA-256 certificate fingerprint: 64 hex digits, colons allowed', 'bad-fingerprint');
  if (tlsFingerprint && flags.insecure) refuse('--insecure turns off the certificate check that --tls-fingerprint (or MIRTH_TLS_FINGERPRINT) pins; drop --insecure', 'flag-conflict');
  if (tlsFingerprint && flags.https === false) refuse('--tls-fingerprint needs https; drop --no-https', 'flag-conflict');
  return {
    host,
    port,
    user,
    password,
    https: flags.https !== false,
    insecure: flags.insecure === true,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    source,
    passwordSource: flags.pass !== undefined ? '--pass' : 'MIRTH_PASS',
  };
}

function profilesFor(profiles: Profiles, serverId: string): string[] {
  return Object.entries(profiles).filter(([, p]) => p.serverId === serverId).map(([n]) => n);
}

/** The profile a server's installation belongs to, if any; for refusing a stale MIRTH_HOST after login. */
export function profileOwning(profiles: Profiles, serverId: string): string | undefined {
  return profilesFor(profiles, serverId)[0];
}

/**
 * Pick the connection: --profile, then login flags, then MIRTH_PROFILE, then
 * MIRTH_HOST, then the profile matching the tree's serverId. Pure: every input
 * is passed in.
 */
export function resolveConnection(given: SelectionInput): Connection {
  // `MIRTH_HOST=` clears a variable in most shells' habits; treat it as unset.
  const input = { ...given, env: Object.fromEntries(Object.entries(given.env).filter(([, v]) => v !== '')) };
  const { flags, env, profiles } = input;
  const loginTyped = flags.host !== undefined || flags.port !== undefined || flags.user !== undefined || flags.pass !== undefined;
  let conn: Connection;
  if (flags.profile !== undefined) {
    conn = fromProfile(flags.profile, input, 'profile-flag');
  } else if (flags.host !== undefined) {
    conn = fromFlagsAndEnv(input, 'flags');
  } else if (env.MIRTH_PROFILE) {
    conn = fromProfile(env.MIRTH_PROFILE, input, 'env-profile');
  } else if (env.MIRTH_HOST) {
    const owner = input.treeServerId ? profilesFor(profiles, input.treeServerId) : [];
    if (owner.length > 0) {
      refuse(`MIRTH_HOST is set, but this tree belongs to profile ${owner.join(' or ')}; use --profile ${owner[0]}, or unset MIRTH_HOST`, 'env-shadowed');
    }
    // Login flags typed without --host still reach MIRTH_HOST's server, so they get the same guards.
    conn = fromFlagsAndEnv(input, 'env');
  } else if (loginTyped) {
    refuse(`--port, --user and --pass need --host (or use --profile <name>; ${profileList(profiles)})`, 'no-connection');
  } else {
    const owner = input.treeServerId ? profilesFor(profiles, input.treeServerId) : [];
    if (owner.length > 1) refuse(`profiles ${owner.join(', ')} all name this tree's installation (${input.treeServerId}); pass --profile`, 'profile-ambiguous');
    if (owner.length === 0) {
      refuse(`no connection: pass --profile <name> (${profileList(profiles)})`, 'no-connection');
    }
    conn = fromProfile(owner[0]!, input, 'tree');
  }
  if (input.write && conn.source === 'tree') {
    refuse(`writing to a server needs the profile typed: add --profile ${conn.profile} (this tree's serverId selects it, which is enough only for reading)`, 'profile-not-typed');
  }
  if (input.write && conn.source === 'env-profile' && input.yes) {
    refuse(`with --yes, writing to a server needs the profile typed: add --profile ${conn.profile} (MIRTH_PROFILE selects a write only when you confirm it at a terminal)`, 'profile-not-typed');
  }
  if (input.write && input.explicit && conn.source !== 'profile-flag' && conn.source !== 'flags') {
    refuse('this command needs its server typed: pass --profile <name>, or --host with the login (environment variables can be stale)', 'connection-not-typed');
  }
  return conn;
}

/** One line naming everything that decides where the command goes; never the password. */
export function describeConnection(conn: Connection, serverId: string | undefined, envFile?: string): string {
  const parts = [
    conn.profile ? `profile ${conn.profile}` : 'no profile',
    `${urlOf(conn)} as ${conn.user}`,
    serverId ? `installation ${serverId}` : 'installation not checked',
    `chosen by ${SOURCE_LABEL[conn.source]}`,
    `password from ${conn.passwordSource}`,
    conn.tlsFingerprint ? `certificate pinned ${formatFingerprint(conn.tlsFingerprint).slice(0, 23)}…` : conn.insecure ? 'certificate not checked' : conn.https ? 'certificate verified' : 'plain http',
  ];
  if (envFile) parts.push(`env file ${envFile}`);
  return `connection: ${parts.join(', ')}`;
}

/** For --json: the connection without its password. */
export function connectionJson(conn: Connection, serverId?: string, envFile?: string): Record<string, unknown> {
  return {
    profile: conn.profile ?? null,
    url: urlOf(conn),
    user: conn.user,
    source: conn.source,
    passwordSource: conn.passwordSource,
    serverId: serverId ?? null,
    tlsFingerprint: conn.tlsFingerprint ?? null,
    insecure: conn.insecure,
    envFile: envFile ?? null,
  };
}
