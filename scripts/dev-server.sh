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

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    if is_running; then
      echo "dev server already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    : > "$LOGFILE"
    setsid bash -c 'cd "'"$ROOT"'/apps/server" && exec bun --env-file=../../.env run dev' \
      >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    # Give it a moment to bind or fail fast.
    sleep 3
    if is_running; then
      echo "dev server started (pid $(cat "$PIDFILE")) -> http://localhost:3000  logs: $LOGFILE"
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
      echo "running (pid $(cat "$PIDFILE"))"
    else
      echo "stopped"
    fi
    ;;

  logs)
    tail -n "${2:-80}" "$LOGFILE" 2>/dev/null || echo "no log file yet"
    ;;

  *)
    echo "usage: $0 {start|stop|restart|status|logs [N]}"
    exit 1
    ;;
esac
