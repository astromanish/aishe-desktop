"use strict";
/**
 * Aishe Desktop — CLI bridge and service lifecycle.
 *
 * One job: lifecycle — start/stop the background services (DeepAgent, Qdrant,
 * Ollama), which the CLI itself has no command for. The old runCli() CLI bridge
 * was removed when the Services/Config/Doctor panels went away.
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = require("./config");
const services = require("./services");
const core = require("./core");

const HOME = os.homedir();
const CLI = process.env.AISHE_CLI || "aishe";
const REPO = path.resolve(__dirname, "..", "..");
/**
 * Locate the deepagent directory.
 *
 * The desktop app used to live inside aishe-cli, so `REPO/deepagent` was
 * correct. It was since moved out to its own project, which left this pointing
 * at a path that does not exist — every `serviceAction("deepagent", …)` threw
 * "venv missing", which is what made model switching fail while looking like a
 * restart had happened.
 *
 * Resolution now goes through the CLI's shared resolver (`aishe_core`), so the
 * desktop and the CLI can never disagree about where the backend is. The
 * local probe below is only the fallback for when the CLI is not installed.
 */
function resolveDeepAgentDir() {
  // The shared resolver is authoritative when reachable.
  try {
    const fromCore = core.deepagentDir();
    if (fromCore && fs.existsSync(path.join(fromCore, "server.py"))) return fromCore;
  } catch (e) { /* fall through to the local probe */ }

  if (process.env.AISHE_DEEPAGENT_DIR) return process.env.AISHE_DEEPAGENT_DIR;
  const candidates = [
    path.join(REPO, "deepagent"),                    // legacy: beside the app
    path.join(REPO, "aishe-cli", "deepagent"),       // current layout
    path.join(HOME, ".local", "share", "aishe-cli", "deepagent"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "server.py"))) return c;
  }
  return candidates[candidates.length - 1];
}
const DEEPAGENT_DIR = resolveDeepAgentDir();
const DEEPAGENT_VENV = path.join(DEEPAGENT_DIR, ".venv", "bin", "python");
const DEEPAGENT_SERVER = path.join(DEEPAGENT_DIR, "server.py");
const STATE_DIR = process.env.AISHE_STATE_DIR || path.join(HOME, ".local", "state", "aishe", "voice");
const QDRANT_BIN = path.join(HOME, ".local", "bin", "qdrant");
const QDRANT_DATA = path.join(HOME, ".local", "share", "aishe-cli", "qdrant");
const DEEPAGENT_ENV = path.join(HOME, "aishe", "deepagent.env");

/* ── voice backend switch ───────────────────────────────────────────────── */

/**
 * Voice backend status. Voice is Sarvam cloud (Saaras v3 + Bulbul v3) — there
 * are no local STT/TTS sidecars to start or stop, so this reports cloud
 * readiness rather than shelling out to the retired `aishe-voice` port-swap
 * script, which only existed to serve the old :5093 / :8766 sidecars.
 */
function voiceStatus() {
  return services.voiceStatus();
}

/* ── service lifecycle ──────────────────────────────────────────────────── */

function portPids(port) {
  return new Promise((resolve) => {
    execFile("ss", ["-tlnpH", `sport = :${port}`], (err, stdout) => {
      if (err) return resolve([]);
      const pids = [...String(stdout).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      resolve([...new Set(pids)]);
    });
  });
}

function killPids(pids, signal = "SIGTERM") {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (e) {
      /* already gone */
    }
  }
}

const SERVICES = {
  deepagent: { port: 8765, label: "DeepAgent" },
  ollama: { port: 11434, label: "Ollama" },
  qdrant: { port: 6333, label: "Qdrant" },
};

function parseEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/**
 * Spawn a detached background service.
 *
 * stderr is captured to the service log instead of /dev/null: with stdio
 * "ignore" a service that fails on startup (bad model id, missing venv, bad
 * provider credentials) dies silently and the caller still reports success,
 * which is exactly how a model switch could look like it worked while leaving
 * DeepAgent dead.
 *
 * Returns { pid, log, exited } — `exited` is a promise that resolves with the
 * exit code if the process dies early, so callers can fail loudly.
 */
function spawnDetached(cmd, args, opts = {}) {
  const logName = String(opts.logName || path.basename(cmd, ".py") + ".log");
  let logStream = "ignore";
  let logPath = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    logPath = path.join(STATE_DIR, logName);
    logStream = fs.openSync(logPath, "a");
  } catch (e) {
    logStream = "ignore";
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logStream, logStream],
    ...opts,
  });
  child.unref();

  // Resolves only if the process exits — stays pending while it is healthy.
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });

  return { pid: child.pid, log: logPath, exited };
}

