# Changelog

All notable changes to `@ubercode/channelvault` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `push` and `restore` refuse a configuration holding a character XML 1.0 forbids (C0 controls other than tab and line breaks, U+FFFE, U+FFFF, unpaired surrogates) before the backup and before any save, naming the resource, the line and column, and the tree file. Mirth saves such a character, but then cannot export its configuration (HTTP 500), so every later pull, diff, push and restore fails until the resource is fixed in the Administrator. `push --plan-only` lists it under what would stop the push, `diff` and `status` warn about it, and `status --json` lists it as `xmlForbiddenChars`.
- A scoped `push --deploy` redeploys the channels it saved even when refreshing the local sync baseline afterwards fails, then reports that failure. When it does not redeploy (a save failed, or a pushed resource changed again on the server), it names the channels it did not redeploy. When the server cannot export its configuration after a push, the message says that restore and the printed undo command fail too until the server is fixed.

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

[0.3.0-rc.1]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.3.0-rc.1
[0.2.1]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.2.1
[0.2.0]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.2.0
[0.1.0]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.1.0
