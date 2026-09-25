/**
 * Shared contracts for channelvault.
 *
 * The whole tool is organized around a single in-memory representation called
 * the **canonical config**: a plain JSON object tree that mirrors Mirth's
 * `serverConfiguration` document. Two adapters produce/consume it:
 *
 *   - XML adapter   (src/xml):    backup .xml  <-> canonical  (dev / offline path)
 *   - Mirth client  (src/client): live server  <-> canonical  (GET/PUT /server/configuration)
 *
 * The explode engine (src/explode) projects a canonical config onto a
 * git-friendly directory tree and reverses it, with embedded JavaScript pulled
 * out into sidecar `.js` files.
 */

/** A JSON value as produced by the XML adapter or the live API. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** A canonical config object (the `serverConfiguration` payload, unwrapped). */
export type CanonicalConfig = { [k: string]: Json };

/**
 * Marker left in a `*.json` file in place of an extracted script/code leaf.
 *
 * During explode, a code-bearing string leaf (e.g. a transformer step's
 * `script`, or a code template's `code`) is written to a sidecar `.js` file and
 * the original string is replaced, in place, with `{ "@file": "<relpath>" }`.
 * During implode, any object whose only key is `@file` is replaced by the text
 * content of that file. The path is relative to the JSON file holding the marker.
 */
export interface FileRef {
  '@file': string;
}

export function isFileRef(v: unknown): v is FileRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as Record<string, unknown>)['@file'] === 'string'
  );
}

/**
 * The set of leaf element keys whose string values are treated as JavaScript
 * and extracted to sidecar `.js` files. Detection is by key name plus a
 * non-trivial-content check (see explode engine).
 */
export const CODE_KEYS = ['script', 'code'] as const;

/**
 * Channel-level script keys that live directly on a channel object (no nesting).
 * Extracted into `<channel>/scripts/<name>.js`.
 */
export const CHANNEL_SCRIPT_KEYS = [
  'preprocessingScript',
  'postprocessingScript',
  'deployScript',
  'undeployScript',
] as const;

// --- XML adapter contract -------------------------------------------------

export interface XmlAdapter {
  /** Parse a Mirth backup XML string into a canonical config. */
  parse(xml: string): CanonicalConfig;
  /** Serialize a canonical config back to Mirth backup XML. */
  build(config: CanonicalConfig): string;
}

// --- Explode engine contract ----------------------------------------------

export interface ExplodeOptions {
  /** Absolute path to the working tree root. */
  root: string;
}

export interface ExplodeEngine {
  /** Write a canonical config out as a directory tree under `root`. */
  explode(config: CanonicalConfig, opts: ExplodeOptions): Promise<void>;
  /** Read a directory tree under `root` back into a canonical config. */
  implode(opts: ExplodeOptions): Promise<CanonicalConfig>;
}

// --- Mirth client contract ------------------------------------------------

export interface ClientConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** default true */
  https?: boolean;
  /** default false; set true for self-signed certs */
  disableTlsCheck?: boolean;
  /**
   * default false. Put the server's response body in error messages. A body
   * can echo the credentials that were sent; it is decoded and has credential
   * fields redacted, but the caller must still scrub known secret values.
   */
  includeResponseBodies?: boolean;
}

export interface ApiError {
  status: number;
  statusText: string;
  message: string;
  body?: unknown;
}

export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
}

export interface MirthClient {
  login(): Promise<void>;
  logout(): Promise<void>;
  isAuthenticated(): boolean;
  /** GET /server/configuration -> canonical config (whole-server snapshot). */
  getServerConfiguration(): Promise<CanonicalConfig>;
  /** PUT /server/configuration <- canonical config. */
  putServerConfiguration(config: CanonicalConfig): Promise<void>;
}
