# channelvault: notes for coding agents

A Node CLI (TypeScript, ESM) that pulls, pushes, diffs, backs up and restores Mirth Connect configurations. `README.md` is the user contract; read the section for whatever you change.

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test` (about a minute; CLI tests spawn real processes), `pnpm build`. CI runs them on Windows and Linux with Node 20.18.1, 22 and 24, so paths, line endings and file modes must work on both.

## Conventions

- **Pure JavaScript dependencies only.** No native addons, no postinstall builds: the CLI must install anywhere Node runs.
- **Reuse the shared helpers before writing one.** Check these first, and extend one with a parameter rather than writing a near-copy:
  - `src/json.ts`: `readJson(file)` (names the file in a parse error), `parseJson`.
  - `src/secrets/envfile.ts`: `readEnvFile(file)` (missing file is `{}`, never the process environment), `updateEnvFile(file, updates)` (rewrites only the lines it touches, atomic, owner-only; a null value removes the name), `formatValue`.
  - `src/backup/index.ts`: `writePrivate(file, text)` (owner-only, atomic rename).
  - `src/paths.ts`: `samePath(a, b)` (case-insensitive on Windows), `isWithin(child, parent)`, `resolvedPath(p)`, `canonical(p)` (follows links, including dangling ones).
  - `src/profiles.ts`: `configDir()` (honours `CHANNELVAULT_CONFIG_DIR`), `loadProfiles`, `readCredentials`, `setCredential`, `removeCredential`, `normalizeFingerprint`, `isLoopback`.
  - `src/connection.ts`: `resolveConnection(input)` is the only place a connection is chosen; it is pure, so test new rules in `test/connection.select.test.ts`.
  - In `src/cli.ts`: `fail(message, reason?)`, `readMeta(root)`, `selectConnection`, `withClient(conn, fn)`, `envFileFor(root, flags, conn)`, `rememberSecret`, `scrub`.
- **Errors.** User-facing errors go through `fail(message, reason)`; a reason is a short kebab-case code printed as `error: [reason] message` that agents route on, so keep existing codes stable. Never suggest `--pass`, never echo a file's contents (a JSON parse error can quote a password), and never print the connection password: `rememberSecret` registers values that `scrub` removes.
- **One connection per command.** Commands resolve their connection once with `selectConnection`, then take the `Connection` everywhere (backups, undo commands, banners); nothing rebuilds a target from flags. Writes pass `{ write: true }`.
- **Safety before convenience.** Checks that protect a server (installation binding, conflicts, deletions, the typed-profile rule for writes) run before anything is written and are not bypassed by `--force` unless the flag's help says so.
- **Comments state a reason** the code can't (an outside fact, a caller rule, a deliberate oddity), never what the code does.

## Tests

- CLI behaviour: spawn the CLI with `runCli` / `startCli` from `test/helpers/cli.ts` against `startFakeMirth` from `test/helpers/fakeMirth.ts`. `startCli(args, env, true)` passes the terminal check, so a test can answer prompts on stdin.
- `test/setup.ts` points `CHANNELVAULT_CONFIG_DIR` at a temporary folder for every test file, so no test touches the real `~/.channelvault`. A test that needs its own profiles passes its own `CHANNELVAULT_CONFIG_DIR` and blanks `MIRTH_*` (see `test/cli.profile.test.ts`).
- Pure logic gets pure unit tests; prefer a test whose name states the reason over a comment.

## Releases

Version in `package.json`, an entry in `CHANGELOG.md`, merge to `main`, then tag `v<version>` on the merge commit; the publish workflow releases a prerelease under the npm `next` tag. Merging and tagging need the maintainer's yes.
