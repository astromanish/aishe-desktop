"use strict";
/**
 * aishe_core bridge — the desktop's view of the shared path resolver.
 *
 * The desktop used to carry its own copy of "where does deepagent live", which
 * drifted from the CLI's answer. That is how two different copies of the
 * backend ended up competing for :8765: the desktop launched
 * `~/Documents/projects/aishe-cli/deepagent`, `start-all.sh` launched
 * `~/.local/share/aishe-cli/deepagent`, and whichever started first won the port.
 *
 * This module shells out to the CLI's `aishe_pkg/aishe_core.py` so there is
 * exactly one definition of these paths. `aishe doctor` on the CLI and the
 * desktop's service panel therefore always agree.
 *
 * If the resolver is unreachable (no python on PATH, CLI not installed) every
 * function falls back to the previous hardcoded behaviour, so the desktop keeps
 * working standalone.
 */

const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CLI_ENV = process.env.AISHE_CLI_DIR;
const CANDIDATE_CLI = [
  CLI_ENV,
  path.join(os.homedir(), "Documents", "projects", "aishe-cli"),
  path.join(os.homedir(), ".local", "share", "aishe-cli"),
].filter(Boolean);

function cliDir() {
  for (const c of CANDIDATE_CLI) {
    try {
      if (require("fs").existsSync(path.join(c, "aishe_pkg", "aishe_core.py"))) return c;
    } catch (e) { /* keep looking */ }
  }
  return null;
}

/**
 * Ask the shared resolver for one value.
 * @param {string} expr a python expression evaluated against the module, e.g.
 *                      "str(aishe_core.deepagent_dir())"
 * @returns {string|null} the value, or null if the resolver is unavailable
 */
function resolve(expr) {
  const cli = cliDir();
  if (!cli) return null;
  const py = process.env.AISHE_PYTHON || "python3";
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(cli)})`,
    "from aishe_pkg import aishe_core",
    `print(${expr})`,
  ].join("\n");
  try {
    const out = execFileSync(py, ["-c", script], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

/** Every resolved path at once, with the resolver's own existence flags. */
function describe() {
  const raw = resolve("__import__('json').dumps(aishe_core.describe())");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

module.exports = {
  /** @returns {boolean} whether the shared resolver was reachable */
  available: () => cliDir() !== null,

  cliDir,

  /** deepagent's directory, or the legacy fallback. */
  deepagentDir() {
    return (
      resolve("aishe_core.deepagent_dir()") ||
      path.join(os.homedir(), ".local", "share", "aishe-cli", "deepagent")
    );
  },

  /** deepagent's own interpreter. */
  deepagentVenv() {
    return resolve("str(aishe_core.deepagent_venv())");
  },

  /** The service registry — the same one `aishe doctor` uses. */
  services() {
    const raw = resolve("__import__('json').dumps(aishe_core.SERVICES)");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  describe,
};
