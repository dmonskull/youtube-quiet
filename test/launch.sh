#!/bin/sh
# Start a throwaway browser with the extension loaded and the DevTools port
# open. Works with Chrome for Testing, Opera and Opera GX. Usage:
#   BROWSER_BIN="/path/to/browser binary" test/launch.sh [profile-dir]
# HEADLESS=1 runs without a window. A headless browser calls itself
# "HeadlessChrome"; pass USER_AGENT to make it report its normal one.
# EXTENSION_DIR loads the extension from another folder, e.g. an unpacked
# release ZIP, instead of this checkout.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:-$root/test/.profile}"
port="${CDP_PORT:-19444}"
bin="${BROWSER_BIN:-${CHROME_BIN:-}}"
: "${bin:?Set BROWSER_BIN to a Chrome for Testing, Opera or Opera GX binary}"

set -- "--load-extension=${EXTENSION_DIR:-$root}" --disable-features=DisableLoadExtensionCommandLineSwitch
if [ "${HEADLESS:-}" = "1" ]; then
  set -- "$@" --headless=new
  if [ -n "${USER_AGENT:-}" ]; then set -- "$@" "--user-agent=$USER_AGENT"; fi
fi

exec "$bin" \
  "--user-data-dir=$profile" \
  "--remote-debugging-port=$port" \
  --no-first-run --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required --mute-audio \
  --window-size=1320,900 \
  "$@" about:blank
