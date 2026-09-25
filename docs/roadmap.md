# channelvault roadmap

*Last revised 2026-09-24.*

## Goal

A team running Mirth can keep every channel, code template and script in git, review changes as pull requests, and apply them with `push`, instead of editing in the Administrator and copying code between servers by hand. channelvault is a single Node CLI, so a CI job can run it with nothing but Node installed.

**Ready for a first release** means M1 and M2 are done and their exit checks pass.

## Where it stands

- **Offline round trip.** XML ⟷ canonical ⟷ tree is lossless:
  - tested on a Mirth-exported synthetic fixture, and privately on a 2.7 MB production export (`test/private-fixture.test.ts`);
  - survives unknown XML: plugin steps, unknown sections, comments, interleaved step order, CDATA, CRLF line endings and attribute whitespace.
- **Live commands.** `pull`, `push`, `diff` and `status` work against Mirth 4.5.2 in Docker.
- **Scoped push.** `push` sends only changed channels, code templates, libraries and global scripts, one resource at a time, after previewing them. It refuses conflicts and deletions unless told otherwise, and `--deploy` redeploys only the channels affected. `--whole-server` keeps the old full replace.
- **Secrets.** Credentials and configuration-map values are kept in `.env` as `{{env:NAME}}` placeholders. `push` and `implode` fill them in and refuse to run if any are missing.
- **Guards.**
  - `diff` fails loudly when git fails, and compares only the directories channelvault manages.
  - `@file`/`@ref` markers can't point outside the tree.
  - Operations mixing the two transports are refused.
  - A tripwire test keeps real exports out of `test/fixtures`.
- **CLI failure tests and promotion:** subprocess tests cover failed saves, refreshes, deployment errors, cancelled/interrupted confirmations, and concurrent edits. `pnpm test:integration` creates two disposable Mirth servers and verifies a real promotion with destination credentials and independent revisions.
- **CI:** the GitHub Actions workflow is checked in; a hosted run remains to be verified after push.

## M1: Safe to point at production

1. ~~**Scoped push with a preview.**~~ Done (2026-09-24).
2. **Per-environment values.**
   - The same tree deploys to dev and prod, with values from `--dotenv .env.dev` or `.env.prod`.
   - Documented in the README and exercised by `pnpm test:integration` against two disposable Mirth 4.5.2 servers. Each destination needs its own working copy and baseline; independent server revisions are not comparable clocks.
3. **Global scripts as files.** Today they stay inline in `server/configuration.json`.
4. **Safe to script.**
   - Done: `push` without a terminal fails straight away unless `--yes` is passed.
   - Done: `diff` exits 0 = clean, 1 = differences, 2 = error (documented in the README).
5. **Secret coverage.**
   - Done (2026-09-24): key names (`*password`, `*secret`, `*token`, `*passphrase`), every configuration-map value, and secrets inside values (URL and connection-string credentials, auth headers, `createDatabaseConnection` calls, script assignments, private keys, known token formats). `pull`/`explode` refuse until each finding is extracted or allowed. On the private 2.7 MB export: 29 by key name, 6 in values, no false positives.
   - Done: DICOM (`passcode`, `keyPW`, `keyStorePW`, `trustStorePW`), `*Key` names, `pass`-style script variables and `set…Password('…')` calls.
   - Remaining: check against a full real server, including connector types the private export lacks (Database Reader/Writer, Web Service Sender).

*Exit check:* against the Docker server, a round trip of `pull`, an edit to one step, and a scoped `push` changes only that channel. This passes today (`test/integration/live.test.ts`). A promotion between two Docker servers with different env files leaves the right values on each.

## M2: A workflow developers can use

- **CI.** Implemented in `.github/workflows/ci.yml`: typecheck, lint, tests, build and packaging on Node 20.18.1, 22 and 24, on Linux and Windows, plus the disposable two-server promotion suite on Linux. Hosted execution is pending the next push.
- **Tests for Rhino code.** A loader so code templates can be called from vitest/Jest, and a harness that provides `msg`, `channelMap`, `$c` and the other Mirth globals to channel scripts.
- **Rhino lint.** An ESLint preset for Mirth's Rhino runtime: no template literals, `async`, `?.` or `class`; `let` rather than `const` inside loops.
- **Step order you can edit.**
  - Steps are grouped by Java class, and `#order` records the order when classes interleave, so reordering a JavaScript step against a Mapper step means editing `#order` by hand.
  - Either present each transformer as one ordered list, or make the file-name prefix `<n>` authoritative.
  - Which to choose depends on whether Mirth runs steps in list order or by `sequenceNumber` (see open questions).
- **Version coverage.** Fixtures exported from Docker for each supported Mirth / OIE version, run through every round-trip test. Started: mirthsync's 3.8, 4.0.1 and OIE 4.5.2 exports run through the offline pipeline (`test/third-party-fixtures.test.ts`); they cover only HTTP, JavaScript and Database Writer connectors.
- **Test gaps.** A coverage threshold, deterministic repeated-explode coverage, native terminal interaction beyond the pipe-driven confirmation tests, and more server versions. CLI failure/retry/confirmation tests and real pull/push/diff promotion coverage are implemented.

