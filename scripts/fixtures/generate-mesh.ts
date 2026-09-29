/**
 * Generates the input for test/fixtures/serverConfiguration.mesh.xml: a
 * synthetic Mirth 4.5.2 configuration shaped like a production routing mesh
 * (mostly Channel Reader/Writer chains, a hub fanning out to 18 destinations,
 * TCP/MLLP and SMTP senders, JavaScript readers and writers, a large code
 * template, attachment handlers, mixed storage modes), with scripts in the
 * style such meshes use and text chosen to break naive tooling.
 *
 * Every name, host, credential and id here is invented. Connector property
 * blocks are cloned from the existing synthetic fixture, which Mirth exported.
 *
 *   tsx scripts/fixtures/generate-mesh.ts <out.xml>
 *
 * scripts/fixtures/build-mesh.mjs runs this, loads the result into a
 * disposable Mirth, deploys every channel and saves Mirth's own export as the
 * fixture.
 */
import { readFile, writeFile } from 'node:fs/promises';

import { XmlConfigAdapter } from '../../src/xml/index.js';
import type { CanonicalConfig, Json } from '../../src/types.js';

type Obj = Record<string, Json>;
const xml = new XmlConfigAdapter();
const V = '4.5.2';
const clone = <T>(v: T): T => structuredClone(v);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: Json | undefined): Obj[] => (v == null || v === '' ? [] : (Array.isArray(v) ? v : [v]).filter(isObj));

// --- ids and the base fixture ---------------------------------------------------

let nextId = 0x1000;
/** Sequential synthetic UUIDs; test/fixtures.guard.test.ts accepts only this prefix. */
const uuid = (): string => `00000000-0000-4000-8000-${(nextId++).toString(16).padStart(12, '0')}`;

const base = xml.parse(await readFile(new URL('../../test/fixtures/serverConfiguration.sample.xml', import.meta.url), 'utf8'));
const baseChannels = list((base['channels'] as Obj)['channel']);
const allConnectors = baseChannels.flatMap((c) => [c['sourceConnector'] as Obj, ...list((c['destinationConnectors'] as Obj)['connector'])]);
const connectorOf = (transport: string): Obj => {
  const found = allConnectors.find((c) => c['transportName'] === transport);
  if (!found) throw new Error(`no ${transport} connector in the base fixture`);
  return clone(found);
};
/** A transformer (data types and their properties) from a connector with these data types. */
const transformerWith = (inbound: string, outbound?: string): Obj => {
  const found = allConnectors.map((c) => c['transformer']).find((t) => isObj(t) && t['inboundDataType'] === inbound && (!outbound || t['outboundDataType'] === outbound));
  if (!isObj(found)) throw new Error(`no ${inbound}->${outbound ?? '*'} transformer in the base fixture`);
  return clone(found);
};

// --- steps and scripts ----------------------------------------------------------

const STEP = 'com.mirth.connect.plugins.javascriptstep.JavaScriptStep';
const RULE = 'com.mirth.connect.plugins.javascriptrule.JavaScriptRule';
const lines = (...l: string[]): string => l.join('\n');

function steps(scripts: Array<{ name?: string; script: string; enabled?: boolean }>, kind: typeof STEP | typeof RULE): Obj {
  if (scripts.length === 0) return { elements: '' } as Obj;
  const items = scripts.map((s, i) => {
    const step: Obj = { '@_version': V };
    if (s.name !== undefined) step['name'] = s.name;
    step['sequenceNumber'] = String(i);
    step['enabled'] = s.enabled === false ? 'false' : 'true';
    if (kind === RULE) step['operator'] = i === 0 ? 'NONE' : i % 2 ? 'AND' : 'OR';
    step['script'] = s.script;
    return step;
  });
  return { [kind]: items };
}

function withSteps(transformer: Obj, scripts: Array<{ name?: string; script: string; enabled?: boolean }>): Obj {
  const t = clone(transformer);
  t['elements'] = scripts.length ? steps(scripts, STEP) : '';
  return t;
}

function filterWith(rules: Array<{ name?: string; script: string }>): Obj {
  return { '@_version': V, elements: rules.length ? steps(rules, RULE) : '' };
}

