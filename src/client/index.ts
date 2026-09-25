/**
 * Live Mirth transport client.
 *
 * Talks to a running Mirth Connect (a.k.a. NextGen Connect / OIE / BridgeLink)
 * server over its REST API and produces/consumes the canonical config (the
 * unwrapped `serverConfiguration` document) — the same logical document the XML
 * adapter parses from a backup file.
 *
 * The transport (login, cookie jar, TLS bypass, 401 re-auth, single-flight
 * login) is ported from the proven `baseClient.ts` in the sibling
 * `integration-engine-api` project. We deliberately do NOT carry over the
 * OpenAPI-generated typing layers: payloads are opaque `CanonicalConfig` JSON.
 *
 * Wrapping behavior for the two endpoints:
 *
 *   - GET  /server/configuration returns a Jackson-style document wrapped in a
 *     single top-level key (`serverConfiguration`), with `@version` / `@class`
 *     metadata sprinkled throughout. `getServerConfiguration()` unwraps the
 *     single top-level key and returns its contents.
 *   - PUT  /server/configuration expects the same wrapper, so
 *     `putServerConfiguration()` re-wraps as `{ serverConfiguration: config }`.
 */
import { CookieJar } from 'tough-cookie';
import { Agent } from 'undici';
import { redactSecretsInText } from '../secrets/detect.js';
import { isSecretKey } from '../secrets/index.js';
import type { ApiError, CanonicalConfig, ClientConfig, MirthClient } from '../types.js';

/** TLS verification failures, typically a self-signed or privately issued server certificate. */
export const UNTRUSTED_CERT_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  // Not an expired certificate or a host-name mismatch: turning verification
  // off is the wrong advice for those, and their messages already say why.
]);

/**
 * fetch reports every network failure as "fetch failed" and keeps the reason
 * (ECONNREFUSED, a certificate error) in `cause`; surface it, with its code.
 */
function connectionError(url: string, err: unknown): Error & { code?: string } {
  let cause = err instanceof Error ? (err.cause as (Error & { code?: string; errors?: unknown[] }) | undefined) : undefined;
  // Several addresses tried (IPv4 and IPv6): report the first attempt.
  if (cause instanceof AggregateError && cause.errors[0] instanceof Error) cause = cause.errors[0] as Error & { code?: string };
  const detail = cause?.message || (err instanceof Error ? err.message : String(err));
  const code = cause?.code;
  const error = new Error(
    `cannot reach ${new URL(url).origin}: ${detail}${code && !detail.includes(code) ? ` (${code})` : ''}`,
    { cause: err },
  ) as Error & { code?: string };
  error.code = code;
  return error;
}

/** Optional flags accepted by `putServerConfiguration` (Mirth query params). */
export interface PutServerConfigurationOptions {
  /** Redeploy all channels after applying the configuration. */
  deploy?: boolean;
  /** Overwrite the global configuration map. */
  overwriteConfigMap?: boolean;
}

/**
 * The public client type. It satisfies the declared {@link MirthClient}
 * contract but widens `putServerConfiguration` to accept the optional Mirth
 * query-param flags. The widened signature is structurally assignable to the
 * one-arg contract (the extra parameter is optional), so a `MirthClientExt`
 * is a valid `MirthClient` wherever the bare contract is expected.
 */
export interface MirthClientExt extends MirthClient {
  putServerConfiguration(config: CanonicalConfig, options?: PutServerConfigurationOptions): Promise<void>;
  /** GET /server/id: the installation's ID, which a configuration restore does not change (verified on 4.5.2). */
  getServerId(): Promise<string>;
  /** GET /server/configuration as the server's own XML (the Administrator's Backup Config document). */
  getServerConfigurationXml(): Promise<string>;
  /** PUT /server/configuration from backup XML, as the Administrator's Restore Config does. */
  putServerConfigurationXml(xml: string, options?: PutServerConfigurationOptions): Promise<void>;
  /** GET /channels/{id}, unwrapped; includes the tag and dependency data the server configuration omits. */
  getChannel(id: string): Promise<Record<string, unknown> | null>;
  /** PUT /channels/{id}; creates the channel if the id is new. */
  putChannel(channel: Record<string, unknown>): Promise<void>;
  /** Release pooled connections so the process can exit promptly. */
  close(): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  /** PUT /codeTemplates/{id}; creates the template if the id is new. */
  putCodeTemplate(template: Record<string, unknown>): Promise<void>;
  deleteCodeTemplate(id: string): Promise<void>;
  /** PUT /codeTemplateLibraries: replaces the whole list (membership and library settings). */
  putCodeTemplateLibraries(libraries: Record<string, unknown>[]): Promise<void>;
  /** PUT /server/globalScripts, from the `globalScripts` value of a server configuration. */
  putGlobalScripts(globalScripts: unknown): Promise<void>;
  /** POST /channels/{id}/_deploy; throws if deployment fails. */
  deployChannel(id: string): Promise<void>;
  /** Ids of the channels currently deployed (GET /channels/statuses). */
  getDeployedChannelIds(): Promise<Set<string>>;
}

