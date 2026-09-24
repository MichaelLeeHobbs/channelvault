/**
 * Find secrets that the key-name rules in `templatize` miss: credentials
 * embedded in URLs and connection strings, authorization headers, password
 * assignments in scripts, private keys and well-known token formats.
 *
 * Findings are reported by location and kind only; a secret value is never
 * printed. `extract` replaces just the secret part of each string with an
 * `{{env:NAME}}` placeholder, so the surrounding script or URL stays readable.
 */
import { createHash } from 'node:crypto';

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

/** A secret's position in a string. */
interface Span {
  start: number;
  end: number;
}

interface Rule {
  kind: SecretKind;
  /** Suffix for the env variable name. */
  suffix: string;
  spans(value: string): Span[];
}

/** Spans of capture group `group` (0 = whole match) of every match of `re`. */
function regexSpans(re: RegExp, group: number): (value: string) => Span[] {
  return (value) => {
    const out: Span[] = [];
    for (const m of value.matchAll(re)) {
      const secret = m[group];
      if (secret === undefined) continue;
      // The secret is the last occurrence of its text within the match.
      const start = m.index + m[0].lastIndexOf(secret);
      out.push({ start, end: start + secret.length });
    }
    return out;
  };
}

/**
 * The fourth argument of `createDatabaseConnection(driver, url, user, password)`
 * when it is a string literal. Arguments are split at top-level commas, so
 * calls like `$('driver')` in earlier arguments don't throw it off.
 */