// Script bodies in the style of a JSON routing mesh. Rhino 1.7.14 (Mirth 4.x)
// runs let/const, arrow functions and simple template literals, but not
// shorthand properties ({ status }): deploying fails with "invalid object initializer".
const hubRouting = (targets: string[]): string => lines(
  '// Route each order to the destinations its type needs.',
  'const payload = JSON.parse(connectorMessage.getRawData());',
  "const type = (payload.messageType || 'unknown').toUpperCase();",
  "channelMap.put('messageType', type);",
  `const byType = ${JSON.stringify(Object.fromEntries(targets.map((t, i) => [`TYPE${i % 6}`, t])), null, 2)};`,
  'const wanted = Object.keys(byType).filter((k) => k === type).map((k) => byType[k]);',
  'try {',
  '  if (wanted.length === 0) {',
  "    logger.warn(`no route for ${type}; sending to the dead-letter queue`);",
  "    destinationSet.removeAllExcept(['Dead Letter']);",
  '  } else {',
  '    destinationSet.removeAllExcept(wanted);',
  '  }',
  '} catch (e) {',
  "  logger.error('routing failed: ' + e);",
  '  throw e;',
  '}',
);

const jsonToHl7 = (segment: string): string => lines(
  '// Build an HL7 v2 message from the JSON order.',
  'var order = JSON.parse(connectorMessage.getEncodedData());',
  "tmp['MSH']['MSH.9']['MSH.9.1'] = 'ORM';",
  "tmp['MSH']['MSH.9']['MSH.9.2'] = 'O01';",
  "tmp['MSH']['MSH.10'] = UUIDGenerator.getUUID();",
  "tmp['PID']['PID.3']['PID.3.1'] = order.patient.mrn;",
  "tmp['PID']['PID.5']['PID.5.1'] = order.patient.lastName;",
  "tmp['PID']['PID.5']['PID.5.2'] = order.patient.firstName;",
  'for (var i = 0; i < order.items.length; i++) {',
  `  var seg = createSegment('${segment}', tmp, i);`,
  `  tmp['${segment}'][i]['${segment}.1'] = String(i + 1);`,
  `  tmp['${segment}'][i]['${segment}.4']['${segment}.4.1'] = order.items[i].code;`,
  '}',
  "var serializer = SerializerFactory.getSerializer('HL7V2');",
  "channelMap.put('hl7', serializer.fromXML(tmp.toString()));",
);

const hl7ToJson = lines(
  '// Flatten the HL7 result into JSON for the downstream API.',
  'var result = { mrn: msg..PID[\'PID.3\'][\'PID.3.1\'].toString(), observations: [] };',
  "for each (var obx in msg..OBX) {",
  "  result.observations.push({ code: obx['OBX.3']['OBX.3.1'].toString(), value: obx['OBX.5']['OBX.5.1'].toString() });",
  '}',
  'msg = JSON.stringify(result);',
);

const responseStep = lines(
  "const status = responseStatus == SENT ? 'accepted' : 'rejected';",
  "responseMap.put('ack', ResponseFactory.getSentResponse(JSON.stringify({ status: status, at: DateUtil.getCurrentDate('yyyyMMddHHmmss') })));",
);

const filterRule = (field: string): string => lines(
  `// Accept only messages that carry ${field}.`,
  'var body = JSON.parse(connectorMessage.getRawData());',
  `return body.${field} != null && String(body.${field}).length > 0;`,
);

/** Text that trips up naive tooling; each line is something a real script can contain. */
const trickyScript = lines(
  '// Characters a round trip must keep exactly.',
  "var cdataEnd = ']]>';               // ends a CDATA section",
  "var markup = '<tag attr=\"1\">&amp; &lt; &#x41;</tag>';",
  "var unicode = 'Größe · 日本語 · עברית · 😀';",
  "var braces = '{{not a placeholder}} and ${velocity.style}';",
  "var re = /\"quoted\" and 'single' \\/ slash/g;",
  "var tpl = `line ${1 + 1}`;",
  '\tvar tabbed = true;   ',
  "var crlf = 'next line ends in CRLF';\r",
  "var lone = 'a lone CR follows';\rvar afterLoneCr = 1;",
  'return;',
);

// --- channel builders -------------------------------------------------------------

let metaIds: number;
interface ChannelSpec {
  name: string;
  description: string;
  source: Obj;
  destinations: Obj[];
  storage?: 'PRODUCTION' | 'DEVELOPMENT' | 'RAW' | 'METADATA' | 'DISABLED';
  state?: 'STARTED' | 'STOPPED' | 'PAUSED';
  attachment?: { type: 'None' | 'JavaScript' | 'Regex'; properties?: Obj };
  metaDataColumns?: number;
  scripts?: Partial<Record<'preprocessingScript' | 'postprocessingScript' | 'deployScript' | 'undeployScript', string>>;
  pruneDays?: number;
}

const template = baseChannels.find((c) => c['name'] === 'Report Distributor')!;

