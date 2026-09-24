/**
 * XML canonical adapter for Mirth Connect "Backup Config" documents.
 *
 * Converts a Mirth `serverConfiguration` XML document to/from the canonical
 * config (a plain JSON object tree). `fast-xml-parser` v4 does the tokenizing in
 * its order-preserving mode; the conversion to the canonical object shape and
 * the serializer are ours, because fxp's object mode is lossy in ways a
 * round-trip test built on the same parser cannot see (it regroups interleaved
 * siblings, concatenates mixed-content text, and renames `__proto__`).
 *
 * Canonical shape (unchanged from the original fxp object-mode shape, so
 * existing exploded trees stay valid):
 *
 *  - An element with no attributes and no child elements is its text, as a
 *    STRING (`""` when empty). Values are never coerced or trimmed: Mirth ids,
 *    ports, `"0B"`, leading zeros and script-body whitespace all survive.
 *  - Otherwise it is an object: child elements (and `#comment`) keyed by name in
 *    first-appearance order, then `#text`, then attributes as `@_<name>`.
 *  - Repeated names become arrays; `ALWAYS_ARRAY_TAGS` are arrays even when
 *    single, so downstream code never special-cases "one vs many".
 *  - Whitespace-only text beside child elements is indentation and is dropped.
 *  - `#order` records the document order of an element's children ONLY when
 *    the default order (keys in order, each array contiguous, `#text` last)
 *    would differ from it — e.g. a transformer whose steps interleave
 *    `JavaScriptStep` and `MapperStep`. It never appears for ordinary Mirth
 *    output, and a stale hint (after hand-editing) degrades gracefully.
 *
 * Text fidelity: we own entity decode/encode. XML end-of-line handling (a
 * literal CRLF or CR in the document is a LF) and attribute-value
 * normalization (a literal tab/newline in an attribute is a space) are applied
 * as a conforming parser — Mirth's — would apply them, so the canonical value is
 * what Mirth actually reads. Characters those rules would destroy (CR, and tab
 * or newline inside attributes) are written back as character references.
 *
 * The acceptance criterion is a semantic, order-preserving round-trip:
 *
 *     parse(build(parse(xml)))  deep-equals  parse(xml)
 *
 * plus document order of the rebuilt XML equal to the source's (see tests).
 */
import { XMLParser } from 'fast-xml-parser';
import type { CanonicalConfig, Json, XmlAdapter } from '../types.js';

/**
 * Well-known Mirth collection element tags that must ALWAYS be arrays, even
 * when a document contains only a single instance.
 */
const ALWAYS_ARRAY_TAGS: ReadonlySet<string> = new Set<string>([
  'channel',
  'connector',
  'codeTemplate',
  'codeTemplateLibrary',
  'channelGroup',
  'alert',
  'rule',
  'entry',
  'string',
  // Fully-qualified JavaScript step / rule element names (live under <elements>).
  'com.mirth.connect.plugins.javascriptstep.JavaScriptStep',
  'com.mirth.connect.plugins.javascriptrule.JavaScriptRule',
  'com.mirth.connect.plugins.mapper.MapperStep',
  'com.mirth.connect.plugins.messagebuilder.MessageBuilderStep',
]);

/** The single top-level wrapper key of a Mirth backup document. */
const ROOT_KEY = 'serverConfiguration';

const TEXT_KEY = '#text';
const COMMENT_KEY = '#comment';
const CDATA_KEY = '#cdata';
/** Document-order hint; `#` cannot start an XML name, so it cannot collide. */
export const ORDER_KEY = '#order';
const ATTR_PREFIX = '@_';
const ORDERED_ATTRS = ':@';
const INDENT = '  ';

/** An fxp `preserveOrder` node: `{ <name>: children, ':@'?: attrs }`. */
type OrderedNode = Record<string, unknown>;

function isWhitespaceOnly(s: string): boolean {
  return /^\s*$/.test(s);
}

/** Named XML entities (the five predefined) -> their character. */
const NAMED_DECODE: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode XML entities in a single left-to-right pass: the five predefined named
 * entities plus decimal (`&#10;`) and hex (`&#xd;`) numeric character
 * references.
 *
 * A single non-overlapping scan is what makes `&#xd;` and `&amp;#xd;`
 * distinguishable: `&amp;` is consumed as one token (-> `&`) and its output is
 * not re-scanned, so the trailing `#xd;` stays literal.
 */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED_DECODE[body] ?? whole;
    const code =
      body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!(code <= 0x10ffff)) {
      throw new Error(`XmlConfigAdapter.parse: invalid character reference ${whole}`);
    }
    return String.fromCodePoint(code);
  });
}

