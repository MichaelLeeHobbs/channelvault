import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Child CLI processes inherit this, so no test reads or writes the developer's real ~/.channelvault.
process.env.CHANNELVAULT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'channelvault-config-'));
