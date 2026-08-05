#!/bin/sh
#
# Derailed installer.
#
#   curl -fsSL https://raw.githubusercontent.com/emilishostinger/derailed/main/install.sh | sh
#
# Installs Docker if it's missing, drops a single binary at /usr/local/bin/derailed,
# writes a systemd unit, and starts it. Then you open the printed URL and finish in
# the browser. Nothing else to configure.
#
# Flags (or the matching environment variables):
#   -y, --yes                 don't ask anything (assume yes)
#   --version X.Y.Z           install a specific release        (DERAILED_VERSION)
#   --binary /path/to/file    install a local binary instead of downloading
#                                                               (DERAILED_BINARY)
#   --no-start                install but don't start the service
#   --domain panel.example.com  serve the dashboard here, over HTTPS  (DERAILED_DOMAIN)
#   --email you@example.com     create the admin account              (DERAILED_EMAIL)
#   --password ...              its password                          (DERAILED_PASSWORD)
#   --no-setup                  don't ask anything; finish in the browser
#
# POSIX sh on purpose: a fresh Debian minimal image doesn't always have bash.

set -eu

REPO="emilishostinger/derailed"
BIN_PATH="/usr/local/bin/derailed"
DATA_DIR="/var/lib/derailed"
UNIT_PATH="/etc/systemd/system/derailed.service"
PORT="${DERAILED_PORT:-8422}"

ASSUME_YES="${DERAILED_YES:-0}"
VERSION="${DERAILED_VERSION:-latest}"
LOCAL_BINARY="${DERAILED_BINARY:-}"
START_SERVICE=1
PANEL_DOMAIN="${DERAILED_DOMAIN:-}"
ADMIN_EMAIL="${DERAILED_EMAIL:-}"
ADMIN_PASSWORD="${DERAILED_PASSWORD:-}"
SKIP_QUESTIONS="${DERAILED_NO_SETUP:-0}"

# ---------------------------------------------------------------- pretty output

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '  %s→%s %s\n' "$DIM" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n  %s✗%s %s\n\n' "$RED" "$RESET" "$*" >&2; exit 1; }

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  # No terminal to ask on (curl | sh with no tty): default to yes, since running
  # this script at all is the consent.
  [ -t 0 ] || return 0
  printf '  %s [Y/n] ' "$1"
  read -r reply </dev/tty || return 0
  case "$reply" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

# Reads one answer. Returns empty when there's no terminal (curl | sh in a script),
# which is exactly when we should fall back to the browser instead of hanging.
ask() {
  # $1 = prompt, $2 = default (optional)
  [ -t 0 ] || { printf '%s' "${2:-}"; return 0; }
  if [ -n "${2:-}" ]; then
    printf '  %s %s[%s]%s ' "$1" "$DIM" "$2" "$RESET" >&2
  else
    printf '  %s ' "$1" >&2
  fi
  read -r reply </dev/tty || reply=''
  printf '%s' "${reply:-${2:-}}"
}

ask_secret() {
  [ -t 0 ] || { printf ''; return 0; }
  printf '  %s ' "$1" >&2
  stty -echo 2>/dev/null || true
  read -r reply </dev/tty || reply=''
  stty echo 2>/dev/null || true
  printf '\n' >&2
  printf '%s' "$reply"
}

# ---------------------------------------------------------------------- options

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)     ASSUME_YES=1 ;;
    --version)    VERSION="${2:?--version needs a value}"; shift ;;
    --version=*)  VERSION="${1#*=}" ;;
    --binary)     LOCAL_BINARY="${2:?--binary needs a path}"; shift ;;
    --binary=*)   LOCAL_BINARY="${1#*=}" ;;
    --no-start)   START_SERVICE=0 ;;
    --domain)     PANEL_DOMAIN="${2:?--domain needs a value}"; shift ;;
    --domain=*)   PANEL_DOMAIN="${1#*=}" ;;
    --email)      ADMIN_EMAIL="${2:?--email needs a value}"; shift ;;
    --email=*)    ADMIN_EMAIL="${1#*=}" ;;
    --password)   ADMIN_PASSWORD="${2:?--password needs a value}"; shift ;;
    --password=*) ADMIN_PASSWORD="${1#*=}" ;;
    --no-setup)   SKIP_QUESTIONS=1 ;;
    -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "Unknown option: $1" ;;
  esac
  shift
done

say ""
say "  ${BOLD}Derailed${RESET}"
say "  ${DIM}Self-hosted deploys on your own server.${RESET}"
say ""

# ------------------------------------------------------------------ environment

[ "$(id -u)" = "0" ] || die "This needs to run as root. Try: curl -fsSL https://raw.githubusercontent.com/emilishostinger/derailed/main/install.sh | sudo sh"