/** Internal HTTP verbs we use. */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** Options for the low-level authenticated request helper. */
interface RequestOptions {
  /** Already-serialized request body. */
  body?: string;
  /** Query parameters appended to the URL. */
  query?: Record<string, unknown>;
  /** Additional headers merged over the defaults. */
  headers?: Record<string, string>;
}

/** Shape of the (unwrapped) Mirth login status payload we read. */
interface LoginStatusPayload {
  status?: string;
  message?: string | null;
}

/** The single top-level wrapper key of a Mirth backup / server config document. */
const SERVER_CONFIG_KEY = 'serverConfiguration';

/**
 * Unwrap a Jackson-style single-key wrapper. Mirth wraps many responses in a
 * single top-level namespace key. If the value has exactly one top-level key we
 * unwrap it; otherwise we return it unchanged (defensive against the wrapper
 * being named differently or absent).
 */
function unwrapSingleKey(value: Record<string, unknown>): unknown {
  const keys = Object.keys(value);
  if (keys.length === 1) {
    return value[keys[0] as string];
  }
  return value;
}

/**
 * MirthClient implementation. Created via {@link createMirthClient}.
 */
class MirthClientImpl implements MirthClientExt {
  private readonly config: ClientConfig;
  private readonly baseUrl: string;
  private readonly cookieJar: CookieJar;
  /** Our own pool (not the global one) so `close()` can release it. */
  private readonly dispatcher: Agent;

  private authenticated = false;
  /** Single in-flight login promise (concurrency guard). */
  private loginPromise: Promise<void> | null = null;

  constructor(config: ClientConfig) {
    this.config = config;
    const protocol = config.https !== false ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}/api`;
    this.cookieJar = new CookieJar();

    this.dispatcher = new Agent(config.disableTlsCheck ? { connect: { rejectUnauthorized: false } } : {});
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Establish a session. Concurrent calls share a single in-flight login.
   */
  async login(): Promise<void> {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
        const loginUrl = `${this.baseUrl}/users/_login`;

        const body = new URLSearchParams({
          username: this.config.username,
          password: this.config.password,
        });

        const response = await this.send(loginUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
          },
          body: body.toString(),
        });

        await this.storeCookies(response, this.baseUrl);

        if (!response.ok) {
          // Not the body: a login endpoint's error page can echo the request.
          await response.body?.cancel();
          throw new Error(`Login failed: HTTP ${response.status} ${response.statusText}`.trimEnd());
        }

        const result = (await response.json()) as Record<string, unknown>;

        // Mirth wraps the result, e.g.
        // { 'com.mirth.connect.model.LoginStatus': { status: 'SUCCESS', message: null } }
        const payload = unwrapSingleKey(result) as LoginStatusPayload;

        if (payload.status !== 'SUCCESS') {
          throw new Error(`Login failed: ${payload.status} - ${payload.message ?? 'Unknown error'}`);
        }

        this.authenticated = true;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  /**
   * End the session and clear local auth state + cookies.
   */
  async logout(): Promise<void> {
    if (!this.authenticated) {
      return;
    }

    try {
      const logoutUrl = `${this.baseUrl}/users/_logout`;
      const cookieString = await this.cookieJar.getCookieString(logoutUrl);
      await this.send(logoutUrl, {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookieString ? { Cookie: cookieString } : {}),
        },
      });
    } finally {
      this.authenticated = false;
      await this.cookieJar.removeAllCookies();
    }
  }

  /**
   * GET /server/configuration -> canonical config.
   *
   * Requests JSON, parses it, and unwraps the single top-level
   * `serverConfiguration` key (defensively: any single-key wrapper is unwrapped;
   * a multi-key object is returned as-is).
   */
  async getServerConfiguration(): Promise<CanonicalConfig> {
    const response = await this.request('GET', '/server/configuration', {
      headers: { Accept: 'application/json' },
    });

    const json = (await response.json()) as Record<string, unknown>;
    return unwrapSingleKey(json) as CanonicalConfig;
  }

  /**
   * PUT /server/configuration <- canonical config.
   *
   * Re-wraps the canonical config as `{ serverConfiguration: config }` and
   * forwards the optional `deploy` / `overwriteConfigMap` flags as query params.
   */
  async putServerConfiguration(config: CanonicalConfig, options: PutServerConfigurationOptions = {}): Promise<void> {
    const query: Record<string, unknown> = {};
    if (options.deploy !== undefined) {
      query.deploy = options.deploy;
    }
    if (options.overwriteConfigMap !== undefined) {
      query.overwriteConfigMap = options.overwriteConfigMap;
    }

    const wrapped = { [SERVER_CONFIG_KEY]: config };

    await this.request('PUT', '/server/configuration', {
      query,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(wrapped),
    });
  }

  async getServerId(): Promise<string> {
    // JSON is refused (406); the ID comes as plain text.
    const response = await this.request('GET', '/server/id', { headers: { Accept: 'text/plain' } });
    return (await response.text()).trim();
  }

  async getServerConfigurationXml(): Promise<string> {
    const response = await this.request('GET', '/server/configuration', { headers: { Accept: 'application/xml' } });
    return response.text();
  }

  async putServerConfigurationXml(xml: string, options: PutServerConfigurationOptions = {}): Promise<void> {
    await this.request('PUT', '/server/configuration', {
      query: { deploy: options.deploy, overwriteConfigMap: options.overwriteConfigMap },
      headers: { 'Content-Type': 'application/xml', Accept: 'application/json' },
      body: xml,
    });
  }

  // --- per-resource ---------------------------------------------------------
  // Override is on: Mirth does not reject a stale revision anyway (verified on
  // 4.5.2), so conflict detection happens in the push planner instead.

  async getChannel(id: string): Promise<Record<string, unknown> | null> {
    const response = await this.request('GET', `/channels/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    if (text.trim() === '') return null;
    return unwrapSingleKey(JSON.parse(text) as Record<string, unknown>) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async putChannel(channel: Record<string, unknown>): Promise<void> {
    await this.sendJson('PUT', `/channels/${encodeURIComponent(String(channel.id))}`, { channel }, { override: true });
  }

