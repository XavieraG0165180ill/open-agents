#!/usr/bin/env bash
# proxy-session.sh — Launch a browser agent session with proxy support
# Part of open-agents / agent-browser skill
#
# Usage:
#   ./proxy-session.sh [OPTIONS]
#
# Options:
#   --proxy-url      Full proxy URL (e.g. http://user:pass@host:port)
#   --proxy-type     Proxy type: http | socks5 (default: http)
#   --session-id     Optional session ID to resume an existing session
#   --headless       Run in headless mode (default: true)
#   --record         Enable video recording of the session
#   --output-dir     Directory to store session artifacts (default: ./output)

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
PROXY_URL=""
PROXY_TYPE="http"
SESSION_ID=""
HEADLESS="true"
RECORD="false"
OUTPUT_DIR="./output"

# ── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-url)   PROXY_URL="$2";   shift 2 ;;
    --proxy-type)  PROXY_TYPE="$2";  shift 2 ;;
    --session-id)  SESSION_ID="$2";  shift 2 ;;
    --headless)    HEADLESS="$2";    shift 2 ;;
    --record)      RECORD="true";    shift   ;;
    --output-dir)  OUTPUT_DIR="$2";  shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Validation ───────────────────────────────────────────────────────────────
if [[ -z "$PROXY_URL" ]]; then
  echo "Error: --proxy-url is required." >&2
  exit 1
fi

if [[ "$PROXY_TYPE" != "http" && "$PROXY_TYPE" != "socks5" ]]; then
  echo "Error: --proxy-type must be 'http' or 'socks5'." >&2
  exit 1
fi

# ── Prepare output directory ─────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

# Generate a session ID if one was not provided
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="session-$(date +%s)-$$"
  echo "Generated session ID: $SESSION_ID"
fi

SESSION_DIR="$OUTPUT_DIR/$SESSION_ID"
mkdir -p "$SESSION_DIR"

# ── Build the agent command ───────────────────────────────────────────────────
AGENT_ARGS=(
  --session-id  "$SESSION_ID"
  --proxy-url   "$PROXY_URL"
  --proxy-type  "$PROXY_TYPE"
  --headless    "$HEADLESS"
  --output-dir  "$SESSION_DIR"
)

if [[ "$RECORD" == "true" ]]; then
  AGENT_ARGS+=(--record --video-path "$SESSION_DIR/recording.webm")
fi

# ── Launch ───────────────────────────────────────────────────────────────────
echo "Starting proxy-enabled browser session..."
echo "  Session ID : $SESSION_ID"
echo "  Proxy      : $PROXY_TYPE://<redacted>"  # avoid leaking credentials
echo "  Headless   : $HEADLESS"
echo "  Recording  : $RECORD"
echo "  Artifacts  : $SESSION_DIR"
echo ""

# Invoke the open-agents browser runner (adjust binary path as needed)
npx open-agents browser "${AGENT_ARGS[@]}"

EXIT_CODE=$?

# ── Post-session summary ─────────────────────────────────────────────────────
if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "Session completed successfully."
  echo "Artifacts saved to: $SESSION_DIR"
else
  echo ""
  echo "Session exited with code $EXIT_CODE." >&2
fi

exit $EXIT_CODE
