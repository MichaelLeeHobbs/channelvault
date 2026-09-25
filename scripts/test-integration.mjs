/* global fetch, AbortSignal */
import { execFileSync, spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from 'undici';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const composeArgs = ['compose', '-p', `channelvault-test-${randomUUID()}`, '-f', 'docker-compose.test.yml'];
const compose = (...args) => execFileSync('docker', [...composeArgs, ...args], { cwd, encoding: 'utf8', timeout: 180_000 });
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
let stopping = false;
let child;
const cleanup = () => {
  if (!stopping) {
    stopping = true;
    compose('down', '--volumes', '--remove-orphans');
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child?.kill(); cleanup(); process.exit(1); });

async function ready(port) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`https://127.0.0.1:${port}/api/server/version`, {
        dispatcher, headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(3000),
      });
      await response.text();
      if (response.ok || response.status === 401) return;
    } catch { /* the server is still starting */ }
    await delay(1000);
  }
  throw new Error(`Disposable Mirth server on port ${port} did not become ready`);
}

try {
  compose('up', '-d');
  const port = service => compose('port', service, '8443').trim().split(':').at(-1);
  const [source, target] = [port('source'), port('target')];
  console.log(`Waiting for disposable Mirth servers on localhost:${source} and localhost:${target}`);
  await Promise.all([ready(source), ready(target)]);
  child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/integration/promotion.test.ts'], {
    cwd, stdio: 'inherit', env: { ...process.env, CHANNELVAULT_INTEGRATION: '1', CHANNELVAULT_SOURCE_PORT: source, CHANNELVAULT_TARGET_PORT: target },
  });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (status !== 0) throw new Error(`Live integration tests failed (exit ${status})`);
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  try { console.error(compose('logs', '--no-color', '--tail', '80')); } catch { /* Docker may be unavailable */ }
} finally {
  await dispatcher.close();
  cleanup();
}