  async deleteChannel(id: string): Promise<void> {
    await this.request('DELETE', `/channels/${encodeURIComponent(id)}`);
  }

  async putCodeTemplate(template: Record<string, unknown>): Promise<void> {
    await this.sendJson('PUT', `/codeTemplates/${encodeURIComponent(String(template.id))}`, { codeTemplate: template }, { override: true });
  }

  async deleteCodeTemplate(id: string): Promise<void> {
    await this.request('DELETE', `/codeTemplates/${encodeURIComponent(id)}`);
  }

  async putCodeTemplateLibraries(libraries: Record<string, unknown>[]): Promise<void> {
    await this.sendJson('PUT', '/codeTemplateLibraries', { list: { codeTemplateLibrary: libraries } }, { override: true });
  }

  async putGlobalScripts(globalScripts: unknown): Promise<void> {
    await this.sendJson('PUT', '/server/globalScripts', { map: globalScripts });
  }

  async getDeployedChannelIds(): Promise<Set<string>> {
    const response = await this.request('GET', '/channels/statuses', { headers: { Accept: 'application/json' } });
    const text = await response.text();
    const ids = new Set<string>();
    // Undeployed channels have no status entry; collect every channelId present.
    for (const m of text.matchAll(/"channelId"\s*:\s*"([^"]+)"/g)) ids.add(m[1]!);
    return ids;
  }

  async deployChannel(id: string): Promise<void> {
    await this.request('POST', `/channels/${encodeURIComponent(id)}/_deploy`, { query: { returnErrors: true } });
  }

