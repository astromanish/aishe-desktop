"use strict";
/**
 * Aishe Desktop — service layer.
 *
 * Talks to exactly the same services the CLI does: DeepAgent (:8765),
 * STT (:5093), TTS (:8766), Ollama (:11434). Pure Node — no Electron imports,
 * so it is testable with plain `node`.
 */

const cfg = require("./config");

const TIMEOUT = 2500;

function base(key) {
  return cfg.get(`services.${key}`, cfg.defaults().services[key]);
}

async function fetchTimeout(url, opts = {}, ms = TIMEOUT, externalSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

/* ── health ─────────────────────────────────────────────────────────────── */

/**
 * Every service the app can display MUST appear here, keyed by the same name
 * used in control.SERVICES — a service rendered by the UI but absent from this
 * list always shows as down (that bug shipped once: Qdrant was in the Services
 * panel and missing here, so it was permanently red).
 *
 * A test asserts the two lists stay in sync.
 */
const CHECKS = [
  ["ollama", "/api/tags", "Ollama"],
  ["deepagent", "/health", "DeepAgent"],
  ["qdrant", "/healthz", "Qdrant"],
];

/**
 * Voice is NOT in CHECKS: it runs on Sarvam's cloud API, which has no health
 * endpoint. Use voiceStatus() (key configured = ready) instead of probing a
 * local port — the old :5093 / :8766 sidecars no longer exist.
 */

/** Service keys this module knows how to probe. */
const PROBED = CHECKS.map(([key]) => key);

/* ── memory stack ───────────────────────────────────────────────────────── */

/**
 * Probe the three independent pieces of the memory stack. Each is reported
 * separately because any one of them can be down while the others are fine —
 * Ollama can be up with the embed model missing, Qdrant can be up with the
 * collection absent, and mem0 lives *inside* DeepAgent, so it fails whenever
 * DeepAgent does.
 *
 *   1. Embedder        — local Ollama answering /api/tags AND holding the model
 *   2. Memory plugin   — DeepAgent's mem0 layer reachable (/memory/status)
 *   3. Vector database — Qdrant up AND the aishe_memories collection existing
 *
 * Mirrors deepagent/mem0_memory.py: EMBED_MODEL / COLLECTION.
 */
const MEM_COLLECTION = "aishe_memories";
const EMBED_MODEL = "qwen3-embedding:0.6b";

async function memoryStatus() {
  const [embedder, plugin, vector] = await Promise.all([
    probeEmbedder(),
    probeMemoryPlugin(),
    probeVectorDb(),
  ]);

  const allUp = embedder.ok && plugin.ok && vector.ok;
  return {
    ok: allUp,
    summary: allUp
      ? `mem0 + Qdrant (${MEM_COLLECTION}) — embeddings ${EMBED_MODEL}`
      : "memory stack degraded — see the rows below",
    embedder,
    plugin,
    vector,
  };
}

/** 1. Embedder — Ollama reachable and actually serving the embedding model. */
async function probeEmbedder() {
  const row = { ok: false, detail: "", model: EMBED_MODEL };
  try {
    const r = await fetchTimeout(base("ollama") + "/api/tags", {}, TIMEOUT);
    if (!r.ok) {
      row.detail = `Ollama returned HTTP ${r.status}`;
      return row;
    }
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name || "");
    const hit = models.find((n) => n.startsWith(EMBED_MODEL.split(":")[0]));
    if (!hit) {
      row.detail = `Ollama is up but ${EMBED_MODEL} is not pulled`;
      return row;
    }
    row.ok = true;
    row.model = hit;
    row.detail = `${hit} · ${models.length} model(s) on Ollama`;
  } catch (e) {
    row.detail = "Ollama not reachable";
  }
  return row;
}

