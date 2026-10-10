"use strict";
/**
 * Backend tests for aishe-desktop. Plain `node --test` — no Electron needed.
 * Run: npm test   (or: node --test test/)
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

const cfg = require("../lib/config");
const sessions = require("../lib/sessions");
const control = require("../lib/control");
const services = require("../lib/services");

/* ── config ─────────────────────────────────────────────────────────────── */

test("config: defaults carry every provider the CLI knows", () => {
  const d = cfg.defaults();
  for (const p of ["sarvam", "ollama-cloud", "local", "openrouter", "opencode-go"]) {
    assert.ok(d.providers[p], `missing provider ${p}`);
    assert.ok(d.providers[p].base_url, `provider ${p} has no base_url`);
  }
  assert.strictEqual(typeof d.services.deepagent, "string");
});

test("config: load returns defaults merged with the file", () => {
  const { cfg: c, path: p } = cfg.load();
  assert.strictEqual(p, cfg.configPath());
  assert.ok(c.voice && typeof c.voice.default_voice === "string");
  assert.ok(c.voice.language_code === "en-IN");
  assert.ok(c.voice.stt_mode === "transcribe");
  // Voice has no local service URL — it is Sarvam cloud.
  assert.ok(!("stt" in c.services), "stt service should be gone (voice is Sarvam cloud)");
});

test("config: redact hides provider keys but keeps a fingerprint", () => {
  const fake = cfg.defaults();
  fake.providers.openrouter.api_key = "sk-or-v1-abcdefghijklmnop";
  const r = cfg.redact(fake);
  assert.ok(!r.providers.openrouter.api_key.includes("abcdefghij"));
  assert.ok(r.providers.openrouter.api_key.includes("…"));
});

test("config: deepGet walks dot paths and tolerates misses", () => {
  const o = { a: { b: { c: 7 } } };
  assert.strictEqual(cfg.deepGet(o, ["a", "b", "c"]), 7);
  assert.strictEqual(cfg.deepGet(o, ["a", "x", "c"]), undefined);
  assert.strictEqual(cfg.deepGet(o, ["nope"]), undefined);
});

/* ── sessions ───────────────────────────────────────────────────────────── */

test("sessions: escapeFts protects the MATCH expression", () => {
  assert.strictEqual(sessions.escapeFts("hello world"), '"hello" "world"');
  // Every term is quoted, so FTS operators arriving as user text become literals.
  const escaped = sessions.escapeFts('foo" OR bar*');
  assert.strictEqual(escaped, '"foo" "OR" "bar"');
  // A bare (unquoted) OR would be interpreted as an operator; a bare trailing *
  // would become a prefix wildcard. Neither may survive.
  assert.ok(!/(^|\s)OR(\s|$)/.test(escaped));
  assert.ok(!escaped.includes("*"));
  assert.strictEqual(sessions.escapeFts("   "), "");
  // Punctuation-only input sanitises away to nothing rather than emitting a
  // malformed MATCH expression.
  assert.strictEqual(sessions.escapeFts('"()*:^'), "");
});

test("sessions: stats reports a shape even when the db is missing", () => {
  const s = sessions.stats();
  assert.strictEqual(typeof s.available, "boolean");
  assert.strictEqual(typeof s.threads, "number");
  assert.strictEqual(typeof s.messages, "number");
});

test("sessions: a query backend is always resolved", () => {
  // Under plain node this is node:sqlite; inside Electron 33 (Node 20.18) it
  // falls back to the sqlite3 CLI. Either way it must not be 'none' here,
  // because both a modern Node and the sqlite3 binary are present.
  const b = sessions.backend();
  assert.ok(["node:sqlite", "sqlite3-cli"].includes(b), `unexpected backend: ${b}`);
});

