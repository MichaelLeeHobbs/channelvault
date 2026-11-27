# Changelog

All notable changes to `@ubercode/channelvault` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0-rc.4] — 2026-11-27

Release candidate, published under the npm `next` tag.

### Added

- **Connection profiles.** `~/.channelvault/profiles.json` names each server's host, port, user, TLS pin, installation and env file, with no secrets; `~/.channelvault/credentials` holds the passwords, owner-only. A command takes its connection from exactly one source, in order: `--profile`, the login flags, `MIRTH_PROFILE`, `MIRTH_HOST`, then the profile whose installation matches the tree. So any checkout or worktree, and an agent's fresh shell, reaches the right server without flags, and two servers are told apart by their installation ID. See the README's "Connection profiles".
- `profile list`, `profile add`, `profile set-password`, `profile check` and `profile repin`. `add`, `set-password` and `repin` run only at a terminal; passwords need 8 characters and are never echoed.
- **TLS certificate pinning.** A profile pins its server certificate's SHA-256 fingerprint, checked during the handshake: on a mismatch the connection closes before anything (including the login) is sent. `--tls-fingerprint` / `MIRTH_TLS_FINGERPRINT` do the same without a profile. When a certificate is untrusted, the hint now prints the fingerprint it presents and suggests pinning it before `--insecure`.
- Live commands print one `connection:` line on stderr after verifying the server: the profile, URL, user, installation, how the connection was chosen, where the password came from, the TLS mode and the env file. `diff --json` and `push --plan-only --json` gain `serverId` and `connection`; `status --json` gains `serverId` and, without connecting, which profile a read would use and whether its password is configured.
- Errors carry a reason code, as `error: [reason] message`.
- A profile's `dotenv` serves every checkout of its trees when a tree has no `.env` of its own; a different local `.env` is refused rather than guessed between.
- `AGENTS.md` with the repository's conventions for coding agents.

### Changed

- **Real writes need a typed profile.** `push` (without `--plan-only`), `restore` and `adopt` refuse a profile chosen by the tree's installation; `MIRTH_PROFILE` selects one only when the write is confirmed at a terminal. Printed undo commands use `--profile <name>`.
- **A typed `--host` no longer borrows `MIRTH_PORT`, `MIRTH_USER` or `MIRTH_PASS` exported for a different `MIRTH_HOST`**: the command stops with `[env-conflict]` instead of sending one server's password to another. Type the matching login flags, or use a profile.
- `MIRTH_HOST` is refused when the tree, or the server that answers, belongs to a profile, which catches a stale shell variable.
- `insecure` and plain http are refused in a profile for any host but loopback, and a typed `--insecure` beside a pin is refused.
- An empty `MIRTH_*` variable counts as unset.

### Fixed

- `pull` refused nothing when the server was another installation than the tree's: a stale `MIRTH_HOST` could rewrite one server's tree as another's, and its next push would then pass the installation check. It now refuses (`[installation-mismatch]`), whichever way the connection was chosen.
- `diff` against another installation printed a whole-server difference; it now refuses with exit 2.
- The connection password was never redacted from output. It is now removed from error text, and when it has 8 or more characters, from every line on stdout and stderr.
- Recovering an interrupted pull whose env file is a profile's no longer needs the original `--dotenv`, and a pull locks a profile env file outside the tree so two worktrees cannot write it at once.

## [0.3.0-rc.3] — 2026-11-27

Release candidate, published under the npm `next` tag.

### Changed

- **Backups default to `~/.channelvault/backups`** (or `$CHANNELVAULT_CONFIG_DIR/backups`), shared by every checkout and worktree, instead of `./.backup` in the current directory. A push run from a git worktree used to leave its undo file in that worktree, where it disappeared with the worktree, and one server's backups ended up scattered across checkouts. The manifest still keeps servers apart. `--backup-dir` still overrides the folder. When the new folder has no backup of the server and `./.backup` does, restore says so. The newest 10 backups per server are now kept across all checkouts together. CI, or anything else with a throwaway or read-only home folder, should pass `--backup-dir` or set `CHANNELVAULT_CONFIG_DIR`. Two pushes that back up the same folder at the same moment can race on its manifest.