*Exit check:* green CI on every push, including the live job.

## M3: First release

- Publish to npm with provenance. Done for 0.1.0 as `@ubercode/channelvault`: published by hand (npm cannot configure a trusted publisher before a package exists); later versions publish from a `vX.Y.Z` tag through `.github/workflows/publish.yml` with provenance.
- A README walkthrough from `docker compose up` to a reviewed `push`.

## Backlog

- **Other secret stores.** AWS Secrets Manager, and possibly others, behind the same `{{env:NAME}}` placeholders so trees don't change.
- **Converting between the XML and live shapes.** Only needed to push a tree built from a backup file.
- **Login and TLS.** A `--token` login option, a no-echo password prompt, `--cafile`, and a warning when `--insecure` turns verification off.
- **Cleanup list.** `clearManaged` should get its directory list from the explode engine.
- **More resources.** Alerts, server resources and the configuration map as separately syncable resources.

## Open questions

- Does Mirth run transformer steps in list order or by `sequenceNumber`? This decides the step-order design in M2.
- Which Mirth / OIE / BridgeLink versions will be supported?

## Decisions

Dated and not edited afterwards. A later decision replaces an earlier one with a new entry.

**2026-06-16: Hand-written live client, not one generated from Mirth's OpenAPI spec.** The spec Mirth ships doesn't match what the server actually returns: response wrapping, Jackson `@class`/`@version` metadata, polymorphic connector types, `{time,timezone}` dates. So only the transport (session login, TLS, re-authentication on 401) and the few endpoints we use are hand-written, and payloads are treated as opaque JSON.