test("sessions: reads real rows through the active backend", () => {
  if (!sessions.available()) return; // no db yet on this machine
  const stats = sessions.stats();
  assert.ok(stats.threads >= 0);
  // Single-thread architecture: the shared thread carries the expected keys.
  const th = sessions.getThread("main");
  if (th) {
    assert.ok("id" in th && "title" in th && "message_count" in th && "messages" in th);
    assert.strictEqual(th.message_count, th.messages.length);
  }
});

test("sessions: getThread returns null for an unknown id, not an error", () => {
  const res = sessions.getThread("definitely-not-a-real-thread");
  assert.strictEqual(res, null);
});

test("sessions: legacy JSON thread files no longer exist in the data dir", () => {
  // Regression guard: storage moved from ~/aishe/threads/*.json to SQLite.
  const dir = path.join(os.homedir(), "aishe", "threads");
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0);
});

/* ── control ────────────────────────────────────────────────────────────── */

test("services: every displayable service has a health probe", () => {
  // The UI renders a row per entry in control.SERVICES and colours it from
  // services.health(). Any service present in one but missing from the other
  // renders as a permanently-red dot regardless of whether it is running —
  // exactly the bug Qdrant shipped with.
  const displayable = Object.keys(control.SERVICES).sort();
  const probed = services.PROBED.slice().sort();
  const missing = displayable.filter((k) => !probed.includes(k));
  assert.deepStrictEqual(
    missing,
    [],
    `services rendered by the UI but never probed (will always show down): ${missing.join(", ")}`
  );
});

test("services: qdrant is probed on its real liveness endpoint", async () => {
  assert.ok(services.PROBED.includes("qdrant"));
  // health() must report a definite boolean for every probed service.
  const h = await services.health();
  for (const key of services.PROBED) {
    assert.ok(h.services[key], `health() returned nothing for ${key}`);
    assert.strictEqual(typeof h.services[key].up, "boolean", `${key}.up is not a boolean`);
    assert.ok(h.services[key].url.startsWith("http"), `${key} has no base url`);
  }
});

test("memory: the removed CRUD pane left no bindings behind", () => {
  // The History → Memory sub-tab was removed (memory now lives in the Keys tab
  // as a status card, and in the CLI). Assert the CRUD surface stays gone so a
  // future edit cannot silently resurrect a pane with no UI.
  for (const fn of ["memoryAdd", "memorySearch", "memoryList", "memoryDelete"]) {
    assert.strictEqual(typeof services[fn], "undefined", `${fn} should be removed`);
  }
  // The status probe is the one piece that survives.
  assert.strictEqual(typeof services.memoryStatus, "function", "memoryStatus must remain");
});

test("control: no CLI escape hatch remains exposed", () => {
  // The CLI bridge went away with the Services/Config/Doctor panels. Assert it
  // stays gone: the renderer must never be able to run an arbitrary command.
  assert.strictEqual(typeof control.runCli, "undefined", "runCli should be removed");
  assert.strictEqual(typeof control.cliCapabilities, "undefined", "cliCapabilities should be removed");
});

test("control: voice is reported from cloud config, not a local port", async () => {
  // Voice moved to Sarvam cloud — there is no local sidecar to start/stop, so
  // voiceCtl is gone. Status must now come from the configured key.
  assert.strictEqual(typeof control.voiceCtl, "undefined", "voiceCtl should be removed");
  const vs = await control.voiceStatus();
  assert.ok(typeof vs.ready === "boolean");
  assert.strictEqual(vs.backend, "sarvam");
});

test("control: service actions validate name and verb", async () => {
  await assert.rejects(() => control.serviceAction("nope", "start"), /unknown service/);
  await assert.rejects(() => control.serviceAction("ollama", "detonate"), /invalid action/);
});

test("control: resolved paths point inside the repo", () => {
  assert.ok(path.isAbsolute(control.paths.DEEPAGENT_DIR));
});

