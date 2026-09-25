# Changelog

All notable changes to `@ubercode/channelvault` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-25

First release. Tested against Mirth Connect 4.5.2; the offline round trip is also tested on Mirth 3.8 and 4.0.1 exports.

### Added

- `explode` / `implode`: a Mirth backup XML to a git-friendly tree and back, losslessly. Channel config is stored as JSON; every transformer, filter, connector and code-template script is its own `.js` file.
- `pull`, `push`, `diff`, `status` against a live server over its REST API.
- Scoped `push`: only the channels, code templates, libraries and global scripts that changed, one resource at a time, after a preview and confirmation. Conflicts with server-side edits, deletions and duplicate ids are refused unless you opt in; `--deploy` redeploys only channels that are deployed now. `--whole-server` replaces the entire configuration.
- Secrets: credentials and configuration-map values become `{{env:NAME}}` placeholders with their values in a git-ignored `.env`. Secrets inside values (URLs, connection strings, headers, scripts, keys, tokens) block `pull`/`explode` until they are extracted (`--extract-secrets`) or allowed.
- `backup` / `restore`: the server's own configuration XML saved as `.backup/<server>-<UTC time>.xml`, identified by Mirth's server ID, restored with a preview, an undo backup and a version check. `push` backs up first unless `--no-backup`.
- `diff` exits 0 when the tree matches the server, 1 when it differs, 2 on error.

[0.1.0]: https://github.com/MichaelLeeHobbs/channelvault/releases/tag/v0.1.0