**2026-09-24: Build channelvault rather than use [mirthsync](https://github.com/SagaHealthcareIT/mirthsync).**
- mirthsync (3.6.0 when compared on 2026-06-26) is mature and already has per-resource sync, orphan detection, `--restrict-to-path` and token auth.
- It runs on the JVM, including through its npm wrapper. channelvault needs only Node, which suits Node-based CI images and TypeScript projects.
- channelvault also stores config as a canonical JSON tree with friendly file names, where mirthsync mirrors Mirth's XML on disk.
- The cost: M1 item 1 rebuilds features mirthsync already has.
- Scope: channelvault syncs code and channel configuration between git and Mirth. Features outside that (embedded git, alerts, resources, orphan cleanup modes) stay out unless that sync needs them.

**2026-09-24: Secrets as `{{env:NAME}}` placeholders backed by `.env`.**
- `pull` and `explode` move the values into the env file, which is added to `.gitignore`. `push` and `implode` refuse to run while any placeholder is unresolved.
- The syntax isn't `${NAME}` because Mirth connector fields already use `${...}` for Velocity variables.
- `process.env` wins over the file, so CI can supply values without writing one.
- Rejected for now: a secret-store integration. Placeholders keep that change separate from the tree.

**2026-09-24: Scoped push goes resource by resource and does its own conflict detection.**
- `PUT /server/configuration` replaces everything and deletes whatever the tree lacks, so it moved behind `--whole-server`.
- Mirth 4.5.2 does not reject a stale revision on `PUT /channels/{id}`, even with `override=false`, so push compares the server's revision with the tree's before sending anything.
- Saving a channel drops its tags and dependencies unless the payload carries them, and the server configuration omits them, so push copies them from `GET /channels/{id}`.
- Mirth drops CRs when it saves a channel, so push treats CRLF and LF as equal and `diff` ignores CR at end of line.
- Replacing the library list bumps every library's revision, so push only sends it when membership or library settings changed, and afterwards takes the new revision only for libraries the tree now matches.
- `channelvault.json` records the resource ids present at pull time, so a server resource the tree lacks is a deletion only if the tree once had it.
- `--deploy` only redeploys channels that are deployed now.

**2026-09-24: Secrets found inside values block the write; old env files are kept briefly.**
- Key-name matching missed credentials in URLs, connection strings, headers and scripts. The detector scans every value, and `pull`/`explode` write nothing until each finding is extracted (`--extract-secrets`) or allowed in the committed `channelvault.allow.json`. Refusing beats warning: a warning scrolls past and the secret lands in git.
- Findings are reported by location and kind only. Extraction replaces just the secret substring, so scripts stay readable and `render` restores them exactly.
- When a pull changes a value already in `.env`, the old file is copied to `.secrets/` (git-ignored) and only the newest 5 are kept. Rejected: unlimited history, which leaves every past password in plain text on disk.

**2026-09-24: Findings from the first real-config trial (40 channels, 112 code templates, Mirth 4.5.2, isolated server).**
- Round trip exact, 39 secrets moved to `.env`, scoped push and `diff` converge.
- Fixed from the trial: a configuration-map value (JSON with CRLF) that no dotenv quoting can carry is stored as `cv-base64:`; `.env` is written before the tree, so a failed write never leaves placeholders without values; the default-value idiom `apiKey = apiKey || '…'` is detected, and a known secret repeated in plain text is warned about; a lone CR is treated like other line endings (Mirth rewrites it as LF on save, which made push re-send forever); `--env-file` became `--dotenv` because Node scans the whole command line for `--env-file`; unused arguments are an error (a script runner's literal `--` had silently dropped `--extract-secrets`); `channelvault.json` is not rewritten for a timestamp alone.

**2026-09-24: Third review (stale snapshots, baselines, write safety).**
- `channelvault.json` now records each resource's revision at the last sync, plus a hash of the global scripts. A local delete of something the server changed since then is a conflict, and so is a global-scripts push over a server-side change. Older trees (ids only) keep working and upgrade on the next pull.
- After confirmation, pushes re-read the server and apply against that fresh copy; the library list (saved as a whole) must be unchanged. `--whole-server` treats resources created since the pull as deletions (needs `--allow-deletes` and `--force`, named in the preview) and re-checks the whole config before replacing it.
- Explode checks every write's real directory before creating it; XML is validated before conversion; the tree is written to a staging directory and swapped in.
- Library saves do not change template contents (verified on 4.5.2), so the library list only has to be current at the library level.
- Dependencies: undici 7.29, fast-xml-parser 5 (no audit findings).

**2026-09-24: Fourth review and executable release checks.**
- Closing confirmation input now fails and logs out. A post-save refresh failure preserves the original partial-push diagnosis. Whole-server force rechecks deletion consent against the final snapshot.
- Revision refresh verifies the saved content before adopting the server's revision, including whole-server replacement. A concurrent edit observed after saving leaves the old baseline and fails for review.
- Pull hashes the actual fetched global scripts before replacing secrets with placeholders. Existing file symlinks are rejected before explode writes through them.
- CI is defined and the two-server promotion has passed locally on Mirth 4.5.2. These checks qualify synthetic configuration operations, not live external integrations or other engine versions.

**2026-09-24: Release review fixes.**
- `pull`/`explode` refuse a directory holding managed directories without `channelvault.json`: they replace those directories, and a project's own `server/` was deleted.
- `push` refuses duplicate ids in the tree: a copied directory keeps its source's id, so its save overwrote the original. It also refuses to save a channel under a name another channel holds, even one freed by a delete or rename in the same push, because saves run one at a time before deletes.
- `diff` errors exit 2, so 1 always means differences.
- The env file is replaced by rename, not rewritten in place, and a warning names it when git would commit it.
- Connection failures name the address and cause (and suggest `--insecure` for an untrusted certificate); login errors omit the response body, and other error bodies are secret-redacted.
- Third-party review follow-up: errors are printed with every env value behind the tree's placeholders replaced, and error bodies have credential fields redacted, because a server's error can echo the submitted payload. Connection-string passwords may contain parentheses; only call syntax is excluded. `pull`/`explode` validate `channelvault.json` and the env file's location before writing anything.
- Fourth review follow-up: error bodies are decoded (JSON values, XML text) before redaction, so escaping cannot hide an echoed secret. Connection strings are told from script assignments by syntax (`password=value` has no spaces around `=`), not by excluding password characters. The env-file preflight checks the given path as well as the resolved one.
- Fifth review follow-up: server response bodies are left out of error messages unless `CHANNELVAULT_DEBUG` is set. Redacting them could never be complete (a body can echo a credential escaped, truncated or reformatted), and a credential in a CI log costs more than a less specific error. In a script, connection-string passwords are searched for only in string literals and comments; in config fields the whole value is searched, with spaces allowed around `=` as drivers accept them.

**2026-09-25: `backup` and `restore`, with a backup before every push.**
- A backup is the server's own XML (`GET /server/configuration` as XML), not rebuilt by channelvault, so the Administrator can restore it too.
- Named `<server>-<UTC stamp>.xml`, from the server name, then the environment name, then the host and port; UTC so the order holds across a DST change. The newest 10 per server are kept: backups hold credentials in plain text, the reason `.secrets/` is capped too.
- `restore` defaults to the newest backup of the connected server, never the newest in the folder, which may be another server's. It saves an undo backup first and uses the same preview and confirmation as `push --whole-server`.
- A backup's server is recorded by Mirth's server ID (`GET /server/id`), in a manifest beside the backups, not taken from the name in the file name. The name lives in Server Settings, which a restore or whole-server push copies to another server (verified on 4.5.2: the ID survives a configuration restore). Rotation only deletes files the manifest attributes to the server.
- `push` backs up first unless `--no-backup`, so every push can be undone.
- The sequential-save name rule for scoped pushes no longer applies to a whole replace (`--whole-server`, `restore`), which lands in one request; only its result must be free of name clashes.