function channel(spec: ChannelSpec, id = uuid()): Obj {
  const c = clone(template);
  c['id'] = id;
  c['name'] = spec.name;
  c['description'] = spec.description;
  c['revision'] = '1';
  c['sourceConnector'] = spec.source;
  c['destinationConnectors'] = { connector: spec.destinations };
  c['nextMetaDataId'] = String(Math.max(0, ...spec.destinations.map((d) => Number(d['metaDataId']))) + 1);
  const trivial = 'return;';
  c['preprocessingScript'] = spec.scripts?.preprocessingScript ?? '// Modify the message variable below to pre process data\nreturn message;';
  c['postprocessingScript'] = spec.scripts?.postprocessingScript ?? '// This script executes once after a message has been processed\n// Responses returned from here will be stored as "Postprocessor" in the response map\nreturn;';
  c['deployScript'] = spec.scripts?.deployScript ?? '// This script executes once when the channel is deployed\n// You only have access to the globalMap and globalChannelMap here to persist data\nreturn;';
  c['undeployScript'] = spec.scripts?.undeployScript ?? trivial;
  const p = c['properties'] as Obj;
  p['messageStorageMode'] = spec.storage ?? 'PRODUCTION';
  p['initialState'] = spec.state ?? 'STARTED';
  const cols = spec.metaDataColumns ?? 2;
  p['metaDataColumns'] = cols === 0 ? '' : {
    metaDataColumn: Array.from({ length: cols }, (_, i) => ({ name: ['MRN', 'ACCESSION', 'MSG_TYPE', 'FACILITY', 'MODALITY', 'PRIORITY'][i % 6]! + (i >= 6 ? `_${i}` : ''), type: 'STRING', mappingName: ['mrn', 'accession', 'messageType', 'facility', 'modality', 'priority'][i % 6]! + (i >= 6 ? i : '') })),
  };
  // A handler other than None names its provider class; without it deploying throws in Mirth.
  const providers: Record<string, string> = {
    Regex: 'com.mirth.connect.server.attachments.regex.RegexAttachmentHandlerProvider',
    JavaScript: 'com.mirth.connect.server.attachments.javascript.JavaScriptAttachmentHandlerProvider',
  };
  const handler = spec.attachment?.type ?? 'None';
  p['attachmentProperties'] = {
    '@_version': V,
    ...(providers[handler] ? { className: providers[handler] } : {}),
    type: handler,
    properties: spec.attachment?.properties ?? '',
  };
  const md = (c['exportData'] as Obj)['metadata'] as Obj;
  md['enabled'] = 'true';
  (md['pruningSettings'] as Obj)['pruneMetaDataDays'] = String(spec.pruneDays ?? 30);
  return c;
}

function source(transport: string, opts: { transformer?: Obj; steps?: Array<{ name?: string; script: string }>; filter?: Array<{ name?: string; script: string }>; tweak?: (props: Obj) => void } = {}): Obj {
  const s = connectorOf(transport);
  s['metaDataId'] = '0';
  s['name'] = 'sourceConnector';
  s['transformer'] = withSteps(opts.transformer ?? (s['transformer'] as Obj), opts.steps ?? []);
  s['filter'] = filterWith(opts.filter ?? []);
  opts.tweak?.(s['properties'] as Obj);
  return s;
}

function destination(transport: string, name: string, opts: {
  enabled?: boolean;
  waitForPrevious?: boolean;
  transformer?: Obj;
  steps?: Array<{ name?: string; script: string; enabled?: boolean }>;
  responseSteps?: Array<{ name?: string; script: string }>;
  filter?: Array<{ name?: string; script: string }>;
  tweak?: (props: Obj) => void;
} = {}): Obj {
  const d = transport === 'JavaScript Writer' ? javascriptWriter() : connectorOf(transport);
  d['metaDataId'] = String(++metaIds);
  d['name'] = name;
  d['transformer'] = withSteps(opts.transformer ?? (d['transformer'] as Obj), opts.steps ?? []);
  d['responseTransformer'] = withSteps(d['responseTransformer'] as Obj, opts.responseSteps ?? []);
  d['filter'] = filterWith(opts.filter ?? []);
  d['enabled'] = opts.enabled === false ? 'false' : 'true';
  d['waitForPrevious'] = opts.waitForPrevious === false ? 'false' : 'true';
  opts.tweak?.(d['properties'] as Obj);
  return d;
}