  /** Send a JSON body; Mirth answers some updates with `{"boolean": false}` instead of an error status. */
  private async sendJson(method: HttpMethod, path: string, body: unknown, query?: Record<string, unknown>): Promise<void> {
    const response = await this.request(method, path, {
      query,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (/^\s*\{\s*"boolean"\s*:\s*false\s*\}\s*$/.test(text)) {
      throw new Error(`${method} ${path}: the server refused the update`);
    }
  }

  // --- internal transport ---------------------------------------------------

  /**
   * Make an authenticated request. Ensures login, attaches/stores cookies, and
   * on a 401 while authenticated resets auth, re-logs in once, and retries.
   * Throws an {@link ApiError}-shaped error on a non-2xx response.
   */
  private async request(method: HttpMethod, path: string, options: RequestOptions = {}, isRetry = false): Promise<Response> {
    if (!this.authenticated) {
      await this.login();
    }

    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      'X-Requested-With': 'XMLHttpRequest',
      ...options.headers,
    };

    const cookieString = await this.cookieJar.getCookieString(url);
    if (cookieString) {
      headers.Cookie = cookieString;
    }

    const response = await this.send(url, { method, headers, body: options.body });

    await this.storeCookies(response, url);

    // 401 while authenticated -> reset auth, re-login once, retry exactly once.
    if (response.status === 401 && this.authenticated && !isRetry) {
      this.authenticated = false;
      await this.login();
      return this.request(method, path, options, true);
    }

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    return response;
  }

  /** fetch through this client's pool, with network failures explained. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        // @ts-expect-error - dispatcher is a Node.js/undici specific option
        dispatcher: this.dispatcher,
      });
    } catch (err) {
      throw connectionError(url, err);
    }
  }

  /** Build an absolute URL with an optional query string. */
  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = `${this.baseUrl}${path}`;
    if (!query || Object.keys(query).length === 0) {
      return url;
    }

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      searchParams.append(key, String(value));
    }

    const qs = searchParams.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /** Persist any `set-cookie` from a response into the jar. */
  private async storeCookies(response: Response, url: string): Promise<void> {
    // One entry per header: get('set-cookie') joins them with ", ", which also
    // appears inside a cookie's Expires date.
    for (const cookie of response.headers.getSetCookie()) {
      await this.cookieJar.setCookie(cookie, url);
    }
  }

  /** Build an ApiError-shaped Error from a non-2xx response. */
  private async toApiError(response: Response): Promise<Error & ApiError> {
    let body: unknown;
    try {
      body = await response.text();
    } catch {
      // ignore body read errors
    }

    // An error body can echo the payload sent, credentials included, in any
    // form (escaped, truncated, reformatted), so no redaction of it is
    // complete: it is left out unless asked for. When included it is whole and
    // unnormalized, so the caller's scrub of known values can still match.
    const text = typeof body === 'string' ? redactSecretsInText(readableBody(body)).trim() : '';
    const reason =
      text === '' ? '' : this.config.includeResponseBodies ? `: ${text}` : ' (server response withheld; it may echo credentials)';
    const message = `HTTP ${response.status}: ${response.statusText}${reason}`;
    const error = new Error(message) as Error & ApiError;
    error.status = response.status;
    error.statusText = response.statusText;
    error.message = message;
    error.body = text;
    return error;
  }
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * An error body as the text a person reads: JSON as its decoded values, XML as
 * its decoded text. Anything that redacts by value (the CLI knows the secrets
 * sent) then sees a secret as it was sent, not escaped as `\"` or `&amp;`.
 * Credential fields are replaced while their names are still known.
 */
export function readableBody(body: string): string {
  const trimmed = body.trim();
  // Any JSON value: a bare string can carry \u escapes too.
  if (/^[[{"]/.test(trimmed)) {
    try {
      return flattenJson(JSON.parse(trimmed) as unknown);
    } catch {
      // not JSON after all
    }
  }
  if (!trimmed.startsWith('<')) return trimmed;
  // Mirth's HTML error pages say only "Request failed.", so they add nothing.
  if (/^<(!doctype|html)/i.test(trimmed)) return '';
  // A marker that survives removing the tags.
  const REDACTED = '\u0000redacted\u0000';
  return trimmed
    .replace(/<([\w.:-]+)>[^<]*<\/\1>/g, (whole, key: string) => (isSecretKey(key) ? ` ${key}: ${REDACTED} ` : whole))
    .replace(/<[^>]*>/g, ' ')
    .split(REDACTED)
    .join('<redacted>')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, e: string) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : (XML_ENTITIES[e.toLowerCase()] ?? whole),
    );
}

function flattenJson(value: unknown, key = ''): string {
  if (typeof value === 'string') return key !== '' && isSecretKey(key) && value !== '' ? '<redacted>' : value;
  if (Array.isArray(value)) return value.map((v) => flattenJson(v, key)).join('; ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${flattenJson(v, k)}`).join(', ');
  }
  return String(value);
}

/**
 * Factory for the live Mirth transport client.
 */
export function createMirthClient(config: ClientConfig): MirthClientExt {
  return new MirthClientImpl(config);
}