/** 2. Memory plugin — DeepAgent's mem0 layer answers /memory/status. */
async function probeMemoryPlugin() {
  const row = { ok: false, detail: "" };
  try {
    const r = await fetchTimeout(base("deepagent") + "/memory/status", {}, TIMEOUT);
    if (!r.ok) {
      row.detail = `DeepAgent /memory/status returned HTTP ${r.status}`;
      return row;
    }
    const j = await r.json();
    const text = String(j.status || "").trim();
    // The backend reports "legacy JSONL (…)" when mem0 is NOT wired up, so a
    // 200 alone is not proof — the string has to name mem0.
    row.ok = text.includes("mem0");
    row.detail = text || "no status reported";
  } catch (e) {
    row.detail = "DeepAgent not reachable";
  }
  return row;
}

/** 3. Vector database — Qdrant up AND the memory collection present. */
async function probeVectorDb() {
  const row = { ok: false, detail: "", collection: MEM_COLLECTION };
  try {
    const r = await fetchTimeout(base("qdrant") + `/collections/${MEM_COLLECTION}`, {}, TIMEOUT);
    if (!r.ok) {
      row.detail =
        r.status === 404
          ? `Qdrant is up but the ${MEM_COLLECTION} collection is missing`
          : `Qdrant returned HTTP ${r.status}`;
      return row;
    }
    const j = await r.json();
    const res = j.result || {};
    const pts = Number(res.points_count || 0);
    row.ok = true;
    row.points = pts;
    row.detail = `${MEM_COLLECTION} · ${pts} vector(s) · ${res.status || "ok"}`;
  } catch (e) {
    row.detail = "Qdrant not reachable";
  }
  return row;
}

/** Ping every service; also report which voice backend is behind 5093/8766. */
async function health() {
  const out = {};
  await Promise.all(
    CHECKS.map(async ([key, ep, label]) => {
      const url = base(key);
      let up = false;
      let detail = null;
      try {
        const r = await fetchTimeout(url + ep, {}, TIMEOUT);
        up = r.ok;
        if (r.ok) {
          try {
            detail = await r.json();
          } catch (e) {
            detail = null;
          }
        }
      } catch (e) {
        up = false;
      }
      out[key] = { up, url, label, detail };
    })
  );

  // Which voice backend is answering? Voice is Sarvam cloud — no local port to
  // probe — so report that directly rather than inferring from a dead service.
  const voice = await voiceStatus();

  return {
    services: out,
    model: cfg.get("model", ""),
    provider: cfg.get("provider", ""),
    voice: cfg.get("voice.default_voice", "shubh"),
    voiceBackend: { stt: voice.backend, tts: voice.backend },
    voiceStatus: voice,
    configPath: cfg.configPath(),
    dataDir: cfg.dataDir(),
  };
}

/**
 * Stream a turn. Calls onEvent for each NDJSON event from DeepAgent:
 *   start | stage | tool_call | tool_result | token | error | final
 * Returns { reply, toolCalls, durationMs }.
 */
async function chatStream(message, threadId, onEvent, externalSignal) {
  const r = await fetchTimeout(
    base("deepagent") + "/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, thread_id: threadId || "main" }),
    },
    600000,
    externalSignal
  );
  if (!r.ok) throw new Error(`DeepAgent /stream HTTP ${r.status}`);
  if (!r.body) throw new Error("DeepAgent returned no stream body");

  let reply = "";
  const toolCalls = [];
  const pending = [];
  let durationMs = null;

  const consume = (ev) => {
    if (onEvent) onEvent(ev);
    switch (ev.event) {
      case "tool_call":
        if (!ev.name) break;
        {
          let args = typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args || {});
          if (args.length > 400) args = args.slice(0, 400) + "…";
          const entry = { name: ev.name, args, result: "" };
          toolCalls.push(entry);
          pending.push(entry);
        }
        break;
      case "tool_result":
        {
          const target = pending.shift();
          if (target) {
            let res = String(ev.result || "").replace(/\s+/g, " ").trim();
            if (res.length > 600) res = res.slice(0, 600) + "…";
            target.result = res;
          }
        }
        break;
      case "token":
        reply += ev.content || "";
        break;
      case "error":
        throw Object.assign(new Error(ev.message || "stream error"), { name: "StreamError" });
      case "final":
        if (!reply) reply = ev.answer || "";
        if (typeof ev.duration_s === "number") durationMs = Math.round(ev.duration_s * 1000);
        break;
      default:
        break;
    }
  };

  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) if (line.trim()) consume(JSON.parse(line));
  }
  buf += decoder.decode();
  if (buf.trim()) consume(JSON.parse(buf));

  if (!reply.trim()) throw new Error("empty reply from agent");
  return { reply: reply.trim(), toolCalls, durationMs };
}

