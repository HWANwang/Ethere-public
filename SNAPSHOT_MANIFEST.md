# Public release manifest

This repository has an independent public Git history. It never includes the private repository's history or runtime state.

## Included

- Application Web UI, Android shell, server modules, MCP integrations, memory service, voice-service source, tests, install guidance, and third-party notices.
- A static portfolio demo under `docs/`, built from fictional data and with no network or persistent-data path.
- Fictional persona and operations examples that demonstrate the file formats without loading real user data.

## Excluded

- Persona and core-memory data, chat history, timeline, space posts, task and reminder databases.
- Credentials, API keys, browser sessions, cookies, model weights, runtime binaries, logs, screenshots, APKs, local configuration, and dependency folders.

## Completed release checks — 2026-11-07

- [x] Reviewed tracked source, examples, tests, text assets, metadata, and binary asset inventory for private names, local paths, credentials, browser-session data, and runtime data.
- [x] Replaced an incidental memory-recall test fixture with fictional travel and interview examples.
- [x] Confirmed the project license is GNU AGPL-3.0-only and retained the required MIT attribution in `THIRD_PARTY_NOTICES.md`.
- [x] Confirmed `.env.example` contains placeholders only; actual `.env`, data, logs, model directories, signing material, and build outputs are ignored.
- [x] Fresh-copy smoke check: isolated install, main server, empty study-plan API, independent memory database, and static demo all start without private data.
- [x] Root regression suite: 275 passed, 0 failed, 2 optional integrations skipped.
- [x] Memory service suite: 30 passed, 0 failed.
- [x] Voice service suite: 6 passed, 0 failed.

Optional live integrations — Codex app-server, Dida, Fish Audio, BOSS, Android device features, and locally supplied models — require the reader's own accounts, permissions, and runtime dependencies. Their absence is intentionally not hidden by the public demo.
