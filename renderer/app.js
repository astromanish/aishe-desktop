"use strict";
/**
 * Aishe Desktop — renderer.
 * Every capability exposed here maps to an `aishe` CLI command or a DeepAgent
 * endpoint; nothing is invented.
 */

const $ = (id) => document.getElementById(id);

/* ── helpers ────────────────────────────────────────────────────────────── */

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", Boolean(isErr));
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}

/** Unwrap {ok,data|error} from the preload bridge. */
function unwrap(res, label) {
  if (res && res.ok) return res.data;
  const msg = (res && res.error) || "unknown error";
  if (label) toast(`${label}: ${msg}`, true);
  throw new Error(msg);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── minimal, safe Markdown → HTML (input escaped first → CSP-safe) ─────── */

function renderInline(s) {
  // links first (brackets + parens), restricted to http(s) for safety
  let t = s.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => `<a class="md" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`);
  t = t.replace(/`([^`]+)`/g, `<code class="md">$1</code>`);     // `inline`
  t = t.replace(/\*\*([^*]+)\*\*/g, `<strong class="md">$1</strong>`); // **bold**
  t = t.replace(/(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])/g, "<em class=\"md\">$1</em>"); // *italic*
  return t;
}

function renderMarkdown(src) {
  if (!src) return "";
  const lines = escapeHtml(String(src)).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const inline = renderInline;
  while (i < lines.length) {
    const line = lines[i];
    // ── fenced code block ──
    const fence = line.match(/^`{3,}([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^`{3,}\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(`<pre class="md"><span class="md-lang">${escapeHtml(lang)}</span><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    if (!line.trim()) { out.push(""); i++; continue; } // blank
    // ── heading ──
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length} class="md">${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    // ── hr ──
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr class="md">'); i++; continue; }
    // ── blockquote ──
    if (/^&gt;/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt;/.test(lines[i])) { buf.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
      out.push(`<blockquote class="md">${buf.map(inline).join("")}</blockquote>`);
      continue;
    }
    // ── bullet list ──
    if (/^([-*+])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^([-*+])\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*+]\s+/, "")); i++; }
      out.push(`<ul class="md">${items.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
      continue;
    }
    // ── numbered list ──
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      out.push(`<ol class="md">${items.map((li) => `<li>${inline(li)}</li>`).join("")}</ol>`);
      continue;
    }
    out.push(`<p class="md">${inline(line)}</p>`);
    i++;
  }
  return out.join("\n");
}

/* ── navigation: right rail views + grouped sub-panes ───────────────────── */

const VIEWS = ["chat", "history", "keys"];
const TABS = { chat: "chat", sessions: "history", keys: "keys" };
const SUBS = { chat: "chat", sessions: "sessions", keys: "keys" };

/** Providers whose API keys this tab manages. */
const KEY_PROVIDERS = [
  { id: "sarvam",       label: "Sarvam" },
  { id: "openrouter",   label: "OpenRouter" },
  { id: "ollama-cloud", label: "Ollama Cloud" },
];

/* ── Voice options ─────────────────────────────────────────────────────────
 * The option lists mirror what Sarvam's API actually accepts, verified against
 * the live endpoints:
 *   - speakers: the 37-name Bulbul roster (a rejected name 400s and the error
 *     lists the valid ones)
 *   - STT modes: transcribe | translate | verbatim | translit | codemix
 *   - models: bulbul:v3 is the only Bulbul version compatible with this
 *     speaker roster, so TTS has one option today; STT is saaras:v3.
 * Do not offer a value here that the API would reject — the dropdown would
 * write config that breaks every subsequent voice call.
 */
const VOICE_SPEAKERS = [
  "aditya", "ritu", "ashutosh", "priya", "neha", "rahul", "pooja", "rohan",
  "simran", "kavya", "amit", "dev", "ishita", "shreya", "ratan", "varun",
  "manan", "sumit", "roopa", "kabir", "aayan", "shubh", "advait", "anand",
  "tanya", "tarun", "sunny", "mani", "gokul", "vijay", "shruti", "suhani",
  "mohit", "kavitha", "rehan", "soham", "rupali",
];
const VOICE_STT_MODELS = ["saaras:v3"];
const VOICE_TTS_MODELS = ["bulbul:v3"];
const VOICE_STT_MODES = [
  { value: "transcribe", label: "transcribe — text in the spoken language" },
  { value: "translate",  label: "translate — always English text" },
  { value: "verbatim",   label: "verbatim — exact words, no cleanup" },
  { value: "translit",   label: "translit — romanised" },
  { value: "codemix",    label: "codemix — mixed language" },
];
const VOICE_LANGUAGES = [
  "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN",
  "od-IN", "pa-IN", "ta-IN", "te-IN", "as-IN",
];

let currentView = "chat";

/** Load whatever the visible pane needs. */
function loadForView(view) {
  if (view === "history") loadSessions();
  if (view === "keys") loadKeys();
  if (view === "keys") loadMemoryStatus();
  if (view === "keys") loadVoice();
}

function showView(view) {
  if (!VIEWS.includes(view)) view = "chat";
  currentView = view;
  for (const v of VIEWS) $("view-" + v).classList.toggle("is-active", v === view);
  document.querySelectorAll(".rail-btn[data-view]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.view === view);
  });
  loadForView(view);
}

/** Activate one pane inside a grouped view (history / settings). */
function showPane(group, sub) {
  const view = $("view-" + group);
  if (!view) return;
  view.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.sub === sub));
  view.querySelectorAll(".pane").forEach((p) => p.classList.toggle("is-active", p.id === "pane-" + sub));
  if (sub === "sessions") loadSessions();
  if (sub === "keys") loadKeys();
  if (sub === "keys") loadMemoryStatus();
  if (sub === "keys") loadVoice();
}

document.querySelectorAll(".rail-btn[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.closest(".view");
    const group = view.id.replace(/^view-/, "");
    showPane(group, btn.dataset.sub);
  });
});

/** Empty-state is shown only while the transcript is empty. */
function updateChatEmpty() {
  const empty = $("chat-empty");
  if (!empty) return;
  empty.style.display = messagesEl.querySelector(".msg") ? "none" : "flex";
}

/* ── health ─────────────────────────────────────────────────────────────── */

async function refreshHealth() {
  try {
    const h = unwrap(await window.aishe.health());
    // The top bar was removed, so nothing renders the per-service dots here.
    // The authoritative per-component view now lives in the Keys → Memory
    // section (Embedder / Memory plugin / Vector database).
    return h;
  } catch (e) {
    toast("health check failed: " + e.message, true);
    return null;
  }
}

// ── thread + speak state ───────────────────────────────────────────────── //
// Single-thread mode: all surfaces share ONE conversation id, so Aishe carries
// context from CLI / Telegram into the desktop chat. The `+` button no longer
// mints a new id — it clears the visible transcript while keeping the thread.

const MAIN_THREAD = "main";

function setThread(id) {
  $("chat-thread").value = id;
}

/** Thread id used for every message (single shared conversation). */
function currentThread() {
  return $("chat-thread").value.trim() || MAIN_THREAD;
}

function setSpeakUI() {
  const on = $("chat-speak").checked;
  $("btn-speak").classList.toggle("on", on);
  $("btn-speak").title = on ? "Speaking replies — click to mute" : "Speak replies";
  const use = $("speak-icon").querySelector("use");
  if (use) use.setAttribute("href", on ? "#i-volume" : "#i-volume-off");
}

/* ── CHAT ───────────────────────────────────────────────────────────────── */

const messagesEl = $("messages");
let chatBusy = false;
let currentTool = null;

function addMessage(who, text, cls = "") {
  const wrap = el("div", "msg " + cls);
  wrap.appendChild(el("div", "who", who));
  const body = el("div", "body");
  // assistant text is markdown; everything else stays literal
  if (who === "aishe") {
    body.classList.add("md");
    body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text;
  }
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateChatEmpty();
  return wrap;
}

let currentToolGroup = null; // the collapsible box for the current assistant turn
let toolCount = 0;
let pendingReplyMsg = null;  // the assistant bubble being streamed; tools go above it

function ensureToolGroup() {
  if (currentToolGroup) return currentToolGroup;
  const box = el("div", "tool-box");
  const toggle = el("button", "tool-toggle");
  toggle.type = "button";
  const nm = el("span", "tool-count", "0 tool calls");
  toggle.appendChild(nm);
  toggle.appendChild(el("span", "tool-caret", "▾"));
  box.appendChild(toggle);
  const body = el("div", "tool-body");
  box.appendChild(body);
  box.dataset.open = "1";
  toggle.addEventListener("click", () => {
    const open = box.dataset.open !== "1";
    box.dataset.open = open ? "1" : "0";
    box.querySelector(".tool-caret").textContent = open ? "▾" : "▸";
  });
  currentToolGroup = { box, toggle, body };
  // Insert above the in-flight assistant reply so tool calls read in order:
  // user → tools → answer.
  if (pendingReplyMsg && pendingReplyMsg.parentNode) {
    messagesEl.insertBefore(box, pendingReplyMsg);
  } else {
    messagesEl.appendChild(box);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return currentToolGroup;
}

function updateToolCount() {
  if (!currentToolGroup) return;
  currentToolGroup.toggle.querySelector(".tool-count").textContent =
    `${toolCount} tool call${toolCount === 1 ? "" : "s"}`;
}

function addToolLine(name, args) {
  const g = ensureToolGroup();
  toolCount++;
  updateToolCount();
  const n = el("div", "tool");
  const head = el("div", "tool-head");
  const nm = el("span", "tool-name", escapeHtml(name || "tool"));
  nm.title = escapeHtml(args || "");
  head.appendChild(nm);
  head.appendChild(el("span", "tool-args", escapeHtml(String(args || ""))));
  n.appendChild(head);
  g.body.appendChild(n);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  currentTool = n;
  return n;
}

function appendToolResult(box, result) {
  if (!box) return;
  const r = el("div", "tool-result");
  r.textContent = "→ " + String(result || "").slice(0, 400);
  box.appendChild(r);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finalizeToolGroup() {
  if (!currentToolGroup) return;
  // close the group by default once the turn finishes; keep the header
  currentToolGroup.box.dataset.open = "0";
  currentToolGroup.box.querySelector(".tool-caret").textContent = "▸";
  currentToolGroup = null;
  pendingReplyMsg = null;
}

window.aishe.chat.onEvent((ev) => {
  if (!ev || !ev.event) return;
  if (ev.event === "tool_call") {
    addToolLine(ev.name || "tool", ev.args || "");
  } else if (ev.event === "tool_result") {
    appendToolResult(currentTool, ev.result || "");
    currentTool = null;
  }
});

async function sendChat() {
  if (chatBusy) return;
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const thread = currentThread();
  input.value = "";
  autoGrow(input);
  toolCount = 0;
  addMessage("you", text, "user");
  setChatBusy(true);

  const pending = addMessage("aishe", "…", "");
  pendingReplyMsg = pending;
  const bodyEl = pending.querySelector(".body");

  try {
    const res = await window.aishe.chat.send(text, thread);
    const data = unwrap(res, "chat");
    bodyEl.innerHTML = renderMarkdown(data.reply);
    finalizeToolGroup();
    const meta = el("div", "meta", `${data.toolCalls.length} tool call(s) · ${data.durationMs || "?"} ms`);
    pending.appendChild(meta);
    if ($("chat-speak").checked && data.reply) speak(data.reply);
  } catch (e) {
    finalizeToolGroup();
    pending.classList.add("error");
    bodyEl.textContent = "error: " + e.message;
  } finally {
    setChatBusy(false);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

/** The composer button is one control: send when idle, stop while streaming. */
function setChatBusy(busy) {
  chatBusy = busy;
  const btn = $("btn-chat-send");
  btn.classList.toggle("busy", busy);
  btn.title = busy ? "Stop" : "Send";
  btn.setAttribute("aria-label", busy ? "Stop" : "Send");
  const use = $("send-icon").querySelector("use");
  if (use) use.setAttribute("href", busy ? "#i-stop" : "#i-send");
}

$("btn-chat-send").addEventListener("click", async () => {
  if (chatBusy) {
    unwrap(await window.aishe.chat.stop());
    toast("stopped");
    return;
  }
  sendChat();
});
// Clear lives in the chat composer meta row — the rail stays icon-only for nav.
$("btn-clear-chat").addEventListener("click", () => {
  messagesEl.innerHTML = "";
  currentToolGroup = null;
  currentTool = null;
  toolCount = 0;
  pendingReplyMsg = null;
  updateChatEmpty();
  toast("transcript cleared");
});
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

/* ── composer controls: model picker, dictate, speak ────────────────────── */

let activeModel = "";      // bare model name, e.g. "deepseek-v4-flash"
let activeProvider = "";   // provider that model belongs to

/**
 * Render the picker as one optgroup per configured provider.
 *
 * Values are "provider:model" because DeepAgent resolves its base_url and
 * api_key from the `provider` config key — selecting a model from another
 * provider without also switching provider would send it to the wrong endpoint.
 */
function renderModelSelect(data, currentModel, currentProvider) {
  const sel = $("model-select");
  sel.innerHTML = "";
  const providers = data.providers || [];
  const usable = providers.filter((p) => p.models && p.models.length);

  if (!usable.length) {
    const why = providers.length
      ? providers.map((p) => `${p.name}: ${p.error || "no models"}`).join("; ")
      : "no providers configured";
    sel.appendChild(new Option(`no models (${why})`, ""));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;

  for (const p of usable) {
    const group = document.createElement("optgroup");
    // Mark the active provider so the current selection is findable at a glance.
    group.label = p.name + (p.name === currentProvider ? "  (active)" : "");
    for (const m of p.models) {
      const value = `${p.name}:${m}`;
      const o = new Option(m, value);
      if (m === currentModel && p.name === currentProvider) o.selected = true;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }

  // Keep a configured model selectable even if its provider listed nothing,
  // so the current value is never silently lost.
  if (currentModel && !usable.some((p) => p.name === currentProvider && p.models.includes(currentModel))) {
    const o = new Option(`${currentModel} (current)`, `${currentProvider || ""}:${currentModel}`);
    o.selected = true;
    sel.appendChild(o);
  }
}

async function loadModels() {
  const state = $("model-state");
  try {
    const [modelsRes, healthRes] = await Promise.all([window.aishe.models.list(), window.aishe.health()]);
    const r = unwrap(modelsRes);
    const h = healthRes && healthRes.ok ? healthRes.data : null;
    activeProvider = (h && h.provider) || r.provider || "";
    activeModel = (h && h.model) || activeModel || "";
    renderModelSelect(r, activeModel, activeProvider);
    state.textContent = r.error ? `· ${r.error}` : "";
  } catch (e) {
    state.textContent = "· " + e.message;
  }
}

// Changing the model rewrites config (model + provider) and restarts DeepAgent,
// so it is applied on change rather than needing a separate save button.
$("model-select").addEventListener("change", async (e) => {
  const value = e.target.value;
  if (!value) return;
  const idx = value.indexOf(":");
  const provider = idx > 0 ? value.slice(0, idx) : "";
  const model = idx > 0 ? value.slice(idx + 1) : value;
  if (model === activeModel && provider === activeProvider) return;

  const state = $("model-state");
  state.textContent = "switching…";
  try {
    const r = unwrap(await window.aishe.models.set(value), "model switch");
    activeModel = model;
    activeProvider = provider || activeProvider;
    state.textContent = r.ready ? "· ready" : "· started";
    toast(`model → ${provider ? provider + " / " : ""}${model}`);
    setTimeout(() => { state.textContent = ""; }, 4000);
  } catch (err) {
    state.textContent = "· failed";
    toast("model switch failed: " + err.message, true);
  }
});

$("btn-speak").addEventListener("click", () => {
  const cb = $("chat-speak");
  cb.checked = !cb.checked;
  setSpeakUI();
  toast(cb.checked ? "replies will be spoken" : "voice muted");
});

// Dictate: record, transcribe, drop the text into the composer for review.
$("btn-mic").addEventListener("click", async () => {
  if (recorder.active) {
    recorder.stop();
    return;
  }
  try {
    $("btn-mic").classList.add("rec");
    toast("listening…");
    await recorder.start((text, err) => {
      $("btn-mic").classList.remove("rec");
      if (err) return toast("dictation failed: " + err, true);
      const input = $("chat-input");
      input.value = (input.value ? input.value + " " : "") + text;
      autoGrow(input);
      input.focus();
      if (!text) toast("nothing transcribed", true);
    });
  } catch (e) {
    $("btn-mic").classList.remove("rec");
    toast("microphone unavailable: " + e.message, true);
  }
});

/* ── VOICE ──────────────────────────────────────────────────────────────── */

async function speak(text) {
  const r = unwrap(await window.aishe.voice.synthesize(text), "tts");
  const player = new Audio("data:audio/wav;base64," + r.base64);
  await player.play().catch(() => {});
  return r;
}

/* ── recording → 16 kHz mono WAV → STT ──────────────────────────────────── */

/**
 * Shared recorder for BOTH the composer dictate button and the Settings
 * Listen buttons: capture → 16 kHz mono WAV → active STT backend → callback.
 */
const recorder = (() => {
  let media = null;
  let chunks = [];
  let active = false;

  async function start(onDone) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    media = new MediaRecorder(stream);
    media.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    media.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      active = false;
      try {
        const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : "audio/webm" });
        const b64 = await toBase64Wav(blob);
        const r = await window.aishe.voice.transcribe(b64, "speech.wav");
        if (!r.ok) throw new Error(r.error || "transcription failed");
        onDone(r.data.text || "", null);
      } catch (e) {
        onDone("", String(e.message || e));
      }
    };
    media.start();
    active = true;
  }

  function stop() {
    if (media && media.state !== "inactive") media.stop();
  }

  return { start, stop, get active() { return active; } };
})();

function encodeWav16k(float32, sampleRate) {
  const target = 16000;
  const ratio = sampleRate / target;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = float32[Math.floor(i * ratio)];

  const buffer = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + outLen * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, outLen * 2, true);
  let off = 44;
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buffer);
}

async function toBase64Wav(blob) {
  const arr = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(arr);
  await ctx.close();
  const ch = decoded.getChannelData(0);
  const wav = encodeWav16k(ch, decoded.sampleRate);
  let bin = "";
  for (let i = 0; i < wav.length; i++) bin += String.fromCharCode(wav[i]);
  return btoa(bin);
}

/* ── SESSIONS ───────────────────────────────────────────────────────────── */

/**
 * Render an ISO timestamp as something a person can read.
 *
 * The DB stores naive local-time strings like "2026-10-10T16:26:11.048590"
 * with no offset, so it is parsed as local time (not UTC — appending "Z"
 * would shift every message by the IST offset and show the wrong hour).
 * Today's messages show just the clock; older ones get the date too.
 */
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(String(ts).replace(" ", "T"));
  if (isNaN(d.getTime())) return String(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString([], sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
  return `${date}, ${time}`;
}

/** One transcript row. `role` is shown as a label, content below it. */
function sesRow(m) {
  const n = el("div", "item");
  const g = el("div", "grow");
  g.appendChild(el("div", "sub", `${m.role} · ${fmtTime(m.timestamp)}`));
  g.appendChild(el("div", "title", m.content));
  n.appendChild(g);
  return n;
}

async function loadSessions() {
  const box = $("ses-detail");
  try {
    const st = unwrap(await window.aishe.sessions.stats());
    $("ses-stats").textContent = st.available
      ? `${st.messages} messages · ${(st.sizeBytes / 1024).toFixed(0)} KB`
      : "database unavailable";

    // Single-thread architecture: there is exactly one conversation, so the
    // pane renders that thread's messages directly.
    const th = unwrap(await window.aishe.sessions.get(MAIN_THREAD));
    box.textContent = "";

    const msgs = th.messages || [];
    if (!msgs.length) {
      box.appendChild(el("p", "muted pad", "No messages in this conversation yet."));
      return;
    }
    for (const m of msgs) box.appendChild(sesRow(m));
  } catch (e) {
    box.textContent = "";
    box.appendChild(el("p", "muted pad", "sessions: " + e.message));
  }
}

$("btn-ses-reload").addEventListener("click", loadSessions);

$("btn-ses-search").addEventListener("click", async () => {
  const q = $("ses-query").value.trim();
  // An empty box means "show the transcript again", not "search for nothing".
  if (!q) return loadSessions();
  const box = $("ses-detail");
  try {
    const hits = unwrap(await window.aishe.sessions.search(q, 100));
    box.textContent = "";
    if (!hits.length) {
      box.appendChild(el("p", "muted pad", `No matches for "${q}".`));
      return;
    }
    $("ses-stats").textContent =
      `${hits.length} match(es) · clear the box and reload for the full transcript`;
    for (const h of hits) box.appendChild(sesRow(h));
  } catch (e) {
    box.textContent = "";
    box.appendChild(el("p", "muted pad", "search: " + e.message));
  }
});

/* ── API KEYS ──────────────────────────────────────────────────────────── */

/** Render one row per provider with its (redacted) key and an editable field. */
async function loadKeys() {
  const c = unwrap(await window.aishe.config.load());
  const box = $("key-rows");
  box.textContent = "";
  for (const prov of KEY_PROVIDERS) {
    const current = ((c.effective || {}).providers || {})[prov.id] || {};
    const stored = current.api_key || "";
    const row = el("div", "key-row");
    row.innerHTML = `
      <div class="key-meta">
        <b>${prov.label}</b>
      </div>
      <input type="password" class="key-input" data-provider="${prov.id}"
             placeholder="${stored ? "saved — type to replace" : "not set"}"
             autocomplete="off" spellcheck="false" />
      <span class="key-state mono">${stored || "—"}</span>`;
    box.appendChild(row);
  }
}

$("btn-keys-reload").addEventListener("click", () => loadKeys());

$("btn-keys-save").addEventListener("click", async () => {
  const inputs = [...document.querySelectorAll(".key-input")];
  let saved = 0;
  try {
    for (const input of inputs) {
      const value = input.value.trim();
      // An untouched field must NOT overwrite a key that already exists.
      if (!value) continue;
      unwrap(await window.aishe.config.set(`providers.${input.dataset.provider}.api_key`, value));
      input.value = "";
      saved++;
    }
    await loadKeys();
    await refreshHealth();
    $("keys-result").textContent = saved
      ? `saved ${saved} key${saved === 1 ? "" : "s"}`
      : "nothing to save — type a key first";
    toast(saved ? `saved ${saved} key${saved === 1 ? "" : "s"}` : "no keys entered");
  } catch (e) {
    $("keys-result").textContent = "error: " + e.message;
    toast("save failed: " + e.message, true);
  }
});

/* ── memory stack status ───────────────────────────────────────────────── */

/** One status row: label, Active/Inactive pill, and the reason or detail. */
function memRow(label, sub, row) {
  const item = el("div", "item");
  const g = el("div", "grow");
  g.appendChild(el("div", "title", label));
  g.appendChild(el("div", "sub", sub || ""));
  item.appendChild(g);

  const pill = el("span", "pill " + (row.ok ? "on" : "off"));
  pill.textContent = row.ok ? "Active" : "Inactive";
  item.appendChild(pill);

  const detail = el("div", "key-state mono");
  detail.textContent = row.detail || "";
  item.appendChild(detail);
  return item;
}

async function loadMemoryStatus() {
  const box = $("mem-rows");
  box.textContent = "";
  try {
    const m = unwrap(await window.aishe.memoryStatus());
    box.appendChild(memRow("Embedder", "Ollama serving the embedding model", m.embedder));
    box.appendChild(memRow("Memory plugin", "mem0 inside DeepAgent", m.plugin));
    box.appendChild(memRow("Vector database", "Qdrant holding the collection", m.vector));
  } catch (e) {
    box.textContent = "";
    box.appendChild(el("p", "muted pad", "could not probe memory: " + e.message));
  }
}

$("btn-mem-recheck").addEventListener("click", () => loadMemoryStatus());

/* ── VOICE settings ────────────────────────────────────────────────────── */

/** One labelled dropdown row inside the Voice card. */
function voiceRow(label, key, options, current) {
  const row = el("div", "key-row");
  const meta = el("div", "key-meta");
  meta.appendChild(el("b", "", label));
  row.appendChild(meta);

  const sel = el("select", "key-input");
  sel.dataset.key = key;
  for (const opt of options) {
    const value = typeof opt === "string" ? opt : opt.value;
    const text = typeof opt === "string" ? opt : opt.label;
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    if (value === current) o.selected = true;
    sel.appendChild(o);
  }
  row.appendChild(sel);
  return row;
}

async function loadVoice() {
  const box = $("voice-rows");
  box.textContent = "";
  try {
    const c = unwrap(await window.aishe.config.load());
    const v = (c.effective && c.effective.voice) || {};
    const cfgGet = (k, d) => (v[k] === undefined ? d : v[k]);

    box.appendChild(voiceRow("STT model", "voice.stt_model", VOICE_STT_MODELS, cfgGet("stt_model", "saaras:v3")));
    box.appendChild(voiceRow("STT mode", "voice.stt_mode", VOICE_STT_MODES, cfgGet("stt_mode", "transcribe")));
    box.appendChild(voiceRow("TTS model", "voice.tts_model", VOICE_TTS_MODELS, cfgGet("tts_model", "bulbul:v3")));
    box.appendChild(voiceRow("Speaker", "voice.default_voice", VOICE_SPEAKERS, cfgGet("default_voice", "shubh")));
    box.appendChild(voiceRow("Language", "voice.language_code", VOICE_LANGUAGES, cfgGet("language_code", "en-IN")));
  } catch (e) {
    box.textContent = "";
    box.appendChild(el("p", "muted pad", "could not load voice settings: " + e.message));
  }
}

// Apply on change — no Save button, so the pick takes effect immediately.
$("voice-rows").addEventListener("change", async (e) => {
  const sel = e.target;
  if (!sel.dataset || !sel.dataset.key) return;
  const key = sel.dataset.key;
  const value = sel.value;
  try {
    unwrap(await window.aishe.config.set(key, value));
    $("voice-result").textContent = `${key.split(".")[1]} → ${value}`;
    toast(`voice: ${key.split(".")[1]} = ${value}`);
  } catch (err) {
    $("voice-result").textContent = "error: " + err.message;
    toast("voice save failed", true);
    loadVoice(); // snap the dropdown back to what is actually stored
  }
});

$("btn-voice-reload").addEventListener("click", () => loadVoice());

/* ── boot ───────────────────────────────────────────────────────────────── */

/** Grow the composer with its content, up to the CSS max-height. */
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}
$("chat-input").addEventListener("input", (e) => autoGrow(e.target));

(async function boot() {
  setSpeakUI();
  setThread(MAIN_THREAD);
  updateChatEmpty();
  await refreshHealth();
  await loadModels();

  // Honour `--tab=` (`aishe desktop --tab=keys` → Keys). Old flat tab names map
  // onto the new grouped navigation: sessions/memory live under History, keys
  // under Keys. Fetched over IPC because the preload's argv lacks it.
  try {
    const res = await window.aishe.initialTab();
    const want = res && res.ok ? res.data : "chat";
    const view = TABS[want] || "chat";
    const sub = SUBS[want] || "chat";
    if (view === "history" || view === "keys") showPane(view, sub);
    showView(view);
  } catch (e) {
    /* stay on the default Chat view */
  }
})();
