# Ethere

Ethere is a local-first personal AI companion prototype with a Web UI, Android client, Node.js backend, memory service, voice service, and MCP integrations.

The Ethere project source in this candidate is intended to be released under **GNU AGPL-3.0-only** (see `LICENSE`). The MIT text in `THIRD_PARTY_NOTICES.md` preserves a third-party attribution; it does not change Ethere's project license.

## Try it

- [Interactive showcase](docs/): explore the app's chat, space, timeline, settings, and selected conversation scenes. It is a static, fictional-data portfolio demonstration built from the real application UI.
- [Install and run locally](INSTALL.md): prerequisites, isolated data directory, optional integrations, tests, and troubleshooting.

## Project layout

| Directory | Purpose |
| --- | --- |
| `web/` | Chat and settings UI shared with the Android WebView |
| `android/` | Capacitor-based Android shell and native device features |
| `server/` | Chat, reminders, memory, MCP, and integration services |
| `memory-lab/` | Local SQLite memory engine and semantic retrieval |
| `voice-lab/` | Separate speech recognition and synthesis service |
| `test/` | Backend and Web regression tests |
| `examples/` | Fictional persona and anonymized operations examples |
| `docs/` | Interactive showcase using the application frontend |

## Architecture at a glance

```text
Android WebView / Web UI
          │ HTTP + streaming events
          ▼
Node.js application server ── Codex app-server (chat thread)
          │                         └─ MCP tools with explicit approval boundaries
          ├─ local data directory (chat, timeline, space, reminders, configuration)
          ├─ SQLite memory service ── optional local embedding endpoint
          └─ optional voice service ── local ASR + Fish Audio TTS
```

The application server and its MCP child use the same explicit `ETHERE_DATA_DIR`. Core memory is separately approved; ordinary memory is retrieved by topic and can retain evidence. Background check-ins and reminders can wake a model turn, while device-facing actions remain distinguishable from ordinary messages.

## Runtime dependencies

The application source is included, but private data, API keys, cookies, model weights, and runtime binaries are not. The original setup uses Codex for conversation, a local `bge-base-zh-v1.5 Q8_0` embedding model served through `llama.cpp`, local `sherpa-onnx` speech recognition, and Fish Audio speech synthesis. Users must provide their own credentials and obtain compatible model files and runtimes separately. These integrations require configuration before their respective features can work.

For Fish Audio, set `FISH_API_KEY` in the voice-service process environment. See `.env.example` for placeholders; never commit a populated `.env`. The previous machine-specific Windows DPAPI key reader is not part of this public candidate.

The actual persona and all core memory are intentionally excluded. The files in `examples/` are only starting points; they are not loaded automatically and should be customized locally.

## Release notes

The public source tree has an independent Git history and excludes private runtime data, core memories, credentials, browser sessions, model files, logs, screenshots, APKs, and local configuration. See `SNAPSHOT_MANIFEST.md` for the audited scope and validation record.