test("renderer: markdown renders headings/bold/lists and escapes html", () => {
  // The chat body is run through renderMarkdown (renderer/app.js). Pull the
  // pure functions out and exercise them directly; keep boring literal text
  // (user messages) untouched.
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  if (!src.includes("function renderMarkdown")) return; // safety if harness changes
  const grab = (name, endMarker) => {
    const start = src.indexOf("function " + name);
    const end = src.indexOf(endMarker, start);
    return src.slice(start, end + endMarker.length) + "\n}";
  };
  const evalFn = (name, endMarker) => eval("(" + grab(name, endMarker) + ")");
  const escapeHtml = evalFn("escapeHtml", "}[c]));");
  const renderInline = evalFn("renderInline", "  return t;");
  const renderMarkdown = evalFn("renderMarkdown", "  return out.join(\"\\n\");");
  assert.match(renderMarkdown("# Hi"), /<h1 class="md">Hi<\/h1>/);
  assert.match(renderMarkdown("**bold**"), /<strong class="md">bold<\/strong>/);
  assert.match(renderMarkdown("*it*"), /<em class="md">it<\/em>/);
  assert.match(renderMarkdown("`c`"), /<code class="md">c<\/code>/);
  assert.match(renderMarkdown("- a\n- b"), /<ul class="md">/);
  assert.match(renderMarkdown("```\nx\n```"), /<pre class="md">/);
  // untrusted input is escaped, never injected
  assert.ok(!renderMarkdown("<script>alert(1)</script>").toLowerCase().includes("<script>"));
});

test("renderer: tool calls are grouped into a collapsible per-message box", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  // Every tool_call must be wrapped by ensureToolGroup (which creates .tool-box
  // with a toggle), tool_result nests into the box, and the box closes at end
  // of the turn. Guards against the old "loose floating lines" behaviour.
  for (const fn of ["ensureToolGroup", "updateToolCount", "finalizeToolGroup", "appendToolResult"]) {
    assert.ok(src.includes("function " + fn), `${fn} is missing`);
  }
  assert.match(src, /currentTool = addToolLine|addToolLine\(ev\.name/);
  assert.ok(src.includes('finalizeToolGroup()'), "group is not finalized at end of turn");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");
  assert.ok(css.includes(".tool-box") && css.includes('data-open="0"'), "collapsible CSS missing");
});

/* ── memory stack status ───────────────────────────────────────────────── */

test("memory: the three components are reported separately", async () => {
  // Each piece can be down on its own, so the probe must return one row per
  // component rather than a single up/down for "memory".
  const m = await services.memoryStatus();
  assert.strictEqual(typeof m.ok, "boolean");
  for (const key of ["embedder", "plugin", "vector"]) {
    assert.ok(m[key], `${key} row is missing`);
    assert.strictEqual(typeof m[key].ok, "boolean", `${key}.ok must be a boolean`);
    assert.ok(typeof m[key].detail === "string" && m[key].detail.length,
      `${key}.detail must explain the state`);
  }
  assert.strictEqual(m.ok, m.embedder.ok && m.plugin.ok && m.vector.ok,
    "overall must be the AND of the three rows");
});

test("memory: a component that is down does not take the others with it", async () => {
  // Regression guard: probing all three behind one try/catch (or through a
  // single /memory/status string) means one failure blanks the whole card.
  // Point Qdrant at a dead port and assert the other two still report.
  const real = cfg.get("services.qdrant");
  cfg.set("services.qdrant", "http://localhost:6399");
  try {
    const m = await services.memoryStatus();
    assert.strictEqual(m.vector.ok, false, "vector should be Inactive on a dead port");
    assert.ok(m.vector.detail.length, "vector must say why it is down");
    assert.strictEqual(m.ok, false, "overall must degrade");
    // The other two are unaffected by Qdrant being unreachable.
    assert.strictEqual(typeof m.embedder.ok, "boolean");
    assert.strictEqual(typeof m.plugin.ok, "boolean");
  } finally {
    cfg.set("services.qdrant", real);
  }
});

