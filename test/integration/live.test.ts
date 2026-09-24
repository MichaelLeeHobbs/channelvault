/**
 * Live integration test against a running Mirth server.
 *
 * Skipped unless `MIRTH_HOST` is set AND the server answers. Bring one up with:
 *   docker compose up -d
 *   MIRTH_HOST=localhost MIRTH_PORT=8443 MIRTH_USER=admin MIRTH_PASS=admin pnpm test
 *
 * Exercises the real transport: login -> GET/PUT /server/configuration -> the
 * explode/implode round-trip on whatever config the server currently holds.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMirthClient, type MirthClientExt } from '../../src/client/index.js';
import { createExplodeEngine } from '../../src/explode/index.js';
import { channelsOf, findChannel, planPush } from '../../src/push/index.js';
import { applyPlan } from '../../src/push/apply.js';
import type { ClientConfig } from '../../src/types.js';

const HOST = process.env.MIRTH_HOST;
const cfg: ClientConfig = {
  host: HOST ?? 'localhost',
  port: Number(process.env.MIRTH_PORT ?? '8443'),
  username: process.env.MIRTH_USER ?? 'admin',
  password: process.env.MIRTH_PASS ?? 'admin',
  https: process.env.MIRTH_HTTPS !== 'false',
  disableTlsCheck: process.env.MIRTH_INSECURE !== 'false',
};

async function reachable(): Promise<boolean> {
  if (!HOST) return false;
  // Allow self-signed certs for the reachability probe.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const proto = cfg.https === false ? 'http' : 'https';
    const r = await fetch(`${proto}://${cfg.host}:${cfg.port}/api/server/version`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return r.status > 0 && r.status < 500;
  } catch {
    return false;
  }
}

const live = await reachable();
const maybe = live ? describe : describe.skip;

maybe('live Mirth server', () => {
  let client: MirthClientExt;
  const engine = createExplodeEngine();
  let work: string;

  // Whole-server GET/PUT of a real config can take many seconds.
  const SERVER_TIMEOUT = 60_000;

  beforeAll(async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    client = createMirthClient(cfg);
    await client.login();
    work = await mkdtemp(path.join(tmpdir(), 'channelvault-live-'));
  }, SERVER_TIMEOUT);
  afterAll(async () => {
    await client?.logout().catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('logs in', () => {
    expect(client.isAuthenticated()).toBe(true);
  });

  it('pulls the server configuration and round-trips it through explode/implode', async () => {
    const remote = await client.getServerConfiguration();
    expect(remote).toBeTypeOf('object');

    await engine.explode(remote, { root: work });
    const imploded = await engine.implode({ root: work });
    expect(imploded).toEqual(remote);
  }, SERVER_TIMEOUT);

  it(
    'accepts an identity push of the current configuration',
    async () => {
      const remote = await client.getServerConfiguration();
      await expect(
        client.putServerConfiguration(remote, { deploy: false, overwriteConfigMap: false }),
      ).resolves.toBeUndefined();
    },
    SERVER_TIMEOUT,
  );

  it(
    'scoped push changes one channel script, keeps its tags, and then has nothing left to push',
    async () => {
      const remote = await client.getServerConfiguration();
      // Use a tagged channel, or the tag assertion below would compare nothing.
      let id: string | undefined;
      let tagsBefore: unknown;
      for (const c of channelsOf(remote)) {
        const tags = ((await client.getChannel(String(c['id'])))?.['exportData'] as Record<string, unknown>)['channelTags'];
        if (tags) {
          id = String(c['id']);
          tagsBefore = tags;
          break;
        }
      }
      if (!id) throw new Error('no tagged channel on the live server; load test/fixtures/serverConfiguration.sample.xml');

      const local = structuredClone(remote);
      const original = findChannel(local, id)!['deployScript'];
      findChannel(local, id)!['deployScript'] = `// channelvault live test\n${String(original)}`;
      try {
        const plan = planPush(local, remote);
        expect(plan.changes.map((c) => `${c.op} ${c.id}`)).toEqual([`update ${id}`]);
        const result = await applyPlan(client, plan, local, remote, {});
        expect(result.failed).toBeUndefined();

        const after = await client.getServerConfiguration();
        expect(findChannel(after, id)!['deployScript']).toBe(findChannel(local, id)!['deployScript']);
        expect(planPush(local, after).changes).toEqual([]);
        expect(((await client.getChannel(id))?.['exportData'] as Record<string, unknown>)['channelTags']).toEqual(tagsBefore);
      } finally {
        // The full GET copy carries the tags; the server-configuration copy would drop them.
        const restore = (await client.getChannel(id))!;
        restore['deployScript'] = original!;
        await client.putChannel(restore);
      }
    },
    SERVER_TIMEOUT,
  );
});