case "$(uname -s)" in
  Linux) ;;
  *) die "Derailed runs on Linux servers. This machine is $(uname -s)." ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="linux-x64" ;;
  aarch64|arm64) ARCH="linux-arm64" ;;
  *) die "Unsupported processor: $(uname -m). Derailed ships 64-bit Intel and ARM builds." ;;
esac

# Read in a subshell. Sourcing os-release directly sets VERSION, NAME and others,
# which silently overwrote the version of Derailed being installed: every Ubuntu box
# ended up asking GitHub for a release called "v24.04.4 LTS (Noble Numbat)".
if [ -r /etc/os-release ]; then
  OS_NAME=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-$ID}")
  OS_ID=$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}${ID_LIKE:-}")
else
  OS_ID=""; OS_NAME="$(uname -s)"
fi

case "${OS_ID:-}" in
  *debian*|*ubuntu*) ;;
  *)
    warn "$OS_NAME isn't a tested platform. Derailed is built for Debian and Ubuntu."
    confirm "Try anyway?" || die "Nothing was changed."
    ;;
esac

step "$OS_NAME ($ARCH)"

if command -v systemctl >/dev/null 2>&1; then
  HAS_SYSTEMD=1
else
  HAS_SYSTEMD=0
  warn "systemd isn't available here, so Derailed won't be installed as a service."
fi

# ------------------------------------------------------------------ basic tools

MISSING=""
for tool in curl git tar; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done

if [ -n "$MISSING" ]; then
  step "Installing:$MISSING"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $MISSING >/dev/null
  else
    die "Please install:$MISSING, then run this again."
  fi
  ok "Installed:$MISSING"
fi

# ----------------------------------------------------------------------- docker

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker is already running"
elif command -v docker >/dev/null 2>&1; then
  step "Docker is installed but not running, starting it"
  [ "$HAS_SYSTEMD" = "1" ] && systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker is installed but won't start. Check: systemctl status docker"
  ok "Docker started"
else
  say ""
  say "  Derailed runs your apps in Docker containers, so it needs Docker."
  confirm "Install Docker now (from get.docker.com)?" || die "Nothing was changed. Install Docker, then run this again."
  step "Installing Docker. This takes a minute"
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Docker install failed. Try it by hand: curl -fsSL https://get.docker.com | sh"
  [ "$HAS_SYSTEMD" = "1" ] && systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker installed but isn't responding. Check: systemctl status docker"
  ok "Docker installed"
fi

# ------------------------------------------------------------------- the binary

install_from_file() {
  # $1 = source file
  install -m 0755 "$1" "$BIN_PATH.new"
  mv -f "$BIN_PATH.new" "$BIN_PATH"
}

if [ -n "$LOCAL_BINARY" ]; then
  [ -f "$LOCAL_BINARY" ] || die "No such file: $LOCAL_BINARY"
  step "Installing from $LOCAL_BINARY"
  install_from_file "$LOCAL_BINARY"
else
  if [ "$VERSION" = "latest" ]; then
    BASE="https://github.com/$REPO/releases/latest/download"
  else
    BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
  fi

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  step "Downloading Derailed ($ARCH)"
  curl -fsSL "$BASE/derailed-$ARCH" -o "$TMP/derailed" \
    || die "Couldn't download the release. Check your connection, or grab it from https://github.com/$REPO/releases"

  # Checksums are published alongside the binaries; verify when we can.
  if curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt" 2>/dev/null; then
    EXPECTED=$(grep " derailed-$ARCH\$" "$TMP/checksums.txt" | awk '{print $1}' | head -1)
    if [ -n "$EXPECTED" ] && command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "$TMP/derailed" | awk '{print $1}')
      [ "$EXPECTED" = "$ACTUAL" ] || die "The download didn't match its checksum. Nothing was installed."
      ok "Checksum verified"
    fi
  else
    warn "No checksum file published for this release, skipping verification."
  fi

  install_from_file "$TMP/derailed"
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
ok "Installed $("$BIN_PATH" version 2>/dev/null || echo "derailed") at $BIN_PATH"

# ------------------------------------------------------------------- guided setup
#
# Asked before the service starts, so the very first thing anyone sees can be a
# dashboard on HTTPS they're already able to sign in to, rather than a plain-HTTP
# page over an IP address asking them to invent a password.

IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
[ -n "$IP" ] || IP=$(hostname -I 2>/dev/null | awk '{print $1}')

