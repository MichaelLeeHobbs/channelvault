import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
export interface CliResult { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

export function startCli(args: string[], env: NodeJS.ProcessEnv = {}, terminal = false) {
  const runtime = terminal ? ['--require', fileURLToPath(new URL('./terminal.cjs', import.meta.url))] : [];
  const child = spawn(process.execPath, [...runtime, '--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const finished = new Promise<CliResult>((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  // Bound a hung child independently of Vitest's timeout so failed tests do not
  // leave background CLI processes behind.
  const timeout = setTimeout(() => child.kill(), 30_000);
  void finished.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  return {
    child, finished,
    async waitFor(text: string): Promise<void> {
      if (stdout.includes(text)) return;
      await new Promise<void>((resolve, reject) => {
        const onData = () => { if (stdout.includes(text)) { cleanup(); resolve(); } };
        const onClose = () => { cleanup(); reject(new Error(`CLI exited before ${text}: ${stdout}\n${stderr}`)); };
        const cleanup = () => { child.stdout.off('data', onData); child.off('close', onClose); };
        child.stdout.on('data', onData);
        child.once('close', onClose);
      });
    },
  };
}

export function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const running = startCli(args, env);
  running.child.stdin.end();
  return running.finished;
}
