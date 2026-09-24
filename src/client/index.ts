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
import type { ApiError, CanonicalConfig, ClientConfig, MirthClient } from '../types.js';

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
  private readonly dispatcher?: Agent;

  private authenticated = false;
  /** Single in-flight login promise (concurrency guard). */
  private loginPromise: Promise<void> | null = null;

  constructor(config: ClientConfig) {
    this.config = config;
    const protocol = config.https !== false ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}/api`;
    this.cookieJar = new CookieJar();

    if (config.disableTlsCheck) {
      this.dispatcher = new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    }
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

        const response = await fetch(loginUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
          },
          body: body.toString(),
          // @ts-expect-error - dispatcher is a Node.js/undici specific option
          dispatcher: this.dispatcher,
        });

        await this.storeCookies(response, this.baseUrl);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Login failed: HTTP ${response.status} - ${text.substring(0, 200)}`);
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
      await fetch(logoutUrl, {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookieString ? { Cookie: cookieString } : {}),
        },
        // @ts-expect-error - dispatcher is a Node.js/undici specific option
        dispatcher: this.dispatcher,
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

    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      // @ts-expect-error - dispatcher is a Node.js/undici specific option
      dispatcher: this.dispatcher,
    });

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
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      await this.cookieJar.setCookie(setCookieHeader, url);
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

    const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & ApiError;
    error.status = response.status;
    error.statusText = response.statusText;
    error.message = `HTTP ${response.status}: ${response.statusText}`;
    error.body = body;
    return error;
  }
}

/**
 * Factory for the live Mirth transport client.
 */
export function createMirthClient(config: ClientConfig): MirthClientExt {
  return new MirthClientImpl(config);
}