/** The base fixture has no JavaScript Writer; its properties share the Channel Writer's destination settings. */
function javascriptWriter(): Obj {
  const cw = connectorOf('Channel Writer');
  const props = cw['properties'] as Obj;
  cw['properties'] = {
    pluginProperties: '',
    destinationConnectorProperties: props['destinationConnectorProperties']!,
    script: '',
    '@_class': 'com.mirth.connect.connectors.js.JavaScriptDispatcherProperties',
    '@_version': V,
  };
  cw['transportName'] = 'JavaScript Writer';
  return cw;
}

const channelWriterTo = (targetId: string) => (props: Obj) => {
  props['channelId'] = targetId;
  props['channelTemplate'] = '${message.encodedData}';
};

// --- the mesh -------------------------------------------------------------------------

const channels: Obj[] = [];
const ids = {
  deadLetter: uuid(),
  hub: uuid(),
  leaves: Array.from({ length: 14 }, () => uuid()),
};

// Leaves: Channel Reader -> TCP/MLLP sender (HL7), some with an audit Channel Writer.
const jsonTransformer = transformerWith('JSON', 'JSON');
ids.leaves.forEach((id, i) => {
  metaIds = 0;
  const site = ['North', 'South', 'East', 'West', 'Central', 'Satellite'][i % 6]!;
  const destinations = [
    destination('TCP Sender', `MLLP to ${site} ${i + 1}`, {
      steps: [{ name: 'JSON order -> HL7', script: jsonToHl7(i % 2 ? 'OBR' : 'ORC') }],
      responseSteps: i % 3 === 0 ? [{ name: 'Record ACK', script: responseStep }] : [],
      tweak: (p) => {
        p['remoteAddress'] = `mllp${i + 1}.example.org`;
        p['remotePort'] = String(6600 + i);
        p['responseTimeout'] = String(5000 + 1000 * (i % 4));
        p['queueOnResponseTimeout'] = i % 2 ? 'true' : 'false';
        p['ignoreResponse'] = i % 5 === 0 ? 'true' : 'false';
      },
    }),
  ];
  if (i % 4 === 0) {
    destinations.push(destination('Channel Writer', 'Audit copy', { waitForPrevious: false, tweak: channelWriterTo(ids.deadLetter) }));
  }
  if (i === 7) {
    // A disabled destination kept for later, as busy meshes accumulate.
    destinations.push(destination('TCP Sender', 'Old interface (retired)', { enabled: false, tweak: (p) => { p['remoteAddress'] = 'retired.example.org'; } }));
  }
  channels.push(channel({
    name: `Site ${site} ${String(i + 1).padStart(2, '0')}`,
    description: `Delivers orders to the ${site.toLowerCase()} site's interface engine over MLLP.`,
    source: source('Channel Reader', { transformer: jsonTransformer, filter: i % 3 === 1 ? [{ name: 'Has patient', script: filterRule('patient') }] : [] }),
    destinations,
    storage: i % 5 === 2 ? 'DEVELOPMENT' : 'PRODUCTION',
    metaDataColumns: 1 + (i % 4),
    pruneDays: 7 + i,
  }, id));
});

// Hub: one Channel Reader fanning out to 18 destinations.
metaIds = 0;
const hubDestinations = [
  ...ids.leaves.map((leafId, i) => destination('Channel Writer', `To site ${String(i + 1).padStart(2, '0')}`, {
    waitForPrevious: i % 3 !== 0,
    enabled: i !== 11,
    filter: i % 4 === 2 ? [{ name: 'Priority only', script: filterRule('priority') }] : [],
    tweak: channelWriterTo(leafId),
  })),
  destination('Channel Writer', 'Dead Letter', { tweak: channelWriterTo(ids.deadLetter) }),
  destination('JavaScript Writer', 'Archive to disk', {
    tweak: (p) => {
      p['script'] = lines(
        "var dir = $cfg('archive.dir') || '/opt/mirth/archive';",
        "var name = channelMap.get('messageType') + '-' + connectorMessage.getMessageId() + '.json';",
        "FileUtil.write(dir + '/' + name, false, connectorMessage.getEncodedData());",
        "return ResponseFactory.getSentResponse('archived ' + name);",
      );
    },
  }),
  destination('JavaScript Writer', 'Metrics', {
    waitForPrevious: false,
    tweak: (p) => {
      p['script'] = lines(
        'var counter = globalMap.get("hubCount") || new java.util.concurrent.atomic.AtomicLong(0);',
        'globalMap.put("hubCount", counter);',
        'counter.incrementAndGet();',
        'return;',
      );
    },
  }),
  destination('SMTP Sender', 'Alert on failure', {
    enabled: true,
    tweak: (p) => {
      p['smtpHost'] = 'smtp.example.org';
      p['username'] = 'mesh-alerts';
      p['password'] = 'fixture-smtp-password';
      p['to'] = 'integration-team@example.org';
      p['subject'] = 'Mesh hub failure: ${messageType}';
      p['attachmentsVariable'] = 'alertAttachments';
      p['isUseAttachmentsVariable'] = 'true';
    },
  }),
];
channels.push(channel({
  name: 'Order Hub',
  description: 'Routes every order to the sites that need it (fan-out of 18).',
  source: source('Channel Reader', { transformer: jsonTransformer, steps: [{ name: 'Route by type', script: hubRouting(ids.leaves.map((_, i) => `To site ${String(i + 1).padStart(2, '0')}`)) }, { name: 'Tricky text', script: trickyScript }] }),
  destinations: hubDestinations,
  metaDataColumns: 6,
  scripts: {
    deployScript: lines('// Warm the routing cache.', "globalChannelMap.put('routesLoadedAt', new Date().toISOString());", 'return;'),
    postprocessingScript: lines('// Summarise the fan-out.', 'var sent = 0;', "for each (var key in Iterator(responseMap.keySet())) { sent++; }", "logger.info('hub sent ' + sent);", 'return;'),
  },
}, ids.hub));