/* ── voice (Sarvam cloud) ──────────────────────────────────────────────── */

/**
 * Voice runs on Sarvam's cloud API (Saaras v3 STT + Bulbul v3 TTS) using the
 * SAME subscription key as the chat provider. There are no local STT/TTS
 * sidecars — do not probe :5093 / :8766, they no longer exist.
 *
 * Auth header is `api-subscription-key` (NOT a bearer token), and TTS returns
 * base64 audio in an `audios` array rather than raw bytes.
 */
const SARVAM_BASE = "https://api.sarvam.ai";
// Read from config (not hardcoded) so the Voice section can switch them; the
// CLI reads the same keys.
const STT_MODEL = () => cfg.get("voice.stt_model", "saaras:v3");
const TTS_MODEL = () => cfg.get("voice.tts_model", "bulbul:v3");

function sarvamKey() {
  return cfg.get("providers.sarvam.api_key", "");
}

function sarvamHeaders() {
  const key = sarvamKey();
  if (!key) throw new Error("Sarvam API key not set — configure providers.sarvam.api_key");
  return { "api-subscription-key": key };
}

/** Transcribe a WAV buffer via Sarvam Saaras v3. */
async function transcribe(wavBuffer, filename = "speech.wav") {
  const fd = new FormData();
  fd.append("file", new Blob([wavBuffer], { type: "audio/wav" }), filename);
  fd.append("model", STT_MODEL());
  fd.append("mode", cfg.get("voice.stt_mode", "transcribe"));
  const r = await fetchTimeout(
    SARVAM_BASE + "/speech-to-text",
    { method: "POST", headers: sarvamHeaders(), body: fd },
    120000
  );
  if (!r.ok) throw new Error(`Sarvam STT HTTP ${r.status}`);
  const j = await r.json();
  return (j.transcript || j.text || "").trim();
}

/** Synthesize speech via Sarvam Bulbul v3. Returns a WAV Buffer. */
async function synthesize(text, voice) {
  const v = voice || cfg.get("voice.default_voice", "shubh");
  const r = await fetchTimeout(
    SARVAM_BASE + "/text-to-speech",
    {
      method: "POST",
      headers: { ...sarvamHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        language_code: cfg.get("voice.language_code", "en-IN"),
        speaker: v,
        model: TTS_MODEL(),
      }),
    },
    180000
  );
  if (!r.ok) throw new Error(`Sarvam TTS HTTP ${r.status}`);
  const j = await r.json();
  const audios = j.audios || [];
  if (!audios.length) throw new Error("Sarvam TTS returned no audio");
  return Buffer.from(audios[0], "base64");
}

/**
 * Voice readiness. Sarvam is a cloud API with no health endpoint, so a
 * configured key is the gate — the same rule the CLI uses.
 */
async function voiceStatus() {
  const key = sarvamKey();
  return {
    ready: Boolean(key),
    backend: "sarvam",
    model: `${STT_MODEL()} + ${TTS_MODEL()}`,
    speaker: cfg.get("voice.default_voice", "shubh"),
    language: cfg.get("voice.language_code", "en-IN"),
  };
}

/* ── models ─────────────────────────────────────────────────────────────── */

/**
 * List selectable models for the ACTIVE provider.
 *
 * Auth differs per provider (OpenRouter uses a bearer token, Sarvam uses
 * api-subscription-key), and Ollama exposes /api/tags rather than /models, so
 * this tries the OpenAI-shaped endpoint first and falls back.
 */
