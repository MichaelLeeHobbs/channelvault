import { homedir } from 'node:os';
import * as path from 'node:path';

/** channelvault's user-level folder, outside every repository and worktree: `CHANNELVAULT_CONFIG_DIR`, else `~/.channelvault`. */
export function configDir(): string {
  const override = process.env.CHANNELVAULT_CONFIG_DIR;
  return override ? path.resolve(override) : path.join(homedir(), '.channelvault');
}
