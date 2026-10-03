#!/usr/bin/env bash
set -uo pipefail

strict=false
packaging=""
while (($#)); do
  case "$1" in
    --strict) strict=true ;;
    --packaging)
      shift
      packaging="${1:-}"
      ;;
    *)
      echo "Usage: $0 [--strict] [--packaging deb|rpm|appimage]" >&2
      exit 2
      ;;
  esac
  shift
done

failures=0
warnings=0

pass() { printf '  [ok] %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; warnings=$((warnings + 1)); }
fail() { printf '  [missing] %s\n' "$1"; failures=$((failures + 1)); }

require_command() {
  if path=$(command -v "$1" 2>/dev/null); then
    pass "$1 ($path)"
  else
    fail "$1"
  fi
}

require_pkg_config() {
  local label=$1
  shift
  local candidate
  for candidate in "$@"; do
    if pkg-config --exists "$candidate" 2>/dev/null; then
      pass "$label ($candidate $(pkg-config --modversion "$candidate" 2>/dev/null || true))"
      return
    fi
  done
  fail "$label (pkg-config: $*)"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "AgentKib Linux diagnostics must run on Linux." >&2
  exit 2
fi

echo "AgentKib Linux environment diagnostics"
echo
echo "Platform"
printf '  kernel: %s\n' "$(uname -sr)"
printf '  architecture: %s\n' "$(uname -m)"
if [[ -r /etc/os-release ]]; then
  # Reading standard distro metadata only; never evaluate the file.
  distro=$(awk -F= '$1 == "PRETTY_NAME" { value=$2; gsub(/^"|"$/, "", value); print value; exit }' /etc/os-release)
  printf '  distribution: %s\n' "${distro:-unknown}"
fi
printf '  session: %s / %s\n' "${XDG_SESSION_TYPE:-unknown}" "${XDG_CURRENT_DESKTOP:-unknown}"

echo
echo "Build commands"
for command_name in git curl file node pnpm pkg-config patchelf strip; do
  require_command "$command_name"
done

if command -v pkg-config >/dev/null 2>&1; then
  echo
  echo "Electron Linux runtime"
  require_pkg_config "GTK 3" "gtk+-3.0"
fi

echo
echo "XDG paths"
printf '  config: %s\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
printf '  data: %s\n' "${XDG_DATA_HOME:-$HOME/.local/share}"
printf '  state: %s\n' "${XDG_STATE_HOME:-$HOME/.local/state}"
printf '  cache: %s\n' "${XDG_CACHE_HOME:-$HOME/.cache}"

echo
echo "Desktop integration"
if command -v gdbus >/dev/null 2>&1; then
  pass "gdbus ($(command -v gdbus))"
else
  fail "gdbus (install libglib2.0-bin on Debian/Ubuntu)"
fi
if [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  pass "D-Bus session is available"
else
  warn "D-Bus session is not visible; tray and desktop portals need runtime verification"
fi
if command -v xdg-open >/dev/null 2>&1; then
  pass "xdg-open ($(command -v xdg-open))"
else
  fail "xdg-open"
fi
if [[ -e /dev/fuse ]]; then
  pass "FUSE device is available"
else
  warn "FUSE device is unavailable; AppImage can still be extracted with --appimage-extract"
fi
if command -v getenforce >/dev/null 2>&1; then
  printf '  SELinux: %s\n' "$(getenforce 2>/dev/null || echo unknown)"
fi

case "$packaging" in
  "") ;;
  deb) require_command dpkg-deb ;;
  rpm)
    require_command rpmbuild
    require_command rpm2cpio
    require_command cpio
    ;;
  appimage) require_command patchelf ;;
  *)
    echo "Unsupported packaging target: $packaging" >&2
    exit 2
    ;;
esac

echo
printf 'Diagnostics complete: %d missing, %d warnings. No packages were installed and sudo was not used.\n' "$failures" "$warnings"
if $strict && ((failures > 0)); then
  exit 1
fi
