"use strict";
/**
 * Aishe Desktop — Electron main process.
 *
 * Owns the window, all IPC handlers, and the only path to the filesystem /
 * child processes. The renderer gets a narrow, typed API through preload.js;
 * nodeIntegration is off and contextIsolation is on.
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const os = require("os");
const path = require("path");

const services = require("./lib/services");
const sessions = require("./lib/sessions");
const cfg = require("./lib/config");
const control = require("./lib/control");

let win = null;
let chatAbort = null;

const ALLOWED_TABS = new Set(["chat", "memory", "sessions", "keys"]);

/** `--tab=keys` focuses a panel on launch. */
function initialTab() {
  const arg = process.argv.find((a) => a.startsWith("--tab="));
  if (!arg) return "chat";
  const tab = arg.slice("--tab=".length);
  return ALLOWED_TABS.has(tab) ? tab : "chat";
}

// Resolved once at startup. The renderer asks for it over IPC rather than
// reading process.argv itself: webPreferences.additionalArguments does not
// reliably surface in the preload's argv, which silently broke --tab routing.
const STARTUP_TAB = initialTab();

// Set when a later `aishe desktop --tab=x` reaches a running instance.
let STARTUP_TAB_OVERRIDE = null;

// ── single instance ────────────────────────────────────────────────────────
// Without this, every `aishe desktop` spawns another full Electron process
// (each with its own renderer + GPU process). A second launch used to pile up
// silently because nothing told the user. Now the first instance keeps the
// window and the newcomer focuses it, carrying any --tab= it was asked for.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Honour the tab the new launch asked for, then tell the renderer.
    const arg = argv.find((a) => a.startsWith("--tab="));
    if (arg) {
      const tab = arg.slice("--tab=".length);
      if (ALLOWED_TABS.has(tab)) {
        STARTUP_TAB_OVERRIDE = tab;
        win.webContents.send("aishe:tab", tab);
      }
    }
  });

  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    title: "Aishe",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => {
    win = null;
  });
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function ok(data) {
  return { ok: true, data };
}
function fail(error) {
  return { ok: false, error: String((error && error.message) || error) };
}
function handler(fn) {
  return async (_event, ...args) => {
    try {
      return ok(await fn(...args));
    } catch (e) {
      return fail(e);
    }
  };
}

/* ── app / environment ──────────────────────────────────────────────────── */

ipcMain.handle("app:initialTab", handler(async () => STARTUP_TAB_OVERRIDE || STARTUP_TAB));

/* ── health / agent ─────────────────────────────────────────────────────── */

ipcMain.handle("health", handler(() => services.health()));
ipcMain.handle("models:list", handler(() => services.listModels()));

/**
 * Switch the active model: persist it, then bounce DeepAgent so the new value
 * is actually in its environment (the model is baked in at process start).
 */
ipcMain.handle(
  "model:set",
  handler(async (model) => {
    // `model` arrives as "provider:model" from the grouped picker. DeepAgent
    // resolves its base_url and api_key from the `provider` config key, so
    // switching model alone would send the new model to the OLD provider's
    // endpoint and fail. Set both, atomically.
    const raw = String(model || "").trim();
    if (!raw) throw new Error("model must not be empty");
    const idx = raw.indexOf(":");
    const provider = idx > 0 ? raw.slice(0, idx) : "";
    const modelName = idx > 0 ? raw.slice(idx + 1) : raw;

    if (provider) {
      const known = Object.keys(cfg.get("providers", {}) || {});
      if (!known.includes(provider)) throw new Error(`unknown provider: ${provider}`);

      // Reject ids the provider does not serve BEFORE touching config. Writing
      // a bad model and restarting is what produced the "failed, but it stuck
      // anyway" behaviour — the failure only surfaces on the first real
      // request, long after the UI has moved on.
      const check = await services.validateModel(provider, modelName);
      if (!check.ok) {
        const hint = check.near && check.near.length
          ? ` — did you mean ${check.near.slice(0, 3).join(", ")}?`
          : "";
        throw new Error(check.reason + hint);
      }
      cfg.set("provider", provider);
    }
    cfg.set("model", modelName);

    const res = await control.serviceAction("deepagent", "restart");

    // Report the truth. The old code set `ready` from a socket-level check and
    // ignored a dead child, so a switch could look successful while DeepAgent
    // never came back.
    const wait = await control.waitForPort(
      control.SERVICES.deepagent.port,
      60000,
      { exited: res.exited, healthPath: "/health" }
    );
    res.ready = Boolean(wait.ok);
    if (!wait.ok) {
      res.error = wait.reason === "exited"
        ? `DeepAgent exited with code ${wait.code} — check ${res.log || "the service log"}`
        : "DeepAgent did not become ready in time";
    }
    res.model = modelName;
    res.provider = provider || cfg.get("provider", "");
    // `exited` is a live Promise. Electron serialises IPC replies with the
    // structured-clone algorithm, which cannot clone a Promise — leaving it on
    // the response made the main process throw "An object could not be cloned"
    // AFTER the restart had already succeeded, which is why the UI showed a
    // failure even though DeepAgent came back healthy.
    delete res.exited;
    if (!res.ready) throw new Error(res.error);
    return res;
  })
);