test("renderer: the memory card renders one row per component", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(src.includes("function memRow"), "memRow helper is missing");
  for (const label of ["Embedder", "Memory plugin", "Vector database"]) {
    assert.ok(src.includes(`"${label}"`), `${label} row is not rendered`);
  }
  assert.ok(src.includes('pill " + (row.ok ? "on" : "off")'), "Active/Inactive pill is missing");
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(html.includes('id="mem-rows"'), "memory rows container is missing");
  // No separate summary element: the pane is minimal, so the verdict shows as
  // Active/Inactive on each row instead of a header line.
  assert.ok(!html.includes('id="mem-status-summary"'), "memory summary should be gone");
});

test("control: no CLI escape hatch remains exposed", () => {
  // The CLI bridge went away with the Services/Config/Doctor panels. Assert it
  // stays gone: the renderer must never be able to run an arbitrary command.
  assert.strictEqual(typeof control.runCli, "undefined", "runCli should be removed");
  assert.strictEqual(typeof control.cliCapabilities, "undefined", "cliCapabilities should be removed");
});

/* ── single instance / launch ───────────────────────────────────────────── */

test("main: a single-instance lock guards against duplicate windows", () => {
  // Every `aishe desktop` used to spawn a whole new Electron process (renderer
  // + GPU + zygotes). The lock must exist and quit the newcomer.
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(src.includes("app.requestSingleInstanceLock()"), "no single-instance lock");
  assert.ok(/if \(!gotLock\) \{\s*app\.quit\(\);/.test(src), "the duplicate instance must quit");
  assert.ok(src.includes('app.on("second-instance"'), "second instance must focus the existing window");
});

test("main: a later --tab reaches the running instance", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(src.includes("STARTUP_TAB_OVERRIDE"), "no override slot for a late --tab");
  assert.ok(src.includes("win.webContents.send(\"aishe:tab\", tab)"), "renderer is never told about the new tab");
  // The override must be what the renderer reads back, or it shows the old tab.
  assert.ok(/app:initialTab.*STARTUP_TAB_OVERRIDE \|\| STARTUP_TAB/.test(src),
    "app:initialTab must prefer the override");
});

test("renderer: History has no Memory sub-tab any more", () => {
  // The Memory pane was removed from History. Guard both the tab button and
  // the pane so neither can come back without the code behind it.
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(!html.includes('data-sub="memory"'), "the Memory sub-tab button is still rendered");
  assert.ok(!html.includes('id="pane-memory"'), "the Memory pane is still in the DOM");
  assert.ok(!html.includes('id="mem-list"'), "memory list container is still in the DOM");
  const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(!js.includes("function renderMemory"), "renderMemory is still defined");
  assert.ok(!js.includes("window.aishe.memory."), "renderer still calls the removed memory IPC");
});

test("preload: the memory CRUD bridge is gone but the status probe remains", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  for (const ch of ["memory:add", "memory:search", "memory:list", "memory:delete"]) {
    assert.ok(!src.includes(ch), `${ch} is still bridged`);
  }
  assert.ok(src.includes("memory:status"), "memory:status must remain for the Keys tab card");
});

/* ── history pane ───────────────────────────────────────────────────────── */

test("renderer: History has no header, no thread title, no Sessions tab", () => {
  // The pane is the transcript itself now — no wrapper header, no thread-title
  // card, and the last sub-tab is gone.
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const history = html.slice(html.indexOf('id="view-history"'), html.indexOf("</section>", html.indexOf('id="view-history"')));
  assert.ok(!history.includes("view-head"), "History still renders a header");
  assert.ok(!history.includes("ses-thread-title"), "the thread-title card is still there");
  assert.ok(!history.includes("ses-thread-meta"), "the thread-meta line is still there");
  assert.ok(!history.includes('data-sub='), "a sub-tab is still rendered in History");
});

