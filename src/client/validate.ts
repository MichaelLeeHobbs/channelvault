import type { CanonicalConfig } from '../types.js';

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate the live API envelope and core collections without dropping plugin fields. */
export function liveConfiguration(payload: unknown): CanonicalConfig {
  const bad = (detail: string): never => { throw new Error(`invalid server configuration response: ${detail}; nothing should be written from this snapshot`); };
  if (!object(payload) || Object.keys(payload).length !== 1 || !('serverConfiguration' in payload)) bad('expected the serverConfiguration wrapper');
  const config = (payload as Record<string, unknown>)['serverConfiguration'];
  if (!object(config)) bad('expected a configuration object');
  const c = config as Record<string, unknown>;
  if (typeof c['@version'] !== 'string' || !/^\d+\.\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/.test(c['@version'])) bad('missing or invalid engine version');
  if (!('channels' in c)) bad('missing channels collection');
  const collection = (container: unknown, key: string, where: string): Record<string, unknown>[] => {
    if (container == null || container === '') return [];
    if (!object(container)) bad(`invalid ${where} collection`);
    if (!(key in (container as Record<string, unknown>)) && Object.keys(container as object).some(k => !k.startsWith('@'))) bad(`missing resource list in ${where}`);
    const raw = (container as Record<string, unknown>)[key];
    if (raw == null || raw === '') return [];
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' || !item.name.trim()) bad(`invalid resource in ${where}`);
      if ('revision' in item && (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0)) bad(`invalid revision in ${where}`);
    }
    return items as Record<string, unknown>[];
  };
  collection(c.channels, 'channel', 'channels');
  if ('codeTemplateLibraries' in c) {
    for (const library of collection(c.codeTemplateLibraries, 'codeTemplateLibrary', 'code template libraries')) {
      if ('codeTemplates' in library) collection(library.codeTemplates, 'codeTemplate', 'code templates');
    }
  }
  if ('channelGroups' in c) collection(c.channelGroups, 'channelGroup', 'channel groups');
  return c as CanonicalConfig;
}
