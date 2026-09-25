# channelvault

> Git-style **pull / push / diff** for Mirth Connect (NextGen Connect, Open Integration Engine, BridgeLink).

`channelvault` explodes a Mirth server configuration into a git-friendly directory tree (channel config as JSON, each transformer, filter, connector and code-template script as its own `.js` file) and reassembles it losslessly, so Mirth changes can be edited in an IDE, reviewed as diffs and moved between servers.

Where it is going: [docs/roadmap.md](docs/roadmap.md).

## How it works

Everything centers on one in-memory representation, the **canonical config**: a plain JSON object mirroring Mirth's `serverConfiguration` document. Two adapters produce it:

| Path          | Source                                 | Module       |
| ------------- | -------------------------------------- | ------------ |
| Dev / offline | Administrator *Backup Config* `.xml`   | `src/xml`    |
| Live server   | `GET /server/configuration` (JSON)     | `src/client` |

The explode engine (`src/explode`) projects a canonical config onto a directory tree and reverses it. Script bodies move to sidecar `.js` files, leaving `{ "@file": "..." }` in their place; split-out resources leave `{ "@ref": "..." }`.

The two adapters produce **different shapes** for the same server (XML: `@_version`, all-string values; live: `@version`, native types), and nothing converts between them yet. `push` refuses an XML-exploded tree and `implode` refuses a live-pulled one unless you pass `--force`.

### Round-trip fidelity

The exploded tree is a projection, not a re-derivation: config is stored verbatim and code is patched back at its exact location. Unknown elements, attributes, plugin step types, comments and interleaved sibling order all survive. The contract lives in the tests:

- `test/xml.test.ts`, `test/xml.robustness.test.ts`: XML parse/build fixed point, entity and whitespace handling, document order, unexpected XML
- `test/explode.test.ts`, `test/explode.paths.test.ts`: `implode(explode(c))` deep-equals `c`, byte-identical sidecars, file naming
- `test/e2e.test.ts`: the whole pipeline on a Mirth-exported fixture (`test/fixtures`, synthetic; `test/fixtures.guard.test.ts` rejects real exports)

## Layout produced by `explode` / `pull`

```
<root>/
  channelvault.json                  # provenance: source, pulledAt, engine version
  .env                               # secret values (git-ignored; see below)
  server/configuration.json          # everything not split out below
  channelGroups/<group>.json
  codeTemplates/<library>/
    library.json
    <template>.js
  channels/<channel>/
    channel.json
    scripts/{preprocessor,postprocessor,deploy,undeploy}.js
    source/receiver.js               # JavaScript Reader body
    source/{transformer,filter}/<n>.<step>.js
    destinations/<dest>/writer.js    # JavaScript Writer body
    destinations/<dest>/{transformer,responseTransformer,filter}/<n>.<step>.js
```

Global scripts, server settings, alerts and the configuration map stay inline in `server/configuration.json`.

## Commands

```
channelvault explode <backup.xml> <dir>     # XML  -> tree
channelvault implode <dir> <backup.xml>     # tree -> XML
channelvault pull <dir>                     # live server -> tree
channelvault push <dir>                     # changed channels/templates -> live server
channelvault diff <dir>                     # tree vs live server
channelvault status <dir>                   # summary of a tree
```

`channelvault <command> --help` lists the flags. Server connection comes from flags or `MIRTH_HOST`, `MIRTH_PORT`, `MIRTH_USER`, `MIRTH_PASS`; prefer the env var over `--pass`, which shows up in process listings. Mirth's default certificate is self-signed; `--insecure` accepts it by turning verification off.

`diff` exits 0 when the tree matches the server, 1 when they differ, and 2 on any error (including a bad flag), so a scheduled drift check can tell drift from an outage.

`pull` and `explode` replace `server/`, `channels/`, `codeTemplates/` and `channelGroups/` in `<dir>`, so they refuse a directory that has any of those but no `channelvault.json`.

## Secrets and per-environment values