function charRef(ch: string): string {
  return `&#x${ch.charCodeAt(0).toString(16)};`;
}

const ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Encode text content. Escapes the same set fxp's builder did (so unchanged
 * values serialize byte-identically) and writes CR and the other C0 controls
 * except tab/LF as character references: a literal CR would be read back as LF.
 */
function encodeText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[&<>"'\x00-\x08\x0b-\x1f]/g, (ch) => ESCAPE[ch] ?? charRef(ch));
}

/** Encode an attribute value; tab and LF must be references there too. */
function encodeAttr(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[&<>"'\x00-\x1f]/g, (ch) => ESCAPE[ch] ?? charRef(ch));
}

// --- parse -----------------------------------------------------------------

function nodeName(node: OrderedNode): string {
  const name = Object.keys(node).find((k) => k !== ORDERED_ATTRS);
  if (name === undefined) throw new Error('XmlConfigAdapter.parse: empty node');
  return name;
}

/** Concatenated text of a `#comment` / `#cdata` node's children, undecoded. */
function rawInnerText(children: unknown): string {
  return (children as OrderedNode[]).map((c) => String(c[TEXT_KEY] ?? '')).join('');
}

/** The child sequence the serializer emits for `obj` absent an `#order` hint. */
function defaultOrder(obj: Record<string, Json>): string[] {
  const seq: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith(ATTR_PREFIX) || key === ORDER_KEY) continue;
    const count = Array.isArray(value) ? value.length : 1;
    for (let i = 0; i < count; i += 1) seq.push(key);
  }
  return seq;
}

/** Convert one element's ordered children + attributes to its canonical value. */
function convertElement(children: OrderedNode[], attrs: Record<string, string> | undefined): Json {
  const hasElementChild = children.some((c) => {
    const n = nodeName(c);
    return n !== TEXT_KEY && n !== CDATA_KEY;
  });

  // Merge adjacent text/CDATA runs into text segments (CDATA is literal: no
  // entity decoding), and record the document order of what we keep.
  const groups = new Map<string, Json[]>();
  const order: string[] = [];
  const segments: string[] = [];
  let pending: string | null = null;
  const flushText = (): void => {
    if (pending === null) return;
    if (!hasElementChild || !isWhitespaceOnly(pending)) {
      segments.push(pending);
      order.push(TEXT_KEY);
    }
    pending = null;
  };

  for (const child of children) {
    const name = nodeName(child);
    if (name === TEXT_KEY) {
      pending = (pending ?? '') + decodeEntities(String(child[TEXT_KEY]));
      continue;
    }
    if (name === CDATA_KEY) {
      pending = (pending ?? '') + rawInnerText(child[CDATA_KEY]);
      continue;
    }
    flushText();
    // fxp renames this element to `#__proto__`; it cannot be an object key.
    if (name === '#__proto__') {
      throw new Error('XmlConfigAdapter.parse: unsupported element name <__proto__>');
    }
    const value =
      name === COMMENT_KEY
        ? rawInnerText(child[COMMENT_KEY])
        : convertElement(child[name] as OrderedNode[], child[ORDERED_ATTRS] as Record<string, string>);
    const group = groups.get(name);
    if (group) group.push(value);
    else groups.set(name, [value]);
    order.push(name);
  }
  flushText();

  const attrEntries = Object.entries(attrs ?? {});
  if (!hasElementChild && attrEntries.length === 0) {
    return segments.join('');
  }

  const obj: Record<string, Json> = {};
  for (const [name, values] of groups) {
    obj[name] = values.length > 1 || ALWAYS_ARRAY_TAGS.has(name) ? values : values[0]!;
  }
  if (segments.length === 1) obj[TEXT_KEY] = segments[0]!;
  else if (segments.length > 1) obj[TEXT_KEY] = segments;

  for (const [key, raw] of attrEntries) {
    if (key === `${ATTR_PREFIX}__proto__`) {
      throw new Error('XmlConfigAdapter.parse: unsupported attribute name __proto__');
    }
    // Attribute-value normalization: literal tab/LF (CRs are already LFs) read
    // as a space; character references were the way to keep them.
    obj[key] = decodeEntities(String(raw).replace(/[\t\n]/g, ' '));
  }

  const def = defaultOrder(obj);
  if (def.length !== order.length || def.some((k, i) => k !== order[i])) {
    obj[ORDER_KEY] = order;
  }
  return obj;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  commentPropName: COMMENT_KEY,
  cdataPropName: CDATA_KEY,
});