ipcMain.handle("chat:stop", handler(async () => {
  if (chatAbort) chatAbort.abort();
  chatAbort = null;
  return true;
}));

ipcMain.handle(
  "chat:send",
  handler(async (message, threadId) => {
    const sender = win && win.webContents;
    chatAbort = new AbortController();
    // Persist under the SAME id the renderer sent with. Falling back to a
    // different id here would write to a thread the History pane never reads.
    const tid = threadId || "main";
    // The user turn is written first: if the agent call throws or is aborted,
    // at least what was asked is on the record.
    try {
      sessions.addMessage(tid, "user", message);
    } catch (e) {
      console.error("[chat] could not persist user message:", e.message);
    }
    try {
      const result = await services.chatStream(
        message,
        tid,
        (ev) => {
          if (sender && !sender.isDestroyed()) sender.send("chat:event", ev);
        },
        chatAbort.signal
      );
      if (result && result.reply) {
        try {
          sessions.addMessage(tid, "assistant", result.reply);
        } catch (e) {
          console.error("[chat] could not persist reply:", e.message);
        }
      }
      return result;
    } finally {
      chatAbort = null;
    }
  })
);

/* ── memory ─────────────────────────────────────────────────────────────── */


/* ── sessions ───────────────────────────────────────────────────────────── */

ipcMain.handle("sessions:get", handler((id) => sessions.getThread(id)));
ipcMain.handle("sessions:search", handler((query, limit) => sessions.search(query, limit)));
ipcMain.handle("sessions:stats", handler(() => sessions.stats()));

/* ── config ─────────────────────────────────────────────────────────────── */

ipcMain.handle(
  "config:load",
  handler(() => {
    const { cfg: full, raw, path: p, exists, error } = cfg.load();
    return { path: p, exists, error, effective: cfg.redact(full), file: raw };
  })
);
ipcMain.handle("config:get", handler((key) => cfg.get(key)));
ipcMain.handle("config:set", handler((key, value) => {
  cfg.set(key, value);
  return { key, value };
}));
ipcMain.handle(
  "config:save",
  handler((obj) => {
    const p = cfg.save(obj);
    return { path: p };
  })
);
/* ── voice ──────────────────────────────────────────────────────────────── */

ipcMain.handle("voice:backend", handler(() => control.voiceStatus()));
ipcMain.handle("memory:status", handler(() => services.memoryStatus()));
ipcMain.handle("voice:synthesize", handler(async (text, voice) => {
  const buf = await services.synthesize(text, voice);
  return { base64: buf.toString("base64"), bytes: buf.length };
}));
ipcMain.handle("voice:transcribe", handler(async (base64, filename) => {
  const buf = Buffer.from(String(base64).replace(/^data:[^,]+,/, ""), "base64");
  return { text: await services.transcribe(buf, filename) };
}));
