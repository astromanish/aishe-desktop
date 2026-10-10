"use strict";
/**
 * Aishe Desktop — session/thread store.
 *
 * Reads the SAME SQLite database the CLI writes (~/aishe/aishe.db), so
 * conversation history and full-text search match `aishe` / `aishe search`.
 *
 * Schema (owned by aishe_pkg/threads.py):
 *   threads(id PK, title, created_at, updated_at)
 *   messages(id PK AUTOINCREMENT, thread_id, role, content, timestamp)
 *   messages_fts  -- fts5(thread_id UNINDEXED, role UNINDEXED, content)
 *
 * TWO backends, because this code runs in two very different Node runtimes:
 *   - `node:sqlite` — built in from Node 22.5. Works under plain `node` (tests).
 *   - the `sqlite3` CLI — Electron 33 bundles Node 20.18.3, which predates
 *     node:sqlite (require() throws ERR_UNKNOWN_BUILTIN_MODULE). Shelling out
 *     keeps the GUI working without pinning the app to a newer Electron.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (e) {
  DatabaseSync = null; // Electron 33 / Node < 22.5
}

function dbPath() {
  return path.join(os.homedir(), "aishe", "aishe.db");
}

function hasNodeSqlite() {
  return Boolean(DatabaseSync);
}

function hasCli() {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

/** Which backend will be used for queries. */
function backend() {
  if (hasNodeSqlite()) return "node:sqlite";
  if (hasCli()) return "sqlite3-cli";
  return "none";
}

function available() {
  return fs.existsSync(dbPath()) && backend() !== "none";
}

/* ── sqlite3 CLI backend ────────────────────────────────────────────────── */

/** Escape a value for a single-quoted SQL literal. */
function lit(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function cliQuery(sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath(), sql], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function query(sql) {
  if (hasNodeSqlite()) {
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      // node:sqlite has no parameter binding here because the SQL is already
      // fully formed by the callers below (values are escaped via lit()).
      return db.prepare(sql).all().map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  }
  return cliQuery(sql);
}

/* ── writes ─────────────────────────────────────────────────────────────── */

/**
 * Append a message to a thread, creating the thread row on first use.
 *
 * Mirrors aishe_pkg/threads.py::add_message so the desktop and the CLI write
 * byte-identical rows — same columns, same auto-title rule, same FTS5 index.
 * Without this the desktop's chat worked on screen but nothing reached SQLite,
 * so the History pane never showed anything said in the app.
 *
 * Returns true when the row was written.
 */
function addMessage(threadId, role, content) {
  const id = lit(threadId);
  const r = lit(role);
  const c = lit(content);
  if (!content) return false;
  const now = new Date().toISOString().replace("T", " ").slice(0, 26);

  if (hasNodeSqlite()) {
    const db = new DatabaseSync(dbPath());
    try {
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec("BEGIN");
      const existing = db.prepare(`SELECT * FROM threads WHERE id = ${id} LIMIT 1`).get();
      if (!existing) {
        // The CLI titles a thread from its first user message, leaving
        // assistant-led threads as "New thread" until a user message arrives.
        const title = role === "assistant" ? "New thread" : String(content).slice(0, 60);
        db.exec(`INSERT INTO threads (id, title, created_at, updated_at) VALUES (${id}, ${lit(title)}, ${lit(now)}, ${lit(now)})`);
      } else if (role === "user" && (existing.title === "New thread" || !existing.title)) {
        db.exec(`UPDATE threads SET title = ${lit(String(content).slice(0, 60))} WHERE id = ${id}`);
      }
      db.exec(`INSERT INTO messages (thread_id, role, content, timestamp) VALUES (${id}, ${r}, ${c}, ${lit(now)})`);
      // Keep messages_fts in step — a row missing here is invisible to search.
      const rowid = db.prepare("SELECT last_insert_rowid() AS rid").get().rid;
      db.exec(`INSERT INTO messages_fts (rowid, thread_id, role, content) VALUES (${Number(rowid)}, ${id}, ${r}, ${c})`);
      db.exec(`UPDATE threads SET updated_at = ${lit(now)} WHERE id = ${id}`);
      db.exec("COMMIT");
      return true;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      throw e;
    } finally {
      db.close();
    }
  }

  // Electron 33 bundles Node 20, which predates node:sqlite — shell out.
  const title = role === "assistant" ? "New thread" : String(content).slice(0, 60);
  const sql = `
    INSERT OR IGNORE INTO threads (id, title, created_at, updated_at) VALUES (${id}, ${lit(title)}, ${lit(now)}, ${lit(now)});
    UPDATE threads SET title = ${lit(String(content).slice(0, 60))} WHERE id = ${id} AND (title = 'New thread' OR title IS NULL) AND ${lit(role)} = 'user';
    INSERT INTO messages (thread_id, role, content, timestamp) VALUES (${id}, ${r}, ${c}, ${lit(now)});
    INSERT INTO messages_fts (rowid, thread_id, role, content)
      SELECT last_insert_rowid(), ${id}, ${r}, ${c};
    UPDATE threads SET updated_at = ${lit(now)} WHERE id = ${id};
  `;
  execFileSync("sqlite3", [dbPath()], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
  return true;
}

/* ── shared query helpers ───────────────────────────────────────────────── */

/** Quote each term so punctuation from user input can't break the MATCH query. */
function escapeFts(query_) {
  const terms = String(query_ || "")
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return terms.join(" ");
}

function getThread(threadId) {
  const id = lit(threadId);
  const t = query(`SELECT * FROM threads WHERE id = ${id} LIMIT 1`)[0];
  if (!t) return null;
  // Newest first: the History pane shows a transcript, and the thing you just
  // said should be the first row, not buried under 20 older turns.
  const msgs = query(
    `SELECT id, role, content, timestamp FROM messages WHERE thread_id = ${id} ORDER BY id DESC`
  );
  return { ...t, message_count: msgs.length, messages: msgs };
}

/**
 * Full-text search over the shared thread's messages (mirrors `aishe search`).
 *
 * Scoped by thread_id on purpose: the single-thread architecture means every
 * message belongs to `main`, but filtering in SQL rather than in the UI keeps
 * the guarantee even if a stray thread ever reappears in the database.
 */
function search(q, limit = 50, threadId = "main") {
  const expr = escapeFts(q);
  if (!expr) return [];
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  return query(
    `SELECT m.id, m.thread_id, m.role, m.content, m.timestamp, t.title
     FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid
     LEFT JOIN threads t ON t.id = m.thread_id
     WHERE messages_fts MATCH ${lit(expr)}
       AND m.thread_id = ${lit(threadId)}
     ORDER BY m.id DESC
     LIMIT ${n}`
  );
}

function stats() {
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return { available: false, backend: backend(), path: p, threads: 0, messages: 0 };
  }
  try {
    const threads = Number((query("SELECT COUNT(*) AS c FROM threads")[0] || {}).c || 0);
    const messages = Number((query("SELECT COUNT(*) AS c FROM messages")[0] || {}).c || 0);
    return {
      available: true,
      backend: backend(),
      path: p,
      threads,
      messages,
      sizeBytes: fs.statSync(p).size,
    };
  } catch (e) {
    return { available: false, backend: backend(), path: p, threads: 0, messages: 0, error: String(e.message || e) };
  }
}

module.exports = {
  dbPath,
  available,
  backend,
  getThread,
  addMessage,
  search,
  stats,
  escapeFts,
};