test("renderer: timestamps are human-readable, not raw ISO strings", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(src.includes("function fmtTime"), "fmtTime is missing");
  // The old code interpolated m.timestamp straight into the DOM.
  assert.ok(!/sub", `\$\{m\.role\} · \$\{m\.timestamp\}`/.test(src),
    "a raw timestamp is still rendered");
  // Parsed as LOCAL time: the DB stores naive strings with no offset, so
  // treating them as UTC would show the wrong hour in IST.
  assert.ok(src.includes('String(ts).replace(" ", "T")'), "fmtTime must normalise before parsing");
  assert.ok(!/ts\s*\+\s*"Z"/.test(src), "fmtTime must NOT force UTC");
});

test("sessions: search is scoped to the shared thread", () => {
  if (!sessions.available()) return;
  const sql = fs.readFileSync(path.join(__dirname, "..", "lib", "sessions.js"), "utf8");
  assert.ok(/AND m\.thread_id = /.test(sql), "search does not filter by thread_id");
  // Scoping must be real, not just documentation: hits only ever name main.
  const hits = sessions.search("the", 50);
  for (const h of hits) assert.strictEqual(h.thread_id, "main", `unexpected thread ${h.thread_id}`);
});

test("renderer: the Keys pane is minimal — no header, no prose", () => {
  // The pane is just the key rows and the memory rows. No wrapper header, no
  // "Where each key is used" explainer, no per-row hint text.
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const keys = html.slice(html.indexOf('id="view-keys"'), html.indexOf("</section>", html.indexOf('id="view-keys"')));
  assert.ok(!keys.includes("view-head"), "Keys still renders a header");
  assert.ok(!keys.includes('data-sub='), "a sub-tab is still rendered in Keys");
  assert.ok(!keys.includes("Where each key is used"), "the explainer card is still there");
  assert.ok(!keys.includes('id="keys-path"'), "the config-path line is still there");
  assert.ok(!keys.includes('id="mem-status-summary"'), "the memory summary line is still there");
  const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(!js.includes("prov.hint"), "per-row hint text is still rendered");
  assert.ok(!js.includes('$("keys-path")'), "keys-path is still written to");
});

/* ── settings pane: headings + voice section ────────────────────────────── */

