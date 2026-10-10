# Aishe Desktop

Electron desktop client for [Aishe](https://github.com/astromanish/aishe-cli) — a
voice-first, offline-capable personal assistant.

One window for everything: chat with your agent, speak to it (Sarvam cloud
speech-to-text and text-to-speech), browse session history, watch memory status,
manage provider API keys, and restart backing services.

## Features

- **Chat** — streaming replies from the DeepAgent backend (`:8765`), with live
  tool-call traces and a broom to clear the visible transcript.
- **Voice** — Sarvam Saaras v3 (STT) and Bulbul v3 (TTS), 36 speakers, 21 Indian
  languages. No local sidecars; everything goes to Sarvam's cloud API.
- **Model picker** — every configured provider is probed and grouped in the
  selector, so switching between OpenRouter, Sarvam, Ollama Cloud and others
  takes one click. Selecting a model switches its provider atomically, because
  DeepAgent resolves its base URL and key from the `provider` config key.
- **History** — persisted to SQLite, newest first, with full-text search across
  messages.
- **Memory** — live status of the embedder (Ollama), the mem0 plugin, and the
  Qdrant vector DB.
- **Services** — start/stop/restart DeepAgent, Qdrant and Ollama, with honest
  health reporting: the app checks that a service actually answers on its port
  rather than trusting that a socket opened.

## Requirements

- Node.js 20+
- The `aishe-cli` project, for the DeepAgent backend (`~/.config/aishe/config.yaml`)
- A Sarvam API key for voice, and provider keys for whichever models you use

## Development

```bash
npm install
npm start        # launch the app
npm test         # 43 backend tests
```

`npm start` runs Electron directly. Use `./run.sh` instead when launching from a
detached shell or a systemd unit: it recovers `WAYLAND_DISPLAY` /
`XDG_RUNTIME_DIR` from your user session and applies the software-rendering
flags an Intel iGPU needs, without which the app dies on
"Failed to connect to Wayland display".

## Configuration

Reads `~/.config/aishe/config.yaml`. Provider credentials stay local; nothing is
committed to this repository. Local state and logs are written to
`~/.local/state/aishe/`.

## Layout

```
main.js          Electron main process — IPC handlers, single-instance lock
preload.js       Renderer capability surface (explicit methods only)
lib/services.js  HTTP probes: health, model catalogue, chat stream, voice
lib/control.js   Service lifecycle — spawn, health-check, restart
lib/config.js    YAML config read/write with credential redaction
lib/sessions.js  SQLite message persistence
renderer/        Chat, history, keys and memory panels
test/            Backend test suite
```

## License

MIT