// Dead letter: stores everything it gets, raw.
metaIds = 0;
channels.push(channel({
  name: 'Dead Letter',
  description: 'Keeps messages no route claimed.',
  source: source('Channel Reader'),
  destinations: [destination('JavaScript Writer', 'Log only', { tweak: (p) => { p['script'] = "logger.warn('dead letter ' + connectorMessage.getMessageId());\nreturn;"; } })],
  storage: 'RAW',
  metaDataColumns: 0,
  pruneDays: 90,
}, ids.deadLetter));

// Intake: HTTP (JSON API), TCP (HL7 MLLP), and JavaScript Reader pollers, all into the hub.
metaIds = 0;
channels.push(channel({
  name: 'Order API',
  description: 'Accepts JSON orders over HTTP and answers with an acknowledgement.',
  source: source('HTTP Listener', {
    transformer: jsonTransformer,
    steps: [{ name: 'Validate and stamp', script: lines('const order = JSON.parse(msg);', "if (!order.patient) throw new Error('order has no patient');", "order.receivedAt = DateUtil.getCurrentDate(\"yyyy-MM-dd'T'HH:mm:ss\");", 'msg = JSON.stringify(order);') }],
    tweak: (p) => {
      const listener = p['listenerConnectorProperties'] as Obj;
      // Listeners bind to all interfaces; the base fixture's anonymised host cannot be bound.
      if (isObj(listener)) Object.assign(listener, { host: '0.0.0.0', port: '8181' });
      p['responseHeadersVariable'] = 'responseHeaders';
      p['useResponseHeadersVariable'] = 'true';
    },
  }),
  destinations: [destination('Channel Writer', 'To hub', { tweak: channelWriterTo(ids.hub) })],
  scripts: { preprocessingScript: lines('// Reject empty bodies before they are stored.', 'if (message == null || message.trim().length === 0) {', "  throw new Error('empty request');", '}', 'return message;') },
}));

metaIds = 0;
channels.push(channel({
  name: 'Results MLLP',
  description: 'HL7 results over MLLP, flattened to JSON for the hub.',
  source: source('TCP Listener', {
    transformer: transformerWith('HL7V2'),
    steps: [{ name: 'HL7 -> JSON', script: hl7ToJson }],
    filter: [{ name: 'Only ORU', script: "return msg['MSH']['MSH.9']['MSH.9.1'].toString() == 'ORU';" }, { name: 'Has OBX', script: 'return msg..OBX.length() > 0;' }],
    tweak: (p) => { const l = p['listenerConnectorProperties'] as Obj; if (isObj(l)) Object.assign(l, { host: '0.0.0.0', port: '6661' }); },
  }),
  destinations: [destination('Channel Writer', 'To hub', { tweak: channelWriterTo(ids.hub) })],
  // Attachment settings are a string map: <entry><string>key</string><string>value</string></entry>.
  attachment: { type: 'Regex', properties: { entry: [{ string: ['regex.pattern0', 'OBX\\|\\d+\\|ED\\|[^|]*\\|[^|]*\\|([^|\\r\\n]+)'] }, { string: ['regex.mimetype0', 'application/pdf'] }] } as Obj },
}));