async function serviceAction(name, action) {
  const svc = SERVICES[name];
  if (!svc) throw new Error(`unknown service: ${name}`);
  if (!["start", "stop", "restart"].includes(action)) throw new Error(`invalid action: ${action}`);

  if (action === "stop" || action === "restart") {
    const pids = await portPids(svc.port);
    killPids(pids, "SIGTERM");
    // give it a moment, then insist
    await new Promise((r) => setTimeout(r, 1500));
    const still = await portPids(svc.port);
    if (still.length) {
      killPids(still, "SIGKILL");
      await new Promise((r) => setTimeout(r, 800));
    }
    if (action === "stop") return { ok: true, action, service: name, stopped: true };
  }

  if (name === "deepagent") {
    if (!fs.existsSync(DEEPAGENT_VENV)) throw new Error(`DeepAgent venv missing at ${DEEPAGENT_VENV}`);
    // The ACTIVE model/provider lives in config.yaml — that is what makes
    // switching models in the UI take effect. The env file is only a fallback
    // for settings config doesn't carry (host/port, embed model).
    const provider = cfg.get("provider", "");
    const pd = cfg.defaults().providers[provider] || {};
    const env = {
      ...process.env,
      ...parseEnvFile(DEEPAGENT_ENV),
      AISHE_MODEL: String(cfg.get("model", "") || ""),
      AISHE_BASE_URL: String(cfg.get(`providers.${provider}.base_url`, pd.base_url || "") || ""),
      AISHE_API_KEY: String(cfg.get(`providers.${provider}.api_key`, pd.api_key || "") || ""),
    };
    if (!env.AISHE_MODEL) throw new Error("no model set in config — run `aishe setup`");
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const spawned = spawnDetached(DEEPAGENT_VENV, ["server.py"], {
      cwd: DEEPAGENT_DIR,
      env,
      logName: "deepagent.log",
    });
    return {
      ok: true, action, service: name,
      pid: spawned.pid, log: spawned.log,
      model: env.AISHE_MODEL, provider,
      exited: spawned.exited,
    };
  }

  if (name === "qdrant") {
    if (!fs.existsSync(QDRANT_BIN)) throw new Error(`qdrant binary missing at ${QDRANT_BIN}`);
    fs.mkdirSync(QDRANT_DATA, { recursive: true });
    const spawned = spawnDetached(QDRANT_BIN, [], { cwd: QDRANT_DATA, logName: "qdrant.log" });
    return { ok: true, action, service: name, pid: spawned.pid, log: spawned.log, exited: spawned.exited };
  }

  if (name === "ollama") {
    const spawned = spawnDetached("ollama", ["serve"], { logName: "ollama.log" });
    return { ok: true, action, service: name, pid: spawned.pid, log: spawned.log, exited: spawned.exited };
  }

  throw new Error(`cannot start ${name}`);
}

/**
 * Wait until a service answers on its port, or give up.
 *
 * Polls with a real HTTP request rather than `ss`: a socket in LISTEN is not
 * the same as an app that can serve, and DeepAgent only binds 127.0.0.1 while
 * uvicorn takes a few seconds to accept. `exited` short-circuits the wait when
 * the process dies on startup, so a broken model id fails in ~1s instead of
 * hanging for the full timeout.
 */
async function waitForPort(port, timeoutMs = 45000, opts = {}) {
  const healthPath = opts.healthPath || "/health";
  const exited = opts.exited || null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Dead process: no point waiting the full timeout.
    if (exited) {
      const code = await Promise.race([
        exited,
        new Promise((r) => setTimeout(() => r(null), 0)),
      ]);
      if (code !== null) return { ok: false, reason: "exited", code };
    }
    const pids = await portPids(port);
    if (pids.length) {
      try {
        const r = await services.fetchTimeout(`http://localhost:${port}${healthPath}`, {}, 2500);
        if (r.ok) return { ok: true, pid: pids[0] };
      } catch (e) {
        /* still booting */
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, reason: "timeout" };
}

module.exports = {
  voiceStatus,
  serviceAction,
  portPids,
  waitForPort,
  SERVICES,
  DEEPAGENT_SERVER,
  paths: { REPO, DEEPAGENT_DIR, DEEPAGENT_VENV, DEEPAGENT_SERVER, QDRANT_BIN, QDRANT_DATA, STATE_DIR },
};