if [ "$SKIP_QUESTIONS" != "1" ] && [ -t 0 ] && [ -z "$ADMIN_EMAIL" ]; then
  say ""
  say "  ${BOLD}Let's set you up.${RESET}"
  say "  ${DIM}Press enter to skip any of these and finish in the browser instead.${RESET}"
  say ""

  if [ -z "$PANEL_DOMAIN" ]; then
    say "  ${DIM}A domain means the dashboard gets HTTPS. Point an A record at $IP first.${RESET}"
    PANEL_DOMAIN=$(ask "Domain for the dashboard, e.g. panel.example.com:")
  fi
  [ -z "$ADMIN_EMAIL" ] && ADMIN_EMAIL=$(ask "Your email:")
  if [ -n "$ADMIN_EMAIL" ] && [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD=$(ask_secret "Choose a password (8+ characters):")
  fi
fi

# A domain that doesn't point here yet would leave the dashboard unreachable, so
# check before committing to it.
if [ -n "$PANEL_DOMAIN" ] && [ -n "$IP" ]; then
  RESOLVED=$(getent ahostsv4 "$PANEL_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
  if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$IP" ]; then
    warn "$PANEL_DOMAIN points at $RESOLVED, not this server ($IP)."
    warn "Carrying on without it. You can set it later in Settings."
    PANEL_DOMAIN=""
  elif [ -z "$RESOLVED" ]; then
    warn "$PANEL_DOMAIN doesn't resolve yet. Add an A record pointing to $IP."
    warn "Carrying on without it. You can set it later in Settings."
    PANEL_DOMAIN=""
  fi
fi

if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  if [ ${#ADMIN_PASSWORD} -lt 8 ]; then
    warn "That password is too short, so the account wasn't created."
    ADMIN_EMAIL=""
  else
    step "Creating your account"
    SETUP_ARGS="--email $ADMIN_EMAIL --password $ADMIN_PASSWORD"
    [ -n "$PANEL_DOMAIN" ] && SETUP_ARGS="$SETUP_ARGS --domain $PANEL_DOMAIN"
    # shellcheck disable=SC2086
    "$BIN_PATH" setup $SETUP_ARGS >/dev/null || die "Couldn't create the account."
    ok "Account created"
  fi
elif [ -n "$PANEL_DOMAIN" ]; then
  "$BIN_PATH" setup --domain "$PANEL_DOMAIN" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------- service

if [ "$HAS_SYSTEMD" = "1" ]; then
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Derailed
Documentation=https://github.com/$REPO
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
ExecStart=$BIN_PATH serve
Environment=DERAILED_PORT=$PORT
Restart=always
RestartSec=3
# The build pipeline shells out to git and tar and can be memory-hungry on a small
# VPS; don't let a failed build take the whole service down with it.
OOMPolicy=continue
StateDirectory=derailed
WorkingDirectory=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable derailed >/dev/null 2>&1

  if [ "$START_SERVICE" = "1" ]; then
    systemctl restart derailed
    # Give it a moment to bind the port before we claim success.
    i=0
    while [ "$i" -lt 30 ]; do
      if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        break
      fi
      i=$((i + 1))
      sleep 1
    done
    if [ "$i" -ge 30 ]; then
      die "Derailed didn't come up. See what it said with: journalctl -u derailed -n 50 --no-pager"
    fi
    ok "Service started"
  fi
else
  warn "Start it yourself with: $BIN_PATH serve"
fi

# ------------------------------------------------------------------------- done

[ -n "$IP" ] || IP="your-server-ip"

say ""
if [ "$HAS_SYSTEMD" = "1" ] && [ "$START_SERVICE" = "1" ]; then
  say "  ${GREEN}${BOLD}Derailed is running.${RESET}"
  say ""
  if [ -n "$PANEL_DOMAIN" ]; then
    say "  Open  ${BOLD}https://$PANEL_DOMAIN${RESET}"
    say "  ${DIM}The certificate is being issued now, give it a few seconds.${RESET}"
  else
    say "  Open  ${BOLD}http://$IP:$PORT${RESET}"
  fi
  if [ -n "$ADMIN_EMAIL" ]; then
    say "  ${DIM}Sign in as $ADMIN_EMAIL.${RESET}"
  else
    say "  ${DIM}Create your account in the browser. That's the whole setup.${RESET}"
  fi
  say ""
  say "  ${DIM}Logs      journalctl -u derailed -f${RESET}"
  say "  ${DIM}Restart   systemctl restart derailed${RESET}"
  say "  ${DIM}Update    derailed update${RESET}"
else
  say "  ${GREEN}${BOLD}Derailed is installed.${RESET}"
  say ""
  if [ -n "$PANEL_DOMAIN" ]; then
    WHERE="https://$PANEL_DOMAIN"
  else
    WHERE="http://$IP:$PORT"
  fi
  if [ -n "$ADMIN_EMAIL" ]; then
    NEXT="Then open $WHERE and sign in as $ADMIN_EMAIL."
  else
    NEXT="Then open $WHERE and create your account."
  fi
  if [ "$HAS_SYSTEMD" = "1" ]; then
    say "  Start it   ${BOLD}systemctl start derailed${RESET}"
    say "  ${DIM}${NEXT}${RESET}"
  else
    say "  Start it   ${BOLD}derailed serve${RESET}"
    say "  ${DIM}${NEXT}${RESET}"
    say "  ${DIM}There's no systemd here, so nothing will restart it for you.${RESET}"
  fi
fi
say ""
