"use strict";
/**
 * Aishe Desktop — preload bridge.
 *
 * The renderer's entire capability surface. Everything is an explicit method;
 * there is no generic "invoke any channel" escape hatch.
 */

const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("aishe", {
  /** Which panel to focus on launch (resolved in main from `--tab=`). */
  initialTab: () => call("app:initialTab"),

  health: () => call("health"),

  /** Resolved install paths, from the CLI's shared resolver. */
  core: {
    paths: () => call("core:paths"),
  },

  models: {
    list: () => call("models:list"),
    set: (model) => call("model:set", model),
  },

  chat: {
    send: (message, threadId) => call("chat:send", message, threadId),
    stop: () => call("chat:stop"),
    onEvent: (fn) => {
      const listener = (_e, payload) => fn(payload);
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.removeListener("chat:event", listener);
    },
  },

  sessions: {
    get: (id) => call("sessions:get", id),
    search: (query, limit) => call("sessions:search", query, limit),
    stats: () => call("sessions:stats"),
  },

  config: {
    load: () => call("config:load"),
    get: (key) => call("config:get", key),
    set: (key, value) => call("config:set", key, value),
    save: (obj) => call("config:save", obj),
  },

  voice: {
    backend: (action) => call("voice:backend", action),
    synthesize: (text, voice) => call("voice:synthesize", text, voice),
    transcribe: (base64, filename) => call("voice:transcribe", base64, filename),
  },

  memoryStatus: () => call("memory:status"),

});