### Added

- `restore --export-broken`, for a server that cannot export its configuration (HTTP 500, as after a pushed template held U+FFFE on Mirth 4.5.0). It restores a backup taken from this installation without a preview, an undo backup or a version check, after you type the installation ID (or pass `--yes`). It verifies the result once the export works again, and refuses to run unless the export answers HTTP 500 (a working export, a proxy timeout or a dropped connection all refuse). A plain restore that cannot read the current configuration now names this flag, and so does the message after a push whose read-back failed. It has not yet been tried against a real server with a broken export.
- After a push, channelvault names the tree files to commit with the change (the refreshed revisions and `channelvault.json`).

### Fixed

- `diff`'s note about newer revisions on the server names `adopt` as well as `pull`, since adopt refreshes the baseline when the content already matches.
- The client never follows an HTTP redirect. A server (or anything answering on its address) that redirected the login would get the username and password re-sent to wherever it pointed, even over plain http. A redirect is now an error naming only the target's origin.
- README: the promotion steps no longer say the destination's login comes from `--dotenv`. The env file only fills the tree's placeholders; the login comes from `MIRTH_*` or the connection flags.

## [0.3.0-rc.2] — 2026-11-27

Release candidate, published under the npm `next` tag.

### Fixed

- `push` and `restore` refuse a configuration holding a character XML 1.0 forbids (C0 controls other than tab and line breaks, U+FFFE, U+FFFF, unpaired surrogates) before the backup and before any save, naming the resource, the line and column, and the tree file. Mirth saves such a character, but then cannot export its configuration (HTTP 500), so every later pull, diff, push and restore fails until the resource is fixed in the Administrator. `push --plan-only` lists it under what would stop the push, `diff` and `status` warn about it, and `status --json` lists it as `xmlForbiddenChars`.
- A scoped `push --deploy` redeploys the channels it saved even when refreshing the local sync baseline afterwards fails, then reports that failure. When the server cannot export its configuration, each saved channel and code template is read back on its own first, and one changed again on the server is not redeployed; saved libraries and global scripts cannot be read singly and are reported as unchecked. When it does not redeploy (a save failed, or a pushed resource changed again on the server), it names the channels it did not redeploy. When the server cannot export its configuration after a push, the message says that restore and the printed undo command fail too until the server is fixed.

## [0.3.0-rc.1] — 2026-11-27

Release candidate, published under the npm `next` tag.

### Changed