/**
 * List the models each configured provider offers.
 *
 * Probes EVERY provider in config (not just the active one) so the chat model
 * picker can show them all as optgroups. Providers that are unreachable, have
 * no key, or return nothing are reported with their reason instead of being
 * silently dropped — otherwise the user sees an empty dropdown with no clue why.
 *
 * Returns { provider, providers: [{name, models, base, error}], models, error }.
 * `models` stays a flat sorted list of "provider:model" ids for compatibility.
 */
async function listModels() {
  const active = cfg.get("provider", "");
  const names = Object.keys(cfg.get("providers", {}) || {});
  if (!names.length) return { provider: active, providers: [], models: [], error: "no providers configured" };

  const results = await Promise.all(
    names.map((name) => probeProvider(name))
  );

  const providers = results.filter((r) => r.models.length || r.error);
  const flat = [];
  for (const r of providers) for (const m of r.models) flat.push(`${r.name}:${m}`);

  return {
    provider: active,
    providers,
    models: [...new Set(flat)].sort(),
    error: providers.length ? undefined : "no provider returned any models",
  };
}

/**
 * Validate a "provider:model" pair against the provider's live catalogue.
 *
 * This is the guard that was missing: the picker happily offered ids that no
 * provider actually serves (e.g. a retired `aion-labs/aion-2.0`). The switch
 * then wrote it to config and restarted DeepAgent, which starts fine but
 * rejects the model on the first request — so the UI flashed "failed" while the
 * bad id stuck around, and a restart made it look like the switch had worked.
 *
 * Never throws; returns { ok, reason, known }. `known` is the full list so the
 * caller can suggest near matches.
 */
async function validateModel(provider, model) {
  const names = Object.keys(cfg.get("providers", {}) || {});
  if (!names.length) return { ok: false, reason: "no providers configured", known: [] };
  if (!names.includes(provider)) {
    return { ok: false, reason: `unknown provider: ${provider}`, known: [] };
  }

  const probe = await probeProvider(provider);
  if (!probe.models.length) {
    // Can't verify (provider unreachable, or genuinely empty). Don't block on
    // an unreachable catalogue, but say so.
    return {
      ok: true,
      verified: false,
      reason: `could not verify — ${probe.error || "provider returned no models"}`,
      known: [],
    };
  }
  if (probe.models.includes(model)) return { ok: true, verified: true, known: probe.models };

  // Suggest the closest real ids — retired models usually have a newer sibling.
  const stem = model.split("/").pop().split("-").slice(0, 2).join("-");
  const near = probe.models.filter((m) => m.includes(stem)).slice(0, 4);
  return {
    ok: false,
    verified: true,
    reason: `model "${model}" is not served by ${provider}`,
    known: probe.models,
    near,
  };
}

/** Probe one provider's model catalogue. Never throws. */
async function probeProvider(name) {
  const d = (cfg.defaults().providers || {})[name] || {};
  const base = String(cfg.get(`providers.${name}.base_url`, d.base_url) || "").replace(/\/$/, "");
  const key = cfg.get(`providers.${name}.api_key`, d.api_key || "");
  const row = { name, models: [], base, error: null };

  if (!base) {
    row.error = "no base_url";
    return row;
  }

  const headers = {};
  if (key) {
    if (name === "sarvam") headers["api-subscription-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }

  // Two shapes: OpenAI-style /models, and Ollama's /api/tags.
  const attempts = [
    { url: `${base}/models`, pick: (j) => (j.data || []).map((m) => m.id) },
    { url: `${base}/api/tags`, pick: (j) => (j.models || []).map((m) => m.name) },
  ];

  let lastErr = null;
  for (const { url, pick } of attempts) {
    try {
      const r = await fetchTimeout(url, { headers }, 12000);
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const ids = pick(await r.json()).filter(Boolean);
      if (ids.length) {
        row.models = [...new Set(ids)].sort();
        return row;
      }
      lastErr = "no models returned";
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  row.error = lastErr || "unreachable";
  return row;
}

module.exports = {
  base,
  fetchTimeout,
  health,
  PROBED,
  listModels,
  validateModel,
  chatStream,
  transcribe,
  synthesize,
  voiceStatus,
  memoryStatus,
};