const pollers = [
  { name: 'Worklist Poller', script: lines(
    '// Poll the worklist database; the password comes from the configuration map.',
    "var dbConn = DatabaseConnectionFactory.createDatabaseConnection('org.postgresql.Driver', $cfg('worklist.url'), $cfg('worklist.user'), $cfg('worklist.password'));",
    'try {',
    "  var rows = dbConn.executeCachedQuery('SELECT id, payload FROM worklist WHERE sent = false LIMIT 50');",
    '  var out = [];',
    '  while (rows.next()) { out.push(rows.getString(\'payload\')); }',
    '  return out.length ? out : null;',
    '} finally {',
    '  dbConn.close();',
    '}',
  ) },
  { name: 'Legacy Poller', script: lines(
    '// A legacy poller with its password written into the script, as old channels have.',
    "var conn = DatabaseConnectionFactory.createDatabaseConnection('net.sourceforge.jtds.jdbc.Driver', 'jdbc:jtds:sqlserver://legacy.example.org:1433/orders', 'mirth_svc', 'Fixture-Legacy-Pw1');",
    "var rs = conn.executeCachedQuery('SELECT TOP 10 body FROM outbox');",
    'var batch = [];',
    'while (rs.next()) batch.push(rs.getString(1));',
    'conn.close();',
    'return batch;',
  ) },
  { name: 'Drop Folder Poller', script: lines(
    'const dir = new java.io.File($cfg(\'drop.dir\') || \'/opt/mirth/drop\');',
    'const files = dir.listFiles() || [];',
    'const bodies = [];',
    'for (let i = 0; i < files.length; i++) {',
    '  const f = files[i];',
    "  if (!String(f.getName()).endsWith('.json')) continue;",
    '  bodies.push(FileUtil.read(f.getAbsolutePath()));',
    '  f.delete();',
    '}',
    'return bodies.length ? bodies : null;',
  ) },
];
pollers.forEach((poller, i) => {
  metaIds = 0;
  channels.push(channel({
    name: poller.name,
    description: 'Polls for new orders once an hour.',
    source: source('JavaScript Reader', {
      tweak: (p) => {
        p['script'] = poller.script;
        const poll = p['pollConnectorProperties'] as Obj;
        if (isObj(poll)) poll['pollingFrequency'] = '3600000';
      },
    }),
    destinations: [destination('Channel Writer', 'To hub', { tweak: channelWriterTo(ids.hub) })],
    state: i === 1 ? 'STOPPED' : 'STARTED',
  }));
});

// Attachments: a JavaScript attachment handler over a Channel Reader.
metaIds = 0;
channels.push(channel({
  name: 'Document Splitter',
  description: 'Moves embedded documents to attachments before routing.',
  source: source('Channel Reader', { transformer: jsonTransformer }),
  destinations: [destination('Channel Writer', 'To hub', { tweak: channelWriterTo(ids.hub) })],
  attachment: {
    type: 'JavaScript',
    properties: { entry: [{ string: ['javascript.script', lines(
      '// Replace base64 documents with attachment references.',
      'var body = JSON.parse(message);',
      '(body.documents || []).forEach(function (doc, i) {',
      "  var attachment = addAttachment(doc.data, doc.mimeType || 'application/pdf');",
      "  doc.data = '${ATTACH:' + attachment.getId() + '}';",
      '});',
      'return JSON.stringify(body);',
    )] }] } as Obj,
  },
  storage: 'DEVELOPMENT',
}));

// Names a tree must keep apart (same slug, case-only differences).
for (const name of ['Lab Feed', 'Lab  Feed', 'lab-feed', 'LAB FEED']) {
  metaIds = 0;
  channels.push(channel({
    name,
    description: 'Channels whose names collide once turned into directory names.',
    source: source('Channel Reader'),
    destinations: [destination('Channel Writer', 'To hub', { tweak: channelWriterTo(ids.hub) })],
    metaDataColumns: 0,
  }));
}

// --- code templates ---------------------------------------------------------------------