- **A tree is bound to the server installation it was pulled from.** `pull` records Mirth's installation ID, and `push` refuses a tree from a different or unknown installation, even with `--force`: revision numbers from another server say nothing about this one. A tree pulled with an earlier version has no installation ID, so it needs a fresh pull (with a merge) or `adopt` before its next push. The ID is taken as Mirth gives it: a generated UUID, or any one-line name an admin set in `appdata/server.id` (such as `mirth-gov`), up to 255 characters. A pull whose installation changes while it reads the server is refused.
- Configuration-map entries are addressed by key, not position (see Fixed). An entry in `channelvault.allow.json` that allowed a finding in a configuration-map field (such as an entry's comment) no longer matches and must be added again.
- A scoped push reports the channels it redeployed, skipped and failed to redeploy separately, and refuses a redeploy whose deployment status it cannot read.
- Tree commands hold a lock on the tree, so two commands cannot change it at once.

### Added

- `adopt <dir>`: makes a reviewed tree the baseline for another server (promotion) without writing to that server. It keeps the tree's content and placeholders, takes the destination's revisions, leaves destination-only resources alone, and has `--plan-only` and a confirmation.
- `implode` and `push` pick up new channel, library and channel-group directories without a hand-edit to `server/configuration.json`, including renamed directories. Incomplete new resources and copied ids are refused.
- README: a short procedure for the first production use.

### Fixed

- `pull` and `explode` keep the previous tree until its replacement is complete, and an interrupted run is recovered (from a journal) before the next command reads the tree.
- `push` and `restore` recheck each resource just before writing or deleting it, and recheck the whole server after taking the backup, so edits made on the server meanwhile are refused instead of overwritten. A scoped push rechecks each channel's deployment just before redeploying it, so a channel an operator undeployed stays undeployed.
- Saving the code template library list no longer unassigns templates created on the server since the pull; deleting a library that holds such templates is refused.
- A live configuration that is empty or not shaped like one (an HTTP 200 carrying an error) is refused instead of replacing a healthy tree or feeding a push plan.
- The printed undo command after a push or restore is complete: it keeps the connection and TLS options and the backup directory, repeats `--overwrite-config-map` when it was used, and quotes arguments for the shell. `--overwrite-config-map` is refused on a scoped push.
- `diff` and the push plan compare a code template's context types as a set (Mirth lists them in a different order on each server), and treat a channel's tags and dependency links as the same whether null or absent. A tree pulled from one server no longer shows every library and channel as modified against another.
- A re-pull no longer gives configuration-map entries each other's placeholders after an earlier entry is removed from the server. Entries were addressed by position, so each one after the removed entry inherited its neighbour's placeholder name (the values in the env file stayed with the right entry). Entries are now addressed by key. A tree pulled with an affected version keeps the wrong names on re-pull: pull it into a fresh directory to regenerate them.

## [0.2.1] — 2026-09-29

### Fixed

- `diff` compares content: revision numbers and timestamps, which Mirth bumps on any save or restore, no longer count as differences; `diff --json` lists them as `staleRevisions`.
- Channels whose names collide once made into directory names (`Lab Feed`, `LAB FEED`) keep their directories when the server lists them in another order, as it does after a restore.
- `push` no longer refuses to update one of two channels that already share a name on the server (Mirth allows `Lab Feed` beside `LAB FEED`); only a new name or a rename is checked.

### Added

- Tests on a production-shaped synthetic mesh (on real Mirth 4.5.2 too) and on 36 public exports from Mirth 3.0 to OIE 4.6.

## [0.2.0] — 2026-09-29

### Added

- `--json` for `status`, `diff` and `push --plan-only`: one JSON document on stdout for scripts, CI and AI agents.
- `push --plan-only`: the plan and what would stop it, without a prompt, a backup or any change.
- README: a copy-paste guide for using channelvault with an AI agent.

## [0.1.0] — 2026-09-25

First release. Tested against Mirth Connect 4.5.2; the offline round trip is also tested on Mirth 3.8 and 4.0.1 exports.

### Added

- `explode` / `implode`: a Mirth backup XML to a git-friendly tree and back, losslessly. Channel config is stored as JSON; every transformer, filter, connector and code-template script is its own `.js` file.
- `pull`, `push`, `diff`, `status` against a live server over its REST API.
- Scoped `push`: only the channels, code templates, libraries and global scripts that changed, one resource at a time, after a preview and confirmation. Conflicts with server-side edits, deletions and duplicate ids are refused unless you opt in; `--deploy` redeploys only channels that are deployed now. `--whole-server` replaces the entire configuration.
- Secrets: credentials and configuration-map values become `{{env:NAME}}` placeholders with their values in a git-ignored `.env`. Secrets inside values (URLs, connection strings, headers, scripts, keys, tokens) block `pull`/`explode` until they are extracted (`--extract-secrets`) or allowed.
- `backup` / `restore`: the server's own configuration XML saved as `.backup/<server>-<UTC time>.xml`, identified by Mirth's server ID, restored with a preview, an undo backup and a version check. `push` backs up first unless `--no-backup`.
- `diff` exits 0 when the tree matches the server, 1 when it differs, 2 on error.

[0.3.0-rc.4]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.3.0-rc.4
[0.3.0-rc.3]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.3.0-rc.3
[0.3.0-rc.2]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.3.0-rc.2
[0.3.0-rc.1]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.3.0-rc.1
[0.2.1]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.2.1
[0.2.0]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.2.0
[0.1.0]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.1.0
