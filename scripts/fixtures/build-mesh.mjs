/* global fetch, AbortSignal */
/**
 * Builds test/fixtures/serverConfiguration.mesh.xml: generates the synthetic
 * mesh configuration, loads it into a disposable Mirth 4.5.2 (every host in it
 * is example.org), deploys every channel (a channel Mirth cannot deploy is not a
 * realistic fixture), and saves Mirth's own export.
 *
 *   node scripts/fixtures/build-mesh.mjs            # own disposable server
 *   node scripts/fixtures/build-mesh.mjs --port N   # a disposable server you run
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { Agent } from 'undici';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const out = path.join(cwd, 'test', 'fixtures', 'serverConfiguration.mesh.xml');
const portArg = process.argv.indexOf('--port');
const ownServer = portArg < 0;
const project = `channelvault-mesh-${randomUUID()}`;
const compose = (...args) => execFileSync('docker', ['compose', '-p', project, '-f', 'docker-compose.test.yml', ...args], { cwd, encoding: 'utf8', timeout: 180_000 });
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const h = { 'X-Requested-With': 'XMLHttpRequest' };

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), 'channelvault-mesh-'));
  try {
    const input = path.join(work, 'mesh.input.xml');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/fixtures/generate-mesh.ts', input], { cwd, stdio: 'inherit' });

    let port = ownServer ? undefined : process.argv[portArg + 1];
    if (ownServer) {
      compose('up', '-d', 'source');
      port = compose('port', 'source', '8443').trim().split(':').at(-1);
    }
    const base = `https://127.0.0.1:${port}/api`;
    for (let i = 0; ; i++) {
      try { const r = await fetch(`${base}/server/version`, { dispatcher, headers: h, signal: AbortSignal.timeout(3000) }); if (r.status === 200 || r.status === 401) break; } catch { /* starting */ }
      if (i > 90) throw new Error('Mirth did not become ready');
      await delay(2000);
    }
    const login = await fetch(`${base}/users/_login`, { method: 'POST', dispatcher, headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin' });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const call = (method, p, init = {}) => fetch(`${base}${p}`, { method, dispatcher, ...init, headers: { ...h, Cookie: cookie, ...(init.headers ?? {}) } });

    // A channel still deployed from an earlier run would hold its listener's port.
    const undeployAll = async () => {
      const deployed = [...(await (await call('GET', '/channels/statuses', { headers: { Accept: 'application/json' } })).text()).matchAll(/"channelId"s*:s*"([^"]+)"/g)].map((m) => m[1]);
      if (deployed.length) await call('POST', '/channels/_undeploy?returnErrors=true', { body: JSON.stringify({ set: { string: deployed } }), headers: { 'Content-Type': 'application/json' } });
    };
    await undeployAll();
    const imported = await call('PUT', '/server/configuration?deploy=false&overwriteConfigMap=true', { body: await readFile(input, 'utf8'), headers: { 'Content-Type': 'application/xml' } });
    if (!imported.ok) throw new Error(`import failed: HTTP ${imported.status} ${await imported.text()}`);

    // Every channel must deploy.
    const ids = [...(await (await call('GET', '/channels/idsAndNames', { headers: { Accept: 'application/json' } })).text()).matchAll(/"string":\s*\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
    const failures = [];
    for (const [id, name] of ids) {
      const r = await call('POST', `/channels/${id}/_deploy?returnErrors=true`);
      if (!r.ok) failures.push(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
    console.log(`deployed ${ids.length - failures.length} of ${ids.length} channels`);
    if (failures.length) throw new Error(`channels failed to deploy:\n  ${failures.join('\n  ')}`);

    const exported = await (await call('GET', '/server/configuration', { headers: { Accept: 'application/xml' } })).text();
    await writeFile(out, exported);
    console.log(`wrote ${out} (${exported.length} bytes)`);
  } finally {
    await rm(work, { recursive: true, force: true });
    await dispatcher.close();
    if (ownServer) compose('down', '--volumes', '--remove-orphans');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
