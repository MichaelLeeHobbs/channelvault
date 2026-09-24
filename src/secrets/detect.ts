/**
 * Find secrets that the key-name rules in `templatize` miss: credentials
 * embedded in URLs and connection strings, authorization headers, password
 * assignments in scripts, private keys and well-known token formats.
 *
 * Findings are reported by location and kind only; a secret value is never
 * printed. `extract` replaces just the secret part of each string with an
 * `{{env:NAME}}` placeholder, so the surrounding script or URL stays readable.
 */
import type { CanonicalConfig } from '../types.js';
import { derivedName, hasPlaceholder, mapLeaves, placeholder, type Env, type Leaf } from './index.js';

export type SecretKind =
  | 'private-key'
  | 'url-credentials'
  | 'connection-string'
  | 'authorization-header'
  | 'db-connection-call'
  | 'assignment'
  | 'aws-access-key'
  | 'jwt'
  | 'github-token'
  | 'slack-token';

interface Rule {
  kind: SecretKind;
  re: RegExp;
  /** Capture group holding the secret itself; 0 = the whole match. */
  group: number;
  /** Suffix for the env variable name. */
  suffix: string;
}

// Order matters: a private key block may contain text other rules would match.
const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0, suffix: 'PRIVATE_KEY' },
  { kind: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@'"/]+)@/gi, group: 1, suffix: 'PASSWORD' },
  { kind: 'connection-string', re: /[;?&]\s*(?:password|pwd)\s*=\s*([^;&'"\s]+)/gi, group: 1, suffix: 'PASSWORD' },
  { kind: 'authorization-header', re: /\b(?:Basic|Bearer)\s+([A-Za-z0-9+/=._~-]{12,})/g, group: 1, suffix: 'TOKEN' },
  {
    // Mirth's own idiom: DatabaseConnectionFactory.createDatabaseConnection(driver, url, user, 'password').
    kind: 'db-connection-call',
    re: /createDatabaseConnection\s*\((?:[^,()]*,){3}\s*(["'])([^"']+)\1/g,
    group: 2,
    suffix: 'DB_PASSWORD',
  },
  {
    kind: 'assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|token)\b["']?\s*[:=]\s*(["'])([^"'{}\s]{4,})\1/gi,
    group: 2,
    suffix: 'PASSWORD',
  },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0, suffix: 'AWS_ACCESS_KEY' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0, suffix: 'TOKEN' },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g, group: 0, suffix: 'TOKEN' },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, group: 0, suffix: 'TOKEN' },
];

/** A Mirth `${variable}` or one of our placeholders is a reference, not a secret. */
function isReference(secret: string): boolean {
  return secret.includes('${') || hasPlaceholder(secret);
}

export interface Finding {
  location: string;
  kind: SecretKind;
  /** Where it is, for people: enclosing channel/connector names and the field. */
  where: string;
}

/** Entries in the committed allow file: a known false positive at a location. */
export interface AllowEntry {
  location: string;
  kind: SecretKind;
  note?: string;
}

export type ScanMode = 'find' | 'extract' | 'redact';

export interface ScanResult {
  config: CanonicalConfig;
  findings: Finding[];
  /** extract mode: values for the env file. Never print these. */
  envUpdates: Record<string, string>;
}

/**
 * Scan every string leaf. `find` reports only; `extract` swaps each secret
 * for a placeholder and returns the values; `redact` swaps it for a marker
 * (for display, e.g. in `diff`).
 */
export function scanSecrets(config: CanonicalConfig, opts: { mode: ScanMode; allow?: AllowEntry[]; env?: Env }): ScanResult {
  const allowed = new Set((opts.allow ?? []).map((a) => `${a.location}#${a.kind}`));
  const env = opts.env ?? {};
  const findings: Finding[] = [];
  const envUpdates: Record<string, string> = {};

  const nameFor = (leaf: Leaf, rule: Rule, value: string): string => {
    const base = `${derivedName(leaf)}__${rule.suffix}`;
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? base : `${base}_${n}`;
      const current = envUpdates[name] ?? env[name];
      if (current === undefined || current === value) {
        envUpdates[name] = value;
        return name;
      }
    }
  };

  const out = mapLeaves(config, (original, leaf) => {
    let value = original;
    for (const rule of RULES) {
      if (allowed.has(`${leaf.location}#${rule.kind}`)) continue;
      value = value.replace(rule.re, (...m: unknown[]) => {
        const whole = m[0] as string;
        const secret = m[rule.group] as string;
        if (isReference(secret)) return whole;
        findings.push({ location: leaf.location, kind: rule.kind, where: [...leaf.labels, leaf.key].join(' › ') });
        if (opts.mode === 'find') return whole;
        const replacement = opts.mode === 'extract' ? placeholder(nameFor(leaf, rule, secret)) : `<redacted ${rule.kind}>`;
        if (rule.group === 0) return replacement;
        const start = whole.lastIndexOf(secret);
        return whole.slice(0, start) + replacement + whole.slice(start + secret.length);
      });
    }
    return value;
  });

  return { config: out, findings, envUpdates };
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ${f.kind.padEnd(20)} ${f.where}\n  ${''.padEnd(20)} at ${f.location}`).join('\n');
}
