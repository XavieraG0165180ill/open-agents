#!/usr/bin/env bash
# screenshot-capture.sh
# Template for capturing screenshots of web pages using the agent-browser skill.
# Supports full-page captures, element-specific screenshots, and viewport customization.
#
# Usage:
#   ./screenshot-capture.sh [OPTIONS] <url>
#
# Options:
#   -o, --output <path>       Output file path (default: screenshot.png)
#   -f, --full-page           Capture full page (default: viewport only)
#   -s, --selector <css>      Capture specific element by CSS selector
#   -w, --width <px>          Viewport width (default: 1280)
#   -h, --height <px>         Viewport height (default: 720)
#   -d, --delay <ms>          Delay before capture in milliseconds (default: 0)
#   -q, --quality <0-100>     JPEG quality (only for .jpg output, default: 90)
#   --headless                Run in headless mode (default: true)
#   --dark-mode               Enable dark color scheme
#   --hide-scrollbars         Hide scrollbars before capture

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
OUTPUT="screenshot.png"
FULL_PAGE=false
SELECTOR=""
VIEWPORT_WIDTH=1280
VIEWPORT_HEIGHT=720
DELAY_MS=0
JPEG_QUALITY=90
HEADLESS=true
DARK_MODE=false
HIDE_SCROLLBARS=false
URL=""

# ── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)       OUTPUT="$2";          shift 2 ;;
    -f|--full-page)    FULL_PAGE=true;        shift   ;;
    -s|--selector)     SELECTOR="$2";        shift 2 ;;
    -w|--width)        VIEWPORT_WIDTH="$2";  shift 2 ;;
    -h|--height)       VIEWPORT_HEIGHT="$2"; shift 2 ;;
    -d|--delay)        DELAY_MS="$2";        shift 2 ;;
    -q|--quality)      JPEG_QUALITY="$2";    shift 2 ;;
    --headless)        HEADLESS=true;         shift   ;;
    --no-headless)     HEADLESS=false;        shift   ;;
    --dark-mode)       DARK_MODE=true;        shift   ;;
    --hide-scrollbars) HIDE_SCROLLBARS=true;  shift   ;;
    -*)                echo "Unknown option: $1" >&2; exit 1 ;;
    *)                 URL="$1";             shift   ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "Error: URL is required." >&2
  echo "Usage: $0 [OPTIONS] <url>" >&2
  exit 1
fi

# ── Build Playwright script ──────────────────────────────────────────────────
PLAYWRIGHT_SCRIPT=$(cat <<SCRIPT
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: ${HEADLESS} });
  const context = await browser.newContext({
    viewport: { width: ${VIEWPORT_WIDTH}, height: ${VIEWPORT_HEIGHT} },
    colorScheme: '$([ "$DARK_MODE" = true ] && echo dark || echo light)',
  });

  const page = await context.newPage();

  $([ "$HIDE_SCROLLBARS" = true ] && echo "
  await page.addStyleTag({ content: '::-webkit-scrollbar { display: none !important; }' });
  ")

  await page.goto('${URL}', { waitUntil: 'networkidle' });

  $([ "$DELAY_MS" -gt 0 ] && echo "await page.waitForTimeout(${DELAY_MS});")

  const screenshotOptions = {
    path: '${OUTPUT}',
    fullPage: ${FULL_PAGE},
    $(echo "${OUTPUT}" | grep -qi '\.jpe\?g$' && echo "quality: ${JPEG_QUALITY},")
  };

  $(if [[ -n "$SELECTOR" ]]; then
    echo "const element = await page.locator('${SELECTOR}').first();"
    echo "await element.screenshot(screenshotOptions);"
  else
    echo "await page.screenshot(screenshotOptions);"
  fi)

  console.log('Screenshot saved to: ${OUTPUT}');
  await browser.close();
})();
SCRIPT
)

# ── Execute ──────────────────────────────────────────────────────────────────
echo "Capturing screenshot of: $URL"
echo "Output: $OUTPUT  |  Full page: $FULL_PAGE  |  Viewport: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}"

node -e "$PLAYWRIGHT_SCRIPT"
