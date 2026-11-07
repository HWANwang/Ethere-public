# Local installation

This is a source project, not a hosted chatbot. The main application runs on your computer and stores its data locally. The [offline demo](docs/) is separate and requires no setup beyond a browser.

## Prerequisites

- Node.js 22.13 or newer (the memory service uses `node:sqlite`) and npm.
- Git, if cloning from GitHub.
- For real chat: an installed, authenticated Codex CLI with `codex app-server` available on your `PATH`. The static demo works without it.
- Optional Android build: Android Studio, Android SDK, JDK, and the included Gradle wrapper. An Android build alone does not supply a reachable computer backend.
- Optional voice: Python, `numpy`, `sherpa-onnx`, compatible local ASR model files, and a Fish Audio API key for speech synthesis. No models, binaries, or credentials are included.
- Optional semantic memory: a local OpenAI-compatible embedding endpoint and compatible model files. Basic server startup does not require these.

## First run

```powershell
git clone https://github.com/HWANwang/Ethere-public.git
Set-Location Ethere-public
npm ci
npm test
```

Until this candidate is published, run the same commands from its local snapshot directory instead of cloning. The `.env.example` file is documentation only: Node does **not** automatically read `.env` here. Set variables in the shell or your own process manager, and never commit a populated `.env`.

On Windows PowerShell, start the main server with an explicit project-local data directory. Pick ports that are free on your machine; these sample ports deliberately differ from the maintainer's development ports.

```powershell
$env:ETHERE_DATA_DIR = (Join-Path (Get-Location) 'local-data')
$env:PORT = '4273'
$env:ETHERE_MEMORY_V2_URL = 'http://127.0.0.1:4291'
$env:ETHERE_DEVELOPER_BRIDGE_PORT = '4274'
npm start
```

Open `http://127.0.0.1:4273/`. The first run creates `local-data/`, which is excluded from Git. Without a configured Codex CLI, the UI can load but live chat is unavailable. Without the optional memory service on port 4291, semantic recall is unavailable; the app must not be pointed at another Ethere installation's memory service.

`ETHERE_DATA_DIR` must resolve to `<this checkout>/local-data`. Startup rejects a different location. This intentionally prevents accidental reuse of another installation's private data. The MCP process receives the same path from the main server.

To use another port, set `PORT` before startup. Do not change the Android backend address by accident: `capacitor.config.json` currently points to `127.0.0.1:4173`, which is a development setting. A real phone needs an explicitly reachable, secured backend and a matching Android configuration; a locally built APK is not a standalone server.

## Optional services

Memory service, in a separate PowerShell window:

```powershell
Set-Location Ethere-public
$env:MEMORY_LAB_DATA_DIR = (Join-Path (Get-Location) 'memory-lab/runtime')
$env:MEMORY_LAB_PORT = '4291'
$env:MEMORY_LAB_AUTO_MAINTENANCE = 'false'
node memory-lab/src/server.mjs
```

The memory service stores its own SQLite database under `memory-lab/runtime/`. It can start without an embedding model, but semantic search needs a compatible local endpoint. If you provide one, set `MEMORY_LAB_EMBEDDING_URL` and `MEMORY_LAB_EMBEDDING_NAME` in the memory-service shell. Keep it on loopback and do not point it at the maintainer's private embedding process. Automatic Codex-based memory maintenance is deliberately off in this minimal setup.

Voice service: `voice-lab/` is an optional, separately started experiment. After installing its Python dependencies and the ASR model, set `VOICE_LAB_PYTHON`, `FISH_API_KEY`, and optionally `VOICE_LAB_PORT`, then run `node voice-lab/server.mjs`. The main app's voice proxy currently expects port `4189`; if you choose another port, adjust the proxy configuration in source. Fish Audio is a third-party online service with its own pricing and terms. Do not place the API key in this repository.

Developer-task bridge and BOSS integration are optional, privileged integrations. Do not start the bridge until you have reviewed its allowed project roots and approval boundaries. BOSS requires your own login session and may require human security verification. Neither is needed for the offline demo or basic server startup.

## Verification

```powershell
npm test
node --test memory-lab/test/*.test.mjs
npm --prefix voice-lab test
```

With the main server running, `http://127.0.0.1:4273/api/ethere/v1/health` reports its process ID and data directory. Use that response to verify you reached the checkout you intended. An HTTP 200 with `runtimeConnected: false` means the Web server is up but Codex is not ready; it is not proof that chat works.

To inspect the offline demo locally, run `npm run demo:start` and open `http://127.0.0.1:4300/`. The demo deliberately does not make network requests or preserve chat state. It cannot read your local Ethere data.

## Troubleshooting and safety

- If startup says `ETHERE_DATA_DIR 与当前项目不一致`, remove the old environment variable from the shell and set it to this checkout's `local-data` path. Do not copy someone else's private data into the public tree.
- If a port is occupied, choose another unused port and update matching service URLs in the same shell. Do not kill an unknown process just to free a port.
- Do not expose the main server, memory service, or bridge directly to the public Internet. This source snapshot does not include a public authentication layer for those endpoints.
- Never commit `local-data/`, `memory-lab/runtime/`, `voice-lab/runtime/`, `.env`, model files, browser sessions, logs, or generated APKs.