test("renderer: the Keys pane has three bold section headings in order", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const pane = html.slice(html.indexOf('id="pane-keys"'), html.indexOf("</section>", html.indexOf('id="pane-keys"')));
  const heads = [...pane.matchAll(/<h2 class="sec-head">([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ["Keys", "Memory", "Voice"], "sections must be Keys, Memory, Voice in order");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");
  assert.ok(/\.sec-head \{[^}]*font-weight:\s*700/.test(css), "section headings are not bold");
});

test("renderer: the Voice section offers STT/TTS model, mode, speaker and language", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(src.includes("VOICE_SPEAKERS"), "speaker list is missing");
  assert.ok(src.includes("VOICE_STT_MODELS"), "STT model list is missing");
  assert.ok(src.includes("VOICE_TTS_MODELS"), "TTS model list is missing");
  assert.ok(src.includes("VOICE_STT_MODES"), "STT mode list is missing");
  for (const label of ["STT model", "STT mode", "TTS model", "Speaker", "Language"]) {
    assert.ok(src.includes(`"${label}"`), `the ${label} dropdown is not rendered`);
  }
  // Every offered speaker must be one Sarvam accepts — a bogus entry writes
  // config that 400s on the next voice call.
  const speakers = src.slice(src.indexOf("const VOICE_SPEAKERS"), src.indexOf("];", src.indexOf("const VOICE_SPEAKERS")));
  for (const name of ["shubh", "priya", "rupali", "manan"]) {
    assert.ok(speakers.includes(`"${name}"`), `${name} is missing from the roster`);
  }
  assert.ok(!speakers.includes("astro"), "a speaker Sarvam rejects is offered");
});

test("voice: models come from config, not hardcoded constants", () => {
  // The dropdowns would be cosmetic if the API call ignored config.
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "services.js"), "utf8");
  assert.ok(/const STT_MODEL = \(\) => cfg\.get\("voice\.stt_model"/.test(src),
    "STT model must be read from config");
  assert.ok(/const TTS_MODEL = \(\) => cfg\.get\("voice\.tts_model"/.test(src),
    "TTS model must be read from config");
  // Both call sites must invoke the getter, not interpolate the function.
  assert.ok(src.includes("fd.append(\"model\", STT_MODEL());"), "STT call site does not use the config value");
  assert.ok(src.includes("model: TTS_MODEL(),"), "TTS call site does not use the config value");
});

test("voice: a config change is what actually reaches Sarvam", async () => {
  // End-to-end: set an invalid speaker, confirm the API rejects it. That only
  // happens if the configured value is really being sent.
  const real = cfg.get("voice.default_voice");
  cfg.set("voice.default_voice", "not-a-real-speaker");
  try {
    await assert.rejects(() => services.synthesize("test"), /HTTP 400/,
      "a bogus speaker was accepted — the config value is not being sent");
  } finally {
    cfg.set("voice.default_voice", real);
  }
  // And a valid one still returns audio.
  cfg.set("voice.default_voice", "priya");
  try {
    const buf = await services.synthesize("test");
    assert.ok(buf.length > 1000, "TTS returned no audio for a valid speaker");
  } finally {
    cfg.set("voice.default_voice", real);
  }
});

/* ── persistence + ordering ─────────────────────────────────────────────── */

test("sessions: messages are returned newest first", () => {
  if (!sessions.available()) return;
  const th = sessions.getThread("main");
  if (!th || th.messages.length < 2) return;
  const ids = th.messages.map((m) => m.id);
  assert.deepStrictEqual(
    ids,
    [...ids].sort((a, b) => b - a),
    "getThread must return newest first so the latest turn is the first row"
  );
});

test("sessions: addMessage writes to both messages and the FTS index", () => {
  if (!sessions.available()) return;
  const token = "zzpersistprobe" + Date.now();
  const before = sessions.getThread("main").message_count;

  sessions.addMessage("main", "user", token + "-user");
  sessions.addMessage("main", "assistant", token + "-assistant");

  const after = sessions.getThread("main");
  assert.strictEqual(after.message_count, before + 2, "both turns must be persisted");
  // Newest first, so the assistant reply is the head.
  assert.strictEqual(after.messages[0].content, token + "-assistant");
  assert.strictEqual(after.messages[1].content, token + "-user");
  // A row missing from messages_fts is invisible to search.
  const hits = sessions.search(token, 50);
  assert.strictEqual(hits.length, 2, "the FTS index was not updated");

  // Clean up so the probe never shows up in the real transcript.
  const { execFileSync } = require("child_process");
  execFileSync("sqlite3", [sessions.dbPath()], {
    input: `DELETE FROM messages WHERE content LIKE '${token}%';
            DELETE FROM messages_fts WHERE content LIKE '${token}%';`,
    stdio: ["pipe", "ignore", "pipe"],
  });
});

test("main: chat:send persists the turn under the caller's thread id", () => {
  // Regression: the desktop streamed replies but never wrote them, so History
  // only ever showed CLI messages.
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(/sessions\.addMessage\(tid, "user", message\)/.test(src),
    "the user message is not persisted");
  assert.ok(/sessions\.addMessage\(tid, "assistant", result\.reply\)/.test(src),
    "the assistant reply is not persisted");
  // Persisting under a different id than the one sent writes to a thread the
  // History pane never reads.
  assert.ok(/const tid = threadId \|\| "main"/.test(src),
    "the persisted thread id must be the one the renderer sent");
});

test("services: chatStream defaults to the shared thread, not a phantom one", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "services.js"), "utf8");
  assert.ok(!src.includes('thread_id: threadId || "desktop"'),
    'a "desktop" fallback creates a thread nothing reads');
  assert.ok(src.includes('thread_id: threadId || "main"'),
    "the fallback must be the shared thread id");
});