const contexts = {
  five: ['SOURCE_RECEIVER', 'DESTINATION_FILTER_TRANSFORMER', 'DESTINATION_DISPATCHER', 'SOURCE_FILTER_TRANSFORMER', 'DESTINATION_RESPONSE_TRANSFORMER'],
  all: ['GLOBAL_DEPLOY', 'GLOBAL_UNDEPLOY', 'GLOBAL_PREPROCESSOR', 'GLOBAL_POSTPROCESSOR', 'CHANNEL_DEPLOY', 'CHANNEL_UNDEPLOY', 'CHANNEL_PREPROCESSOR', 'CHANNEL_POSTPROCESSOR', 'CHANNEL_ATTACHMENT', 'CHANNEL_BATCH', 'SOURCE_RECEIVER', 'SOURCE_FILTER_TRANSFORMER', 'DESTINATION_FILTER_TRANSFORMER', 'DESTINATION_DISPATCHER', 'DESTINATION_RESPONSE_TRANSFORMER'],
  eleven: ['CHANNEL_DEPLOY', 'CHANNEL_UNDEPLOY', 'CHANNEL_PREPROCESSOR', 'CHANNEL_POSTPROCESSOR', 'CHANNEL_ATTACHMENT', 'CHANNEL_BATCH', 'SOURCE_RECEIVER', 'SOURCE_FILTER_TRANSFORMER', 'DESTINATION_FILTER_TRANSFORMER', 'DESTINATION_DISPATCHER', 'DESTINATION_RESPONSE_TRANSFORMER'],
};

function codeTemplate(name: string, code: string, opts: { type?: 'FUNCTION' | 'COMPILED_CODE' | 'DRAG_AND_DROP_CODE'; context?: string[] } = {}): Obj {
  return {
    id: uuid(),
    name,
    revision: '1',
    lastModified: { time: '1790000000000', timezone: 'Etc/UTC' },
    contextSet: { delegate: { contextType: opts.context ?? contexts.five } },
    properties: { type: opts.type ?? 'FUNCTION', code, '@_class': 'com.mirth.connect.model.codetemplates.BasicCodeTemplateProperties' },
    '@_version': V,
  };
}

const fn = (name: string, body: string, doc = `Synthetic helper ${name}.`): string => lines(
  '/**',
  `\t${doc}`,
  '',
  '\t@param {Object} value - input',
  '\t@return {Object} result',
  '*/',
  `function ${name}(value) {`,
  body,
  '}',
);

const helperBodies = [
  "\tif (value == null) return '';\n\treturn String(value).trim();",
  "\treturn JSON.stringify(value, null, 2);",
  "\tconst parts = String(value).split('^');\n\treturn { family: parts[0] || '', given: parts[1] || '' };",
  "\tvar fmt = new java.text.SimpleDateFormat('yyyyMMddHHmmss');\n\treturn fmt.format(new java.util.Date(value));",
  "\treturn (value || []).map((v) => String(v).toUpperCase()).filter((v) => v.length > 0);",
  "\ttry {\n\t\treturn JSON.parse(value);\n\t} catch (e) {\n\t\tlogger.warn('bad JSON: ' + e);\n\t\treturn null;\n\t}",
  "\treturn String(value).replace(/[^A-Za-z0-9]/g, '').substring(0, 20);",
  "\tvar out = [];\n\tfor each (var seg in value.children()) { out.push(seg.name().toString()); }\n\treturn out;",
  "\treturn $cfg('site.' + value) || $cfg('site.default');",
  "\trouter.routeMessage($c('replyChannel') || 'Dead Letter', JSON.stringify(value));\n\treturn true;",
];

const libraries: Obj[] = [];
const libraryNames = ['Formatting', 'JSON', 'HL7', 'Dates', 'Routing', 'Validation', 'Lookup', 'Site Config', 'Audit', 'Formatting (v2)', 'Legacy', 'Shared/Core'];
let templateCount = 0;
libraryNames.forEach((libName, li) => {
  const templates: Obj[] = [];
  const n = li === 0 ? 14 : 9;
  for (let t = 0; t < n; t++) {
    const name = `${libName.replace(/[^A-Za-z]/g, '').toLowerCase()}Helper${t + 1}`;
    templates.push(codeTemplate(name, fn(name, helperBodies[(li + t) % helperBodies.length]!), { context: t % 7 === 0 ? contexts.all : t % 5 === 0 ? contexts.eleven : contexts.five }));
    templateCount++;
  }
  // Two templates with the same name in one library, and the same name as another library's.
  if (li === 1) templates.push(codeTemplate('jsonHelper1', fn('jsonHelper1', '\treturn value;', 'A second template with a duplicate name.')));
  if (li === 2) templates.push(codeTemplate('formattingHelper1', fn('formattingHelper1', '\treturn value;', 'Same name as a Formatting template.')));
  if (li === 7) templates.push(codeTemplate('Site constants', "var SITE_CODES = { north: 'N', south: 'S', east: 'E', west: 'W' };\nvar DEFAULT_TIMEOUT_MS = 30000;", { type: 'COMPILED_CODE', context: contexts.all }));
  if (li === 6) {
    // One very large template, like a generated code table (the production one is ~11,000 lines).
    const cases: string[] = [];
    for (let k = 0; k < 3600; k++) {
      cases.push(`\t\tcase 'C${String(k).padStart(5, '0')}': return 'Code ${k} description';`);
      cases.push(`\t\t\t// mapped ${k}`);
      cases.push('');
    }
    templates.push(codeTemplate('lookupCode', lines('function lookupCode(code) {', '\tswitch (String(code)) {', ...cases, "\t\tdefault: return 'unknown';", '\t}', '}')));
  }
  const enabled = channels.filter((_, ci) => (ci + li) % 3 === 0).map((c) => String(c['id']));
  libraries.push({
    id: uuid(),
    name: libName,
    revision: '1',
    lastModified: { time: '1790000000000', timezone: 'Etc/UTC' },
    description: `Synthetic library ${li + 1}.`,
    includeNewChannels: li % 4 === 0 ? 'true' : 'false',
    enabledChannelIds: li % 4 === 0 ? '' : { string: enabled },
    disabledChannelIds: li % 4 === 0 ? { string: enabled.slice(0, 2) } : '',
    codeTemplates: { codeTemplate: templates },
    '@_version': V,
  });
});

