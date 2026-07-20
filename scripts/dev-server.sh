#!/usr/bin/env bash
#
# Robust start/stop for the solar dev server, safe for agents and humans.
#
# Uses `setsid` so the server runs in its own session/process-group, fully
# detached from the calling shell (survives the shell exiting, no nohup/disown).
# A pidfile tracks the session leader; stop signals the whole process group so
# the `bun --hot` child is cleaned up too. Logs go to a file (never blocks).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/.dev-server.pid"
LOGFILE="$ROOT/.dev-server.log"

worktree_port() {
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$ROOT" | sha256sum | cut -c1-6)"
  else
    digest="$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-6)"
  fi
  printf '%d' "$((16#$digest % 1000 + 3000))"
}

SERVER_PORT="${PASEO_PORT:-$(worktree_port)}"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

is_server_on_port() {
  curl --fail --silent --max-time 1 "http://localhost:$SERVER_PORT/healthz" \
    | grep --quiet '"ok":true'
}

show_server_info() {
  local pid="${1:-}"

  if [ -n "$pid" ]; then
    echo "dev server already running (pid $pid) -> http://localhost:$SERVER_PORT  port: $SERVER_PORT  logs: $LOGFILE"
  else
    echo "dev server already running -> http://localhost:$SERVER_PORT  port: $SERVER_PORT (unmanaged; no pidfile or log path)"
  fi
}

show_seed_info() {
  grep -E '^seeded dev (admin account|API key):' "$LOGFILE" || true
}

case "${1:-}" in
  start)
    if is_running; then
      show_server_info "$(cat "$PIDFILE")"
      exit 0
    fi
    rm -f "$PIDFILE"
    if is_server_on_port; then
      show_server_info
      exit 0
    fi
    if [ "${2:-}" = "--foreground" ]; then
      cd "$ROOT/apps/server"
      exec env PORT="$SERVER_PORT" SOLAR_SEED_DEV_USER=1 bun --env-file=../../.env run dev
    fi
    : > "$LOGFILE"
    PORT="$SERVER_PORT" SOLAR_SEED_DEV_USER=1 setsid bash -c 'cd "'"$ROOT"'/apps/server" && exec bun --env-file=../../.env run dev' \
      >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    # Give it a moment to bind or fail fast.
    sleep 3
    if is_running; then
      echo "dev server started (pid $(cat "$PIDFILE")) -> http://localhost:$SERVER_PORT  logs: $LOGFILE"
      show_seed_info
    else
      echo "dev server failed to start; last log lines:"
      tail -n 20 "$LOGFILE"
      rm -f "$PIDFILE"
      exit 1
    fi
    ;;

  stop)
    if [ -f "$PIDFILE" ]; then
      pid="$(cat "$PIDFILE")"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "dev server stopped"
    else
      echo "dev server not running"
    fi
    ;;

  restart)
    "$0" stop
    "$0" start
    ;;

  status)
    if is_running; then
      show_server_info "$(cat "$PIDFILE")"
    elif is_server_on_port; then
      show_server_info
    else
      echo "stopped"
    fi
    ;;

  logs)
    tail -n "${2:-80}" "$LOGFILE" 2>/dev/null || echo "no log file yet"
    ;;

  *)
    echo "usage: $0 {start [--foreground]|stop|restart|status|logs [N]}"
    exit 1
    ;;
esac