// --- build -----------------------------------------------------------------

/**
 * The children of `obj` in emit order: honours an `#order` hint as far as it
 * matches the actual children, then appends anything it didn't mention in
 * default order. So adding, removing or renaming a child by hand never loses it.
 */
function orderedChildren(obj: Record<string, Json>, where: string): Array<[string, Json]> {
  const queues = new Map<string, Json[]>();
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith(ATTR_PREFIX) || key === ORDER_KEY) continue;
    queues.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  const out: Array<[string, Json]> = [];
  const hint = obj[ORDER_KEY];
  if (hint !== undefined) {
    if (!Array.isArray(hint) || !hint.every((h) => typeof h === 'string')) {
      throw new Error(`XmlConfigAdapter.build: ${ORDER_KEY} under <${where}> must be an array of names`);
    }
    for (const name of hint as string[]) {
      const next = queues.get(name)?.shift();
      if (next !== undefined) out.push([name, next]);
    }
  }
  for (const [key, rest] of queues) {
    for (const value of rest) out.push([key, value]);
  }
  return out;
}

function scalar(value: Json): string {
  return value === null ? '' : String(value);
}

function serialize(name: string, value: Json, depth: number, pretty: boolean, out: string[]): void {
  const pad = pretty ? INDENT.repeat(depth) : '';
  const nl = pretty ? '\n' : '';

  if (name === COMMENT_KEY) {
    const text = scalar(value);
    if (text.includes('--') || text.endsWith('-')) {
      throw new Error(`XmlConfigAdapter.build: comment text cannot contain "--": ${text}`);
    }
    out.push(`${pad}<!--${text}-->${nl}`);
    return;
  }
  if (name === TEXT_KEY) {
    out.push(encodeText(scalar(value)));
    return;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${pad}<${name}>${encodeText(scalar(value))}</${name}>${nl}`);
    return;
  }

  const attrs = Object.entries(value)
    .filter(([k]) => k.startsWith(ATTR_PREFIX))
    .map(([k, v]) => ` ${k.slice(ATTR_PREFIX.length)}="${encodeAttr(scalar(v))}"`)
    .join('');
  const children = orderedChildren(value, name);
  const hasElementChild = children.some(([k]) => k !== TEXT_KEY);

  if (!hasElementChild) {
    const text = children.map(([, v]) => encodeText(scalar(v))).join('');
    out.push(`${pad}<${name}${attrs}>${text}</${name}>${nl}`);
    return;
  }

  // Mixed content can't be indented: the indentation would become part of its
  // text. Emit that element compactly.
  const mixed = children.some(([k]) => k === TEXT_KEY);
  const childPretty = pretty && !mixed;
  out.push(`${pad}<${name}${attrs}>${childPretty ? '\n' : ''}`);
  for (const [key, child] of children) {
    serialize(key, child, depth + 1, childPretty, out);
  }
  out.push(`${childPretty ? pad : ''}</${name}>${nl}`);
}

// --- adapter ---------------------------------------------------------------

export class XmlConfigAdapter implements XmlAdapter {
  /** Parse a Mirth backup XML string into a canonical config. */
  parse(xml: string): CanonicalConfig {
    // XML end-of-line handling, which fxp does not apply.
    const normalized = xml.replace(/\r\n?/g, '\n');
    if (/<!DOCTYPE/i.test(normalized.slice(0, normalized.search(/<[A-Za-z_]/)))) {
      // A DTD could declare entities we would not expand; Mirth never emits one.
      throw new Error('XmlConfigAdapter.parse: DOCTYPE declarations are not supported');
    }
    const nodes = parser.parse(normalized) as OrderedNode[];
    const root = nodes.find((n) => nodeName(n) === ROOT_KEY);
    if (root === undefined) {
      throw new Error(`XmlConfigAdapter.parse: expected a top-level <${ROOT_KEY}> element`);
    }
    const value = convertElement(root[ROOT_KEY] as OrderedNode[], root[ORDERED_ATTRS] as Record<string, string>);
    return (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as CanonicalConfig;
  }

  /** Serialize a canonical config back to Mirth backup XML. */
  build(config: CanonicalConfig): string {
    const out: string[] = [];
    serialize(ROOT_KEY, config, 0, true, out);
    return out.join('');
  }
}
