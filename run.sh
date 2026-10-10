#!/usr/bin/env bash
# Launch the Aishe desktop app with a guaranteed graphical session environment.
#
# Why this exists: Wayland display vars live in the *session* environment, not
# in the compositor's own process (Hyprland is the compositor — it has no
# WAYLAND_DISPLAY of its own). Launching Electron from a context that lacks
# them, such as a detached shell or a systemd unit, fails with:
#
#   Failed to connect to Wayland display: Connection refused (111)
#   Failed to initialize Wayland platform
#   The platform failed to initialize.  Exiting.
#
# So: reuse the variables if already present, otherwise recover them from the
# user systemd session, then fall back to the well-known runtime socket.
set -uo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ELECTRON="$APP_DIR/node_modules/.bin/electron"

if [ ! -x "$ELECTRON" ]; then
  echo "aishe-desktop: Electron is not installed." >&2
  echo "  Run: cd $APP_DIR && npm install" >&2
  exit 1
fi

# 1. Recover from the user session if the vars are missing.
if [ -z "${WAYLAND_DISPLAY:-}" ] || [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    eval "$(systemctl --user show-environment 2>/dev/null \
      | grep -E '^(WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR)=' \
      | sed 's/^/export /')" || true
  fi
fi

# 2. Fall back to the standard socket path.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for sock in "$XDG_RUNTIME_DIR"/wayland-*; do
    case "$sock" in *.lock) continue ;; esac
    if [ -S "$sock" ]; then
      export WAYLAND_DISPLAY="$(basename "$sock")"
      break
    fi
  done
fi

# 3. Verify we can actually talk to a display before handing off, so the
#    failure is legible instead of a Chromium stack trace.
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
  echo "aishe-desktop: no Wayland or X display found." >&2
  echo "  WAYLAND_DISPLAY and DISPLAY are both unset and no socket was found in" >&2
  echo "  ${XDG_RUNTIME_DIR}. Launch this from a graphical session." >&2
  exit 1
fi

export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}"

# ── GPU handling ────────────────────────────────────────────────────────────
# This class of machine (Intel iGPU sharing system RAM under memory pressure)
# can fail to allocate scanout buffers, which makes Chromium's GPU process
# crash-loop with:
#     Cannot create bo with format= RGBA_8888 and usage=SCANOUT
#     intel: the execbuf ioctl keeps returning ENOMEM
#     GPU process exited unexpectedly: exit_code=134
# and the window never paints. Software rendering sidesteps it entirely and is
# plenty for this UI. Set AISHE_DESKTOP_GPU=1 to opt back into hardware accel.
GPU_FLAGS=()
if [ "${AISHE_DESKTOP_GPU:-0}" = "1" ]; then
  GPU_FLAGS+=(--ozone-platform-hint=auto --enable-features=UseOzonePlatform)
else
  GPU_FLAGS+=(--disable-gpu --disable-gpu-compositing --disable-gpu-rasterization)
fi

exec "$ELECTRON" "$APP_DIR" "${GPU_FLAGS[@]}" "$@"
