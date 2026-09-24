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

`channelvault <command> --help` lists the flags. Server connection comes from flags or `MIRTH_HOST`, `MIRTH_PORT`, `MIRTH_USER`, `MIRTH_PASS`; prefer the env var over `--pass`, which shows up in process listings.

## Secrets and per-environment values

`explode` and `pull` never write credentials into the tree. Connector passwords, tokens and secrets, and every configuration-map value, become `{{env:NAME}}` placeholders, and their values go to `<dir>/.env`, which is added to the tree's `.gitignore`. `push` and `implode` fill the placeholders back in and refuse to run if any are missing, naming each one.

- You can add placeholders yourself anywhere, in JSON or in a `.js` file (for example `"host": "{{env:DB_HOST}}"`). A re-pull keeps them as long as they still resolve to what the server holds.
- `--env-file .env.prod` selects another environment. Variables already set in the process environment take precedence over the file, so CI can supply them directly.
- A password rotated on the server updates `.env` on the next `pull`, and `diff` reports it by name only.

## Pushing

`push` sends only what changed, one resource at a time: channels, code templates (and library membership), and global scripts. It prints the plan and asks before applying it.

```
channelvault push ./mirth                                # everything that changed
channelvault push ./mirth --channel "ADT Router"         # just this channel (repeat --channel for more)
channelvault push ./mirth --library Formatting --deploy  # one library, then redeploy the channels using it
```

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

`test/integration/live.test.ts` runs against it when `MIRTH_HOST` is set and the server answers, and skips otherwise.

## License

MIT
