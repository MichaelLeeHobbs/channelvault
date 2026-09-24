import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import type { CanonicalConfig } from '../src/types.js';

const engine = createExplodeEngine();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mirth-explode-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const MULTILINE_SCRIPT = `// transformer step 1
var msg = connectorMessage;
if (msg != null) {
\tlogger.info("special chars: <>&\\"'|*?:");
    var x = {
        a: 1,
        b: "line\\nwith\\tescapes",
    };
}
return x;`;

const MULTILINE_SCRIPT_2 = `
   // leading whitespace + blank first line
   function transform() {
       return 42;
   }
`;

function makeFullConfig(): CanonicalConfig {
  return {
    '@_version': '4.4.0',
    date: '2026-06-16T00:00:00.000Z',
    serverSettings: {
      environmentName: 'prod',
      serverName: 'mirth-1',
    },
    globalScripts: {
      entry: [
        { string: ['Deploy', 'globalDeploy'], 'com.mirth.connect.model.GlobalScript': null },
      ],
    },
    channels: {
      channel: [
        {
          id: 'chan-1',
          name: 'Inbound ADT',
          preprocessingScript: 'return message;',
          deployScript: MULTILINE_SCRIPT_2,
          postprocessingScript: '   ', // whitespace-only -> stays inline
          sourceConnector: {
            name: 'sourceConnector',
            transformer: {
              elements: [
                {
                  '@class': 'com.mirth.connect.plugins.javascriptstep.JavaScriptStep',
                  name: 'Map fields',
                  sequenceNumber: '0',
                  script: MULTILINE_SCRIPT,
                },
                {
                  '@class': 'com.mirth.connect.plugins.javascriptstep.JavaScriptStep',
                  name: 'Set destination',
                  sequenceNumber: '1',
                  script: 'channelMap.put("k", "v");',
                },
              ],
            },
            filter: {
              elements: [
                {
                  name: 'Drop empties',
                  sequenceNumber: '0',
                  script: 'return msg != null;',
                },
              ],
            },
          },
          destinationConnectors: {
            connector: [
              {
                name: 'DB Writer',
                transformer: {
                  elements: {
                    name: 'Format row',
                    sequenceNumber: '0',
                    script: 'return row;',
                  },
                },
              },
            ],
          },
        },
        {
          id: 'chan-2',
          name: 'Outbound ORM',
          preprocessingScript: '', // empty -> stays inline
          sourceConnector: {
            name: 'sourceConnector',
            transformer: {
              elements: [
                {
                  name: 'Step A',
                  sequenceNumber: '0',
                  script: 'var a = 1;\nreturn a;',
                },
                {
                  name: 'Step B',
                  sequenceNumber: '1',
                  script: 'var b = 2;\n\treturn b;',
                },
              ],
            },
          },
        },
      ],
    },
    codeTemplateLibraries: {
      codeTemplateLibrary: [
        {
          id: 'lib-1',
          name: 'Shared Utils',
          codeTemplates: {
            codeTemplate: [
              { id: 'ct-1', name: 'parseDate', code: 'function parseDate(s){ return s; }' },
              { id: 'ct-2', name: 'formatName', code: 'function formatName(n){\n  return n.trim();\n}' },
            ],
          },
        },
      ],
    },
    channelGroups: {
      channelGroup: [
        { id: 'grp-1', name: 'ADT Group', channels: { channel: [{ id: 'chan-1' }] } },
        { id: 'grp-2', name: 'ORM Group' },
      ],
    },
  };
}

