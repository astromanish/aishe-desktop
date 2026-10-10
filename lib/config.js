"use strict";
/**
 * Aishe Desktop — config layer.
 *
 * Mirrors aishe_pkg/config.py: same file, same defaults, same dot-notation
 * get/set semantics, so the GUI and the CLI can never disagree about config.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "aishe") : path.join(os.homedir(), ".config", "aishe");
}

function configPath() {
  return path.join(configDir(), "config.yaml");
}

function dataDir() {
  return path.join(os.homedir(), "aishe");
}

/** Same shape as DEFAULT_CONFIG in aishe_pkg/config.py. */
function defaults() {
  return {
    model: "deepseek-v4-flash",
    provider: "",
    providers: {
      sarvam: { base_url: "https://api.sarvam.ai/v1", api_key: "" },
      "ollama-cloud": { base_url: "http://localhost:11434", api_key: "" },
      local: { base_url: "http://localhost:8080", api_key: "" },
      openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "" },
      "opencode-go": { base_url: "https://opencode.ai/zen/go/v1", api_key: "" },
    },
    services: {
      deepagent: "http://localhost:8765",
      ollama: "http://localhost:11434",
      // qdrant is not in the CLI's DEFAULT_CONFIG, but the app's Services panel
      // and health checks both need it — without an entry here its probe URL is
      // undefined and it renders as permanently down.
      qdrant: "http://localhost:6333",
      // Voice has NO local service — it runs on Sarvam's cloud API. Do not add
      // stt/tts entries here; the old :5093 / :8766 sidecars were removed.
    },
    voice: {
      default_voice: "shubh",
      language_code: "en-IN",
      stt_model: "saaras:v3",
      tts_model: "bulbul:v3",
      stt_mode: "transcribe",
      recording_duration: 5,
      vad_enabled: true,
      vad_threshold: 0.5,
      vad_min_speech_duration_ms: 250,
      vad_min_silence_duration_ms: 500,
    },
    live: { silence_ms: 500, min_speech_ms: 250, rms_threshold: 0.018 },
    data: { dir: dataDir() },
    telegram: { token: "", allowed_users: [], allow_all: false, log_file: path.join(dataDir(), "telegram.log") },
    ui: { color: true },
  };
}

function deepMerge(base, override) {
  for (const [k, v] of Object.entries(override || {})) {
    if (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && v && typeof v === "object" && !Array.isArray(v)) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/** Load config merged over defaults. Returns { cfg, raw, path, exists }. */
function load() {
  const cfg = defaults();
  const p = configPath();
  let raw = null;
  if (fs.existsSync(p)) {
    try {
      raw = yaml.load(fs.readFileSync(p, "utf8")) || {};
      deepMerge(cfg, raw);
    } catch (e) {
      return { cfg, raw: null, path: p, exists: true, error: String(e.message || e) };
    }
  }
  return { cfg, raw: raw || {}, path: p, exists: fs.existsSync(p) };
}

function save(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(cfg, { sortKeys: false, lineWidth: 120 }), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600); // provider keys live here
  } catch (e) {
    /* best effort */
  }
  return p;
}

function deepGet(obj, parts) {
  let cur = obj;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in cur) cur = cur[part];
    else return undefined;
  }
  return cur;
}

function get(key, fallback) {
  const { cfg } = load();
  const v = deepGet(cfg, String(key).split("."));
  return v === undefined ? fallback : v;
}

/** Set a dot-notation key, coercing to the type of the existing default. */
function set(key, value) {
  const { cfg } = load();
  const parts = String(key).split(".");
  let target = cfg;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  const leaf = parts[parts.length - 1];
  const current = deepGet(cfg, parts);
  let coerced = value;
  if (typeof current === "boolean") coerced = ["true", "yes", "1"].includes(String(value).toLowerCase());
  else if (typeof current === "number") coerced = Number(value);
  else if (Array.isArray(current)) {
    try {
      coerced = JSON.parse(value);
    } catch (e) {
      coerced = String(value).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  target[leaf] = coerced;
  save(cfg);
  return coerced;
}

/** Redact provider API keys for display. */
function redact(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  for (const p of Object.values(copy.providers || {})) {
    if (p && p.api_key) p.api_key = p.api_key.slice(0, 7) + "…" + p.api_key.slice(-4);
  }
  if (copy.telegram && copy.telegram.token) {
    const t = copy.telegram.token;
    copy.telegram.token = t.slice(0, 6) + "…" + t.slice(-4);
  }
  return copy;
}

module.exports = { configDir, configPath, dataDir, defaults, load, save, get, set, redact, deepGet };