/* ── top bar removal + grouped model picker ─────────────────────────────── */

test("renderer: the top bar is gone from the shell", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(!html.includes('class="topbar"'), "the top bar is still in the DOM");
  for (const id of ["thread-label", "status-dots", "dot-deepagent", "dot-ollama",
                    "dot-qdrant", "dot-stt", "dot-tts"]) {
    assert.ok(!html.includes(`id="${id}"`), `${id} is still in the DOM`);
  }
  const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(!js.includes('$("thread-label")'), "thread-label is still written to");
  assert.ok(!js.includes('$("status-dots")'), "status-dots is still written to");
  assert.ok(!js.includes('$("dot-'), "service dots are still written to");
});

test("services: listModels probes every configured provider", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "services.js"), "utf8");
  assert.ok(src.includes("async function probeProvider"), "no per-provider probe");
  // The old version read only cfg.get("provider") — the active one.
  assert.ok(!/const provider = cfg\.get\("provider", ""\);\s*\n\s*if \(!provider\)/.test(src),
    "listModels still only probes the active provider");
});

test("services: every provider is reported, with a reason when it yields nothing", async () => {
  const r = await services.listModels();
  assert.ok(Array.isArray(r.providers), "providers array is missing");
  // Each configured provider must appear, and each row must carry either
  // models or an error — never a silent empty entry.
  for (const p of r.providers) {
    assert.ok(p.models.length || p.error, `${p.name} reports neither models nor an error`);
  }
  // The flat list stays "provider:model" so the picker can round-trip it.
  for (const m of r.models) assert.ok(/^[^:]+:.+/.test(m), `bad flat id: ${m}`);
});

/* ── model:set must not leak an unserialisable value across IPC ─────────── */

test("main: model:set deletes the `exited` promise before replying", () => {
  // Electron serialises ipcMain.handle replies with the structured-clone
  // algorithm, which rejects Promises. A leaked `exited` made the main process
  // throw "An object could not be cloned" AFTER a successful restart — the
  // switch worked, but the UI showed a failure.
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const block = src.match(/ipcMain\.handle\(\s*"model:set"[\s\S]*?\n\);/);
  assert.ok(block, "model:set handler not found");
  assert.ok(
    /delete\s+res\.exited\s*;/.test(block[0]),
    "model:set still returns the `exited` promise — this breaks IPC serialisation"
  );
  // The delete must happen before the return, not after it.
  assert.ok(block[0].indexOf("delete res.exited") < block[0].lastIndexOf("return res"),
    "delete res.exited must come before `return res`");
});

/* ── shared core: one resolver for every surface ──────────────────────────── */

test("core: the bridge reaches the CLI's shared resolver", () => {
  const core = require("../lib/core");
  assert.ok(core.available(), "aishe_core was not reachable — paths will drift again");
  const dir = core.deepagentDir();
  assert.ok(fs.existsSync(path.join(dir, "server.py")), `deepagent not found at ${dir}`);
});

test("core: services come from the shared registry, not a local copy", () => {
  const core = require("../lib/core");
  const shared = core.services();
  assert.ok(shared, "shared service registry unavailable");
  // The desktop must not invent its own list.
  for (const name of Object.keys(shared)) {
    assert.ok(name in control.SERVICES, `${name} exists in the registry but not in the desktop`);
  }
  // Qdrant serves memory; it was desktop-only before, which left `aishe doctor`
  // blind to a dead vector DB.
  assert.ok("qdrant" in shared, "qdrant missing from the shared registry");
});

test("control: deepagent resolves to the same place the CLI resolves it", () => {
  const core = require("../lib/core");
  assert.strictEqual(
    control.paths.DEEPAGENT_DIR,
    core.deepagentDir(),
    "desktop and CLI disagree about where deepagent lives — the two-copies bug"
  );
  assert.ok(fs.existsSync(control.DEEPAGENT_SERVER), "resolved server.py does not exist");
});