`explode` and `pull` keep the credentials they detect out of the tree. Detection is heuristic (see below), so review a first pull of a real server before committing it. Fields named like credentials (passwords, passphrases, passcodes, tokens, secrets, API/access/private keys, and DICOM's `keyPW`, `keyStorePW` and `trustStorePW`), and every configuration-map value, become `{{env:NAME}}` placeholders, and their values go to `<dir>/.env`, which is added to the tree's `.gitignore`. `push` and `implode` fill the placeholders back in and refuse to run if any are missing, naming each one.

- You can add placeholders yourself anywhere, in JSON or in a `.js` file (for example `"host": "{{env:DB_HOST}}"`). A re-pull keeps them as long as they still resolve to what the server holds.
- `--dotenv .env.prod` selects another environment. Variables already set in the process environment take precedence over the file, so CI can supply them directly.
- If git would commit the env file (for example `--dotenv` pointing outside the tree, into a repository that doesn't ignore it), `pull` and `explode` warn.
- A password rotated on the server updates `.env` on the next `pull`, and `diff` reports it by name only. The previous env file is kept in the tree's `.secrets/` (git-ignored, newest 5 only) whenever a value in it changes. An extracted secret inside a script survives server-side edits to the rest of that script.

Secrets inside values are caught too: credentials in URLs and connection strings, `Authorization` headers, `createDatabaseConnection(…, 'password')` and `setPassword('…')` calls, password/key assignments in scripts (`password`, `dbPass`, `DB_PASS`, `apiKey`…), private keys, and AWS, GitHub, Slack and JWT tokens. If `pull` or `explode` finds one, it writes nothing and lists each finding by location and kind (never the value). Then either:

- rerun with `--extract-secrets`, which replaces just the secret part with a placeholder, or
- list a false positive in `channelvault.allow.json` (committed): `{ "ignore": [{ "location": "<as printed>", "kind": "assignment", "context": "<as printed>", "note": "why" }] }`. `context` identifies the surrounding text, so the entry stops applying if that text changes.

`diff` redacts any such secret the server holds that the tree hasn't extracted. After extraction, a known secret value (8+ characters) that still appears in plain text elsewhere, where no rule matched, is reported as a warning naming the variable and location.

## Pushing

`push` sends only what changed, one resource at a time: channels, code templates (and library membership), and global scripts. It prints the plan and asks before applying it.

```
channelvault push ./mirth                                # everything that changed
channelvault push ./mirth --channel "ADT Router"         # just this channel (repeat --channel for more)
channelvault push ./mirth --library Formatting --deploy  # one library, then redeploy the channels using it
```

- **Copies**: every channel, library and code template is saved by its `id`, and a copied directory keeps its source's. `push` refuses a tree where two resources share an id, and a save under a name another channel holds (case-insensitive), even one a delete or rename in the same push frees: push that delete or rename first. Give a copy a new UUID.
- **Deletions** (a channel directory or template you removed) need `--allow-deletes`. Something created on the server since your last pull is never treated as a deletion; `push` leaves it alone and says so.
- **Conflicts**: if the server's copy has a newer revision than your tree (someone saved it in the Administrator since your last pull), `push` refuses. Pull, merge in git, and push again, or pass `--force`.
- **`--deploy`** redeploys the channels that changed and the channels a changed code-template library is enabled for, but only those deployed on the server right now; it never starts a channel someone took down. Failures are reported per channel.
- After a push the tree's revision numbers are updated from the server, so `diff` and the next `push` stay clean.
- Server settings, the configuration map, channel groups and tags are **not** pushed; `push` names them if they differ. `--whole-server` replaces the entire server configuration instead. It shows the same change list and needs the same `--allow-deletes` / `--force`, and it can't be combined with `--channel` or `--library`.
- A tree exploded from an XML backup is refused (its shape differs from the live API's); `--ignore-origin` overrides that.
- Without a terminal, `push` needs `--yes`.

## Local test server

```
docker compose up -d     # nextgenhealthcare/connect:4.5.2, https://localhost:8443, admin/admin
MIRTH_HOST=localhost MIRTH_PORT=8443 MIRTH_USER=admin MIRTH_PASS=admin \
  channelvault pull ./work --insecure
```

To try channelvault on a **real** configuration, use `docker compose -f docker-compose.isolated.yml up -d` instead: the same server with no outbound network (a deployed channel cannot reach anything), startup deploy off, and port 8443 on localhost only. `down` deletes it and everything in it.

`pnpm test:integration` creates two disposable Mirth 4.5.2 servers on random localhost ports, imports only the synthetic fixture, and drives the CLI through a promotion with different destination credentials and independent revision history. It verifies conflict refusal, an explicit override, preserved tags and unrelated channels, and a clean repeat push. It removes its containers and network on success or failure. Docker is required; unavailable servers fail the command.

`test/integration/live.test.ts` is an optional additional suite for a disposable server you manage yourself. It runs when `MIRTH_HOST` is set; connection failures fail the suite. It writes the server configuration, so do not point it at a production or shared server.

### Promoting between environments

Use a separate working copy and env file for each server. Resource revisions and the sync baseline belong to the server that supplied them; they are not comparable version numbers across independent servers. Do not alternate a single working copy between destinations.

For an initial promotion, copy the reviewed source tree into a destination working copy and supply all of its placeholders in a destination env file. The example below assumes the `MIRTH_*` connection variables point to the destination:

```sh
channelvault diff ./destination --dotenv .env.destination
channelvault push ./destination --dotenv .env.destination --channel "Report Distributor"
```

Review the destination differences before overriding an independent revision history with `--force`. The initial source baseline cannot establish whether an independently managed destination changed since its last review. After the first successful push, keep the destination working copy and its refreshed baseline for subsequent changes. `--force` permits overwriting concurrent edits, while deletions still require `--allow-deletes`. A scoped push does not promote the configuration map or other server settings; manage those separately.

### Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` run the local checks. GitHub Actions defines those checks and packaging on Windows and Linux with Node 20.18.1, 22, and 24, plus the disposable two-server promotion on Linux. CLI tests cover partial saves and retries, failed refreshes, deployment failures, confirmation cancellation and EOF, and concurrent edits. File-symlink write protection is tested on Linux; directory junction protection is also tested on Windows.

## License

MIT