describe('explode/implode round-trip', () => {
  it('round-trips a full multi-channel config byte-identically', async () => {
    const original = makeFullConfig();
    const snapshot = structuredClone(original);

    await engine.explode(original, { root });
    const imploded = await engine.implode({ root });

    expect(imploded).toEqual(snapshot);
    // input not mutated
    expect(original).toEqual(snapshot);
  });

  it('writes friendly transformer step files with exact contents', async () => {
    const original = makeFullConfig();
    await engine.explode(original, { root });

    const stepFile = path.join(
      root,
      'channels',
      'Inbound-ADT',
      'source',
      'transformer',
      '1.Map-fields.js',
    );
    expect(await exists(stepFile)).toBe(true);
    expect(await readFile(stepFile, 'utf8')).toBe(MULTILINE_SCRIPT);

    const step2 = path.join(
      root,
      'channels',
      'Inbound-ADT',
      'source',
      'transformer',
      '2.Set-destination.js',
    );
    expect(await readFile(step2, 'utf8')).toBe('channelMap.put("k", "v");');

    // channel-level deploy script -> scripts/deploy.js
    const deploy = path.join(root, 'channels', 'Inbound-ADT', 'scripts', 'deploy.js');
    expect(await readFile(deploy, 'utf8')).toBe(MULTILINE_SCRIPT_2);

    // filter rule
    const filter = path.join(root, 'channels', 'Inbound-ADT', 'source', 'filter', '1.Drop-empties.js');
    expect(await readFile(filter, 'utf8')).toBe('return msg != null;');

    // destination connector transformer
    const destStep = path.join(
      root,
      'channels',
      'Inbound-ADT',
      'destinations',
      'DB-Writer',
      'transformer',
      '1.Format-row.js',
    );
    expect(await readFile(destStep, 'utf8')).toBe('return row;');

    // code template code next to library.json
    const ct = path.join(root, 'codeTemplates', 'Shared-Utils', 'parseDate.js');
    expect(await readFile(ct, 'utf8')).toBe('function parseDate(s){ return s; }');

    // configuration.json skeleton exists
    expect(await exists(path.join(root, 'server', 'configuration.json'))).toBe(true);
    // channelGroup split-out json exists
    expect(await exists(path.join(root, 'channelGroups', 'ADT-Group.json'))).toBe(true);
  });

  it('does NOT create files for empty / whitespace-only scripts', async () => {
    const original = makeFullConfig();
    await engine.explode(original, { root });

    // chan-2 preprocessingScript was '' -> no scripts/preprocessor.js under Outbound-ORM
    const pp = path.join(root, 'channels', 'Outbound-ORM', 'scripts', 'preprocessor.js');
    expect(await exists(pp)).toBe(false);

    // chan-1 postprocessingScript was whitespace-only -> no file
    const post = path.join(root, 'channels', 'Inbound-ADT', 'scripts', 'postprocessor.js');
    expect(await exists(post)).toBe(false);

    // and they round-trip as inline strings
    const imploded = await engine.implode({ root });
    const channels = imploded.channels as { channel: Array<Record<string, unknown>> };
    expect(channels.channel[1]!.preprocessingScript).toBe('');
    expect(channels.channel[0]!.postprocessingScript).toBe('   ');
  });

  it('handles single-channel object (not array) via coercion', async () => {
    const original: CanonicalConfig = {
      '@_version': '4.4.0',
      channels: {
        channel: {
          id: 'solo',
          name: 'Solo Channel',
          deployScript: 'return 1;',
          sourceConnector: {
            name: 'sourceConnector',
            transformer: {
              elements: {
                name: 'Only step',
                sequenceNumber: '0',
                script: 'return doThing();',
              },
            },
          },
        },
      },
    };
    const snapshot = structuredClone(original);

    await engine.explode(original, { root });
    const imploded = await engine.implode({ root });
    expect(imploded).toEqual(snapshot);

    // single object preserved (not turned into array)
    expect(Array.isArray((imploded.channels as Record<string, unknown>).channel)).toBe(false);

    const stepFile = path.join(
      root,
      'channels',
      'Solo-Channel',
      'source',
      'transformer',
      '1.Only-step.js',
    );
    expect(await readFile(stepFile, 'utf8')).toBe('return doThing();');
  });

  it('handles slug collisions deterministically', async () => {
    const original: CanonicalConfig = {
      channels: {
        channel: [
          { id: 'a', name: 'Same Name', deployScript: 'return "a";' },
          { id: 'b', name: 'Same Name', deployScript: 'return "b";' },
          { id: 'c', name: 'Same/Name', deployScript: 'return "c";' },
        ],
      },
    };
    const snapshot = structuredClone(original);

    await engine.explode(original, { root });
    const imploded = await engine.implode({ root });
    expect(imploded).toEqual(snapshot);

    expect(await exists(path.join(root, 'channels', 'Same-Name'))).toBe(true);
    expect(await exists(path.join(root, 'channels', 'Same-Name-2'))).toBe(true);
    expect(await exists(path.join(root, 'channels', 'Same-Name-3'))).toBe(true);
  });

  it('survives unknown/variant structures (BridgeLink-style) without crashing', async () => {
    const original: CanonicalConfig = {
      '@_version': '9.9.0-bridgelink',
      someUnknownTopLevel: {
        weird: {
          nested: [
            { script: 'var keep = 1;', other: 'data' },
            { code: 'var alsoKeep = 2;' },
            { script: '' }, // empty stays inline
          ],
        },
        objectValuedCode: {
          // code field that is an OBJECT (Mirth base64 wrap) -> must stay inline
          script: { '@encoding': 'base64', '#text': 'cmV0dXJuIDE7' },
        },
      },
      channels: { channel: [] },
    };
    const snapshot = structuredClone(original);

    await engine.explode(original, { root });
    const imploded = await engine.implode({ root });
    expect(imploded).toEqual(snapshot);
  });
});

describe('implode marker containment (path traversal)', () => {
  /** Write a minimal tree whose configuration.json carries one marker. */
  async function writeTreeWithMarker(marker: Record<string, string>): Promise<void> {
    await mkdir(path.join(root, 'server'), { recursive: true });
    const config = { '@_version': '4.4.0', payload: marker };
    await writeFile(
      path.join(root, 'server', 'configuration.json'),
      JSON.stringify(config),
      'utf8',
    );
  }

  it('rejects an @file marker that escapes the working tree via ..', async () => {
    await writeTreeWithMarker({ '@file': '../../../../../../etc/passwd' });
    await expect(engine.implode({ root })).rejects.toThrow(/escapes the working tree/);
  });

  it('rejects an absolute @file marker', async () => {
    // An absolute path resolves outside the tree regardless of jsonDir.
    const abs = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/hostname';
    await writeTreeWithMarker({ '@file': abs });
    await expect(engine.implode({ root })).rejects.toThrow(/escapes the working tree/);
  });

  it('rejects an @ref marker that escapes the working tree', async () => {
    await writeTreeWithMarker({ '@ref': '../../../../secrets.json' });
    await expect(engine.implode({ root })).rejects.toThrow(/escapes the working tree/);
  });

  it('still resolves a legitimate in-tree @file marker', async () => {
    await mkdir(path.join(root, 'server'), { recursive: true });
    await writeFile(path.join(root, 'server', 'note.js'), 'return 1;', 'utf8');
    const config = { '@_version': '4.4.0', body: { '@file': 'note.js' } };
    await writeFile(
      path.join(root, 'server', 'configuration.json'),
      JSON.stringify(config),
      'utf8',
    );
    const imploded = await engine.implode({ root });
    expect((imploded as Record<string, unknown>).body).toBe('return 1;');
  });
});