// --- server-level sections ----------------------------------------------------------------

const config: CanonicalConfig = clone(base);
config['channels'] = { channel: channels };
config['channelGroups'] = {
  channelGroup: [
    { id: uuid(), name: 'Intake', revision: '1', lastModified: { time: '1790000000000', timezone: 'Etc/UTC' }, description: 'Where orders enter.', channels: { channel: channels.filter((c) => /API|MLLP|Poller|Splitter/.test(String(c['name']))).map((c) => ({ id: c['id']!, revision: '0', '@_version': V })) }, '@_version': V },
    { id: uuid(), name: 'Sites', revision: '1', lastModified: { time: '1790000000000', timezone: 'Etc/UTC' }, description: 'One channel per receiving site.', channels: { channel: ids.leaves.map((id) => ({ id, revision: '0', '@_version': V })) }, '@_version': V },
    { id: uuid(), name: 'Core', revision: '1', lastModified: { time: '1790000000000', timezone: 'Etc/UTC' }, description: '', channels: { channel: [ids.hub, ids.deadLetter].map((id) => ({ id, revision: '0', '@_version': V })) }, '@_version': V },
  ],
};
config['channelTags'] = {
  channelTag: [
    { id: uuid(), name: 'HL7', channelIds: { string: [...ids.leaves.slice(0, 5)] }, backgroundColor: { red: '0', green: '128', blue: '0', alpha: '255' } },
    { id: uuid(), name: 'Critical', channelIds: { string: [ids.hub] }, backgroundColor: { red: '200', green: '0', blue: '0', alpha: '255' } },
  ],
};
config['codeTemplateLibraries'] = { codeTemplateLibrary: libraries };
config['configurationMap'] = {
  entry: [
    ['archive.dir', '/opt/mirth/archive', ''],
    ['drop.dir', '/opt/mirth/drop', 'Folder the drop poller reads'],
    ['worklist.url', 'jdbc:postgresql://worklist.example.org:5432/worklist', ''],
    ['worklist.user', 'worklist_reader', ''],
    ['worklist.password', 'fixture-worklist-password', 'Rotated quarterly'],
    ['site.default', 'CENTRAL', ''],
    ['site.north', 'N', ''],
    ['routes.json', '{\r\n  "ORM": ["North", "South"],\r\n  "ORU": ["Central"]\r\n}', 'CRLF JSON, as pasted from Windows'],
    ['quoting', 'a=b # not a comment "double" \'single\' `back`', 'Every quote style'],
    ['empty.value', '', ''],
    ['unicode', 'Größe 日本語 😀', ''],
  ].map(([key, value, comment]) => ({ string: key!, 'com.mirth.connect.util.ConfigurationProperty': { value: value!, comment: comment! } })),
};
config['globalScripts'] = {
  entry: [
    { string: ['Deploy', lines('// Global deploy: load site constants once.', "globalMap.put('bootedAt', new Date().getTime());", 'return;')] },
    { string: ['Undeploy', 'return;'] },
    { string: ['Preprocessor', lines('// Strip a UTF-8 BOM from every inbound message.', "if (message.charAt(0) == '\\uFEFF') message = message.substring(1);", 'return message;')] },
    { string: ['Postprocessor', 'return;'] },
  ],
};

const out = process.argv[2];
if (!out) throw new Error('usage: generate-mesh.ts <out.xml>');
await writeFile(out, xml.build(config));
console.log(`wrote ${out}: ${channels.length} channels, ${libraries.length} libraries, ${templateCount + 4} code templates`);
