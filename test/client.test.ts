import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMirthClient } from '../src/client/index.js';
import type { ClientConfig } from '../src/types.js';

const CONFIG: ClientConfig = {
  host: 'mirth.example.com',
  port: 8443,
  username: 'admin',
  password: 's3cret',
  https: true,
};

const BASE = 'https://mirth.example.com:8443/api';

/** Build a JSON Response with a default set-cookie header. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json', ...(init.headers as Record<string, string>) });
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

const LOGIN_SUCCESS = {
  'com.mirth.connect.model.LoginStatus': { status: 'SUCCESS', message: null },
};

/** A successful login response carrying a session cookie. */
function loginResponse(): Response {
  return jsonResponse(LOGIN_SUCCESS, { headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/' } });
}

type FetchCall = [string, RequestInit & { headers: Record<string, string> }];

let fetchMock: ReturnType<typeof vi.fn>;

/** Typed accessor for a recorded fetch call (avoids noUncheckedIndexedAccess noise). */
function call(i: number): FetchCall {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`no fetch call at index ${i}`);
  return c as unknown as FetchCall;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createMirthClient', () => {
  it('constructs with disableTlsCheck without throwing', () => {
    expect(() => createMirthClient({ ...CONFIG, disableTlsCheck: true })).not.toThrow();
  });

  describe('login()', () => {
    it('posts form-encoded creds to /api/users/_login and parses wrapped LoginStatus', async () => {
      fetchMock.mockResolvedValueOnce(loginResponse());

      const client = createMirthClient(CONFIG);
      expect(client.isAuthenticated()).toBe(false);

      await client.login();

      expect(client.isAuthenticated()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = call(0);
      expect(url).toBe(`${BASE}/users/_login`);
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
      expect(init.headers.Accept).toBe('application/json');

      // body is a URLSearchParams string with username + password
      const params = new URLSearchParams(init.body as string);
      expect(params.get('username')).toBe('admin');
      expect(params.get('password')).toBe('s3cret');
    });

    it('throws when status is not SUCCESS', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ 'com.mirth.connect.model.LoginStatus': { status: 'FAIL', message: 'bad creds' } }),
      );

      const client = createMirthClient(CONFIG);
      await expect(client.login()).rejects.toThrow(/bad creds/);
      expect(client.isAuthenticated()).toBe(false);
    });

    it('does not put the response body in a login failure', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<echo>username=admin&password=s3cret</echo>', { status: 500, statusText: 'Server Error' }));

      const client = createMirthClient(CONFIG);
      const error = await client.login().then(() => undefined, (err: unknown) => err as Error);
      expect(error?.message).toBe('Login failed: HTTP 500 Server Error');
    });

    it('keeps every cookie when the server sets several', async () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'JSESSIONID=abc123; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT');
      headers.append('set-cookie', 'ROUTEID=node2; Path=/');
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_SUCCESS), { headers }))
        .mockResolvedValueOnce(jsonResponse({ serverConfiguration: {} }));

      await createMirthClient(CONFIG).getServerConfiguration();
      expect(call(1)[1].headers.Cookie).toBe('JSESSIONID=abc123; ROUTEID=node2');
    });

    it('shares a single in-flight login promise (singleflight)', async () => {
      fetchMock.mockResolvedValueOnce(loginResponse());

      const client = createMirthClient(CONFIG);
      await Promise.all([client.login(), client.login()]);

      // both awaits resolved off a single network login
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getServerConfiguration()', () => {
    it('auto-logs in then GETs /api/server/configuration and unwraps the wrapper', async () => {
      const inner = { date: '123', channels: { channel: [] }, '@version': '4.4.0' };
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(jsonResponse({ serverConfiguration: inner }));

      const client = createMirthClient(CONFIG);
      const cfg = await client.getServerConfiguration();

      expect(cfg).toEqual(inner);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [loginUrl] = call(0);
      expect(loginUrl).toBe(`${BASE}/users/_login`);

      const [getUrl, getInit] = call(1);
      expect(getUrl).toBe(`${BASE}/server/configuration`);
      expect(getInit.method).toBe('GET');
      expect(getInit.headers.Accept).toBe('application/json');
      // session cookie attached from login
      expect(getInit.headers.Cookie).toContain('JSESSIONID=abc123');
    });

    it('returns the object as-is when there is no single-key wrapper', async () => {
      const multi = { a: '1', b: '2' };
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(jsonResponse(multi));

      const client = createMirthClient(CONFIG);
      const cfg = await client.getServerConfiguration();
      expect(cfg).toEqual(multi);
    });
  });

  describe('putServerConfiguration()', () => {
    it('PUTs wrapped body to /api/server/configuration?deploy=true', async () => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const cfg = { channels: { channel: [] }, '@version': '4.4.0' };
      const client = createMirthClient(CONFIG);
      await client.putServerConfiguration(cfg, { deploy: true });

      const [putUrl, putInit] = call(1);
      expect(putUrl).toBe(`${BASE}/server/configuration?deploy=true`);
      expect(putInit.method).toBe('PUT');
      expect(putInit.headers['Content-Type']).toBe('application/json');

      const sentBody = JSON.parse(putInit.body as string);
      expect(sentBody).toEqual({ serverConfiguration: cfg });
    });

    it('passes both deploy and overwriteConfigMap query params', async () => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = createMirthClient(CONFIG);
      await client.putServerConfiguration({ x: '1' }, { deploy: false, overwriteConfigMap: true });

      const [putUrl] = call(1);
      const parsed = new URL(putUrl);
      expect(parsed.searchParams.get('deploy')).toBe('false');
      expect(parsed.searchParams.get('overwriteConfigMap')).toBe('true');
    });

    it('throws an ApiError-shaped error on non-2xx', async () => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Server Error' }));

      const client = createMirthClient(CONFIG);
      await expect(client.putServerConfiguration({ x: '1' })).rejects.toMatchObject({
        status: 500,
        statusText: 'Server Error',
        body: 'boom',
      });
    });

    it("puts a plain-text reason in the message, but not an HTML error page", async () => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response('Script compile error\n at line 3', { status: 500, statusText: 'Server Error' }))
        .mockResolvedValueOnce(new Response('<html><body>Request failed.</body></html>', { status: 500, statusText: 'Server Error' }));

      const client = createMirthClient(CONFIG);
      await expect(client.deployChannel('c1')).rejects.toThrow('HTTP 500: Server Error: Script compile error at line 3');
      await expect(client.deployChannel('c1')).rejects.toThrow(/^HTTP 500: Server Error$/);
    });

    it.each([
      ['JSON', '{"error":"invalid","passcode":"fixture-924","host":"pacs"}', 'error: invalid, passcode: <redacted>, host: pacs'],
      ['XML', '<error><keyStorePW>fixture-924</keyStorePW><host>pacs</host></error>', 'keyStorePW: <redacted> pacs'],
    ])('redacts a credential field echoed in a %s error body', async (_format, body, expected) => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response(body, { status: 400, statusText: 'Bad Request' }));

      const error = await createMirthClient(CONFIG).deployChannel('c1').then(() => undefined, (err: unknown) => err as Error);
      expect(error?.message).toContain(expected);
      expect(error?.message).toContain('pacs');
      expect(JSON.stringify(error)).not.toContain('fixture-924');
    });

    it('redacts a secret the error body echoes', async () => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response('invalid url jdbc:x://db;user=svc;password=hunter22x;ssl=true', { status: 500, statusText: 'Server Error' }));

      const error = await createMirthClient(CONFIG).deployChannel('c1').then(() => undefined, (err: unknown) => err as Error & { body?: unknown });
      expect(error?.message).toContain('password=<redacted connection-string>;ssl=true');
      expect(JSON.stringify(error)).not.toContain('hunter22x');
    });
  });

  describe('401 re-auth', () => {
    it('triggers exactly one re-login + retry on a 401 after auth', async () => {
      const inner = { ok: 'yes' };
      fetchMock
        .mockResolvedValueOnce(loginResponse()) // initial login
        .mockResolvedValueOnce(new Response(null, { status: 401 })) // GET -> 401
        .mockResolvedValueOnce(loginResponse()) // re-login
        .mockResolvedValueOnce(jsonResponse({ serverConfiguration: inner })); // retry GET

      const client = createMirthClient(CONFIG);
      const cfg = await client.getServerConfiguration();

      expect(cfg).toEqual(inner);
      // login, get(401), re-login, get(retry) = 4 calls
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(call(0)[0]).toBe(`${BASE}/users/_login`);
      expect(call(2)[0]).toBe(`${BASE}/users/_login`);
      expect(call(3)[0]).toBe(`${BASE}/server/configuration`);
      expect(client.isAuthenticated()).toBe(true);
    });
  });

  describe('logout()', () => {
    it('POSTs to /api/users/_logout and clears auth state', async () => {
      fetchMock
        .mockResolvedValueOnce(loginResponse())
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = createMirthClient(CONFIG);
      await client.login();
      expect(client.isAuthenticated()).toBe(true);

      await client.logout();
      expect(client.isAuthenticated()).toBe(false);

      const [logoutUrl, logoutInit] = call(1);
      expect(logoutUrl).toBe(`${BASE}/users/_logout`);
      expect(logoutInit.method).toBe('POST');
    });

    it('is a no-op when not authenticated', async () => {
      const client = createMirthClient(CONFIG);
      await client.logout();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