function dbConnectionSpans(value: string): Span[] {
  const out: Span[] = [];
  for (const m of value.matchAll(/createDatabaseConnection\s*\(/g)) {
    let depth = 0;
    let quote: string | null = null;
    let argStart = m.index + m[0].length;
    const args: Span[] = [];
    for (let i = argStart; i < value.length; i += 1) {
      const c = value[i]!;
      if (quote) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[' || c === '{') depth += 1;
      else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth -= 1;
      else if ((c === ',' && depth === 0) || c === ')') {
        args.push({ start: argStart, end: i });
        argStart = i + 1;
        if (c === ')') break;
      }
    }
    const pw = args[3];
    if (!pw) continue;
    const literal = /^\s*(["'])(.+)\1\s*$/s.exec(value.slice(pw.start, pw.end));
    if (literal) {
      const start = value.indexOf(literal[2]!, pw.start);
      out.push({ start, end: start + literal[2]!.length });
    }
  }
  return out;
}

// Earlier rules win where spans overlap: a private key block may contain text
// other rules match, and `token = 'ghp_…'` is one secret, not two.
const RULES: Rule[] = [
  {
    kind: 'private-key',
    suffix: 'PRIVATE_KEY',
    spans: regexSpans(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 0),
  },
  { kind: 'aws-access-key', suffix: 'AWS_ACCESS_KEY', spans: regexSpans(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 0) },
  { kind: 'jwt', suffix: 'TOKEN', spans: regexSpans(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 0) },
  { kind: 'github-token', suffix: 'TOKEN', spans: regexSpans(/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g, 0) },
  { kind: 'slack-token', suffix: 'TOKEN', spans: regexSpans(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 0) },
  // user:password@host. The user part stops at ';', '?' and '&' so a JDBC
  // parameter like `user=svc@srv` is not mistaken for credentials.
  { kind: 'url-credentials', suffix: 'PASSWORD', spans: regexSpans(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'";?&]+:([^\s@'"/;?&]+)@/gi, 1) },
  { kind: 'connection-string', suffix: 'PASSWORD', spans: regexSpans(/[;?&]\s*(?:password|pwd)\s*=\s*([^;&'"\s]+)/gi, 1) },
  // Case-sensitive, and the credential must contain a digit or a base64/token
  // symbol, so prose like "Basic authentication" does not match.
  {
    kind: 'authorization-header',
    suffix: 'TOKEN',
    spans: regexSpans(/\b(?:Basic|Bearer)\s+((?=[A-Za-z0-9+/=._~-]*[0-9+/=])[A-Za-z0-9+/=._~-]{12,})/g, 1),
  },
  { kind: 'db-connection-call', suffix: 'DB_PASSWORD', spans: dbConnectionSpans },
  // name = 'literal' where the name ends in a secret word: password, dbPassword,
  // db_password, DB_PASSWORD, apiKey, authToken… (not tokenizer, not ==).
  {
    kind: 'assignment',
    suffix: 'PASSWORD',
    spans: regexSpans(
      /(?<![\w$])[\w$]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token)["']?\s*[:=]\s*(["'])([^"'{}\s]{4,})\1/gi,
      2,
    ),
  },
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
  /** Identifies the surrounding text (secret removed), for allow entries. */
  context: string;
}

/**
 * A known false positive. `context` ties it to the surrounding text as well as
 * the location, so an entry for a transformer step at index 2 stops matching
 * if a different step moves into that index.
 */
export interface AllowEntry {
  location: string;
  kind: SecretKind;
  context: string;
  note?: string;
}

export type ScanMode = 'find' | 'extract' | 'redact';

export interface ScanResult {
  config: CanonicalConfig;
  findings: Finding[];
  /** extract mode: values for the env file (only ones it doesn't already hold). Never print these. */
  envUpdates: Record<string, string>;
}

interface Hit extends Span {
  rule: Rule;
}

/** Every secret span in `value`, earlier rules winning overlaps, in position order. */
function hitsIn(value: string): Hit[] {
  const taken: Hit[] = [];
  for (const rule of RULES) {
    for (const span of rule.spans(value)) {
      if (span.end <= span.start || isReference(value.slice(span.start, span.end))) continue;
      if (taken.some((t) => span.start < t.end && t.start < span.end)) continue;
      taken.push({ ...span, rule });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** Hash of the string with every secret removed: stable while its text is, and holds no secret. */
function contextOf(value: string, hits: Hit[]): string {
  let redacted = '';
  let at = 0;
  for (const h of hits) {
    redacted += `${value.slice(at, h.start)}\u0000${h.rule.kind}\u0000`;
    at = h.end;
  }
  redacted += value.slice(at);
  return createHash('sha256').update(redacted).digest('hex').slice(0, 16);
}

/**
 * Scan every string leaf. `find` reports only; `extract` swaps each secret
 * for a placeholder and returns the values; `redact` swaps it for a marker
 * (for display, e.g. in `diff`).
 */
export function scanSecrets(config: CanonicalConfig, opts: { mode: ScanMode; allow?: AllowEntry[]; env?: Env }): ScanResult {
  const allowed = new Set((opts.allow ?? []).map((a) => `${a.location}#${a.kind}#${a.context}`));
  const env = opts.env ?? {};
  const findings: Finding[] = [];
  const envUpdates: Record<string, string> = {};
  const assigned = new Map<string, string>(); // name -> value, this run

  const nameFor = (leaf: Leaf, rule: Rule, value: string): string => {
    const base = `${derivedName(leaf)}__${rule.suffix}`;
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? base : `${base}_${n}`;
      const current = assigned.get(name) ?? env[name];
      if (current === undefined || current === value) {
        assigned.set(name, value);
        // A value the environment already holds (the file, or CI's process
        // environment) is not written to the file again.
        if (env[name] !== value) envUpdates[name] = value;
        return name;
      }
    }
  };

  const out = mapLeaves(config, (value, leaf) => {
    const hits = hitsIn(value);
    if (hits.length === 0) return value;
    const context = contextOf(value, hits);
    let result = '';
    let at = 0;
    for (const h of hits) {
      if (allowed.has(`${leaf.location}#${h.rule.kind}#${context}`)) continue;
      findings.push({ location: leaf.location, kind: h.rule.kind, where: [...leaf.labels, leaf.key].join(' › '), context });
      if (opts.mode === 'find') continue;
      const secret = value.slice(h.start, h.end);
      const replacement = opts.mode === 'extract' ? placeholder(nameFor(leaf, h.rule, secret)) : `<redacted ${h.rule.kind}>`;
      result += value.slice(at, h.start) + replacement;
      at = h.end;
    }
    return opts.mode === 'find' ? value : result + value.slice(at);
  });

  return { config: out, findings, envUpdates };
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => `  ${f.kind.padEnd(20)} ${f.where}\n  ${''.padEnd(20)} at ${f.location}  context ${f.context}`)
    .join('\n');
}
