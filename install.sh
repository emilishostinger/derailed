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
OPENRC_PATH="/etc/init.d/derailed"
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

# How much colour this terminal can actually be trusted with. The wordmark is a
# gradient, and a gradient rendered in sixteen colours is worse than no gradient.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  case "${COLORTERM:-}" in
    truecolor|24bit) COLOR_DEPTH=full ;;
    *)
      case "${TERM:-}" in
        *256color*|*direct*) COLOR_DEPTH=256 ;;
        *)                   COLOR_DEPTH=basic ;;
      esac
      ;;
  esac
else
  COLOR_DEPTH=none
fi

say()  { printf '%s\n' "$*"; }
step() { printf '  %s→%s %s\n' "$DIM" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n  %s✗%s %s\n\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# -------------------------------------------------------------------- the splash
#
# The wordmark, in two tones of the purple the dashboard and the favicon already use:
# a lighter #a78bfa across the top three rows and the brand #7236e3 across the bottom
# three, so nothing new was invented for the terminal.
#
# Two rather than a ramp. Interpolated steps read as a smudge at this size, and every
# step past the second is a colour the brand does not otherwise have.
#
# Top to bottom also means a whole row is one colour, which is the entire implementation:
# no cutting a line into pieces, and so no need to care that these glyphs are three
# bytes each while mawk, `cut` and `fold` all count bytes and would happily slice a █
# down the middle.
#
# Written out rather than generated. There are lovely tools for this (oh-my-logo and
# friends), but every one of them is an npm package, and the promise this installer
# makes is that it needs nothing on the machine before it runs. Six lines of text
# cost nothing and keep that true.
#
# Sixty-one columns wide including the indent, so it is shown only on a real terminal
# with room for it. Piped to a file or a CI log it would be six lines of noise, and in
# a narrow phone SSH client it would wrap into confetti. Both fall back to one line.

WORDMARK='██████╗ ███████╗██████╗  █████╗ ██╗██╗     ███████╗██████╗
██╔══██╗██╔════╝██╔══██╗██╔══██╗██║██║     ██╔════╝██╔══██╗
██║  ██║█████╗  ██████╔╝███████║██║██║     █████╗  ██║  ██║
██║  ██║██╔══╝  ██╔══██╗██╔══██║██║██║     ██╔══╝  ██║  ██║
██████╔╝███████╗██║  ██║██║  ██║██║███████╗███████╗██████╔╝
╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚═════╝'

WORDMARK_WIDTH=61

# The two tones, in whatever the terminal understands. Rows 1 to 3 get the first.
# The lower half is the brand purple itself (#7236e3) and the upper half a lighter
# lavender. That way round because the darker tone is the one that has to survive a
# white terminal, where it reads at 6.3:1, and it is also the colour people know.
row_colour() {
  case "$COLOR_DEPTH" in
    full)
      case "$1" in
        1|2|3) printf '\033[38;2;167;139;250m' ;;
        *)     printf '\033[38;2;114;54;227m'  ;;
      esac
      ;;
    256)
      # 141 is #af87ff and 98 is #875fd7: the closest the xterm cube comes to each.
      case "$1" in
        1|2|3) printf '\033[38;5;141m' ;;
        *)     printf '\033[38;5;98m'  ;;
      esac
      ;;
    # Sixteen colours has one magenta and one bright magenta, and the plain one is
    # unreadably dark on half the themes people use. One tone is better than an
    # invisible half.
    basic) printf '\033[1;35m' ;;
    *)     printf '' ;;
  esac
}

# Anything that isn't a plausible column count means "we don't actually know", so the
# next source gets a turn. A pty with nothing driving it reports a size of 0, which is
# not a very narrow terminal, it is no answer at all.
usable_width() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 20 ] || return 1
  printf '%s' "$1"
}

terminal_width() {
  # Asked of the controlling terminal, not of stdout. `tput cols` here is read inside a
  # command substitution, where stdout is a pipe rather than the terminal, so it
  # answers from terminfo instead of from the window: a flat 80 whatever the real size
  # is, which left the narrow-terminal guard below never firing. It stays as a second
  # opinion, since an 80 that is merely conventional still beats no number at all.
  usable_width "$(stty size </dev/tty 2>/dev/null | awk '{print $2}' || true)" && return 0
  usable_width "$(tput cols 2>/dev/null || true)" && return 0
  usable_width "${COLUMNS:-}" && return 0
  # Nothing would tell us, so assume the eighty columns terminals have had since 1928.
  printf '80'
}

splash() {
  if [ ! -t 1 ] || [ "$(terminal_width)" -lt "$WORDMARK_WIDTH" ]; then
    say ""
    say "  ${BOLD}Derailed${RESET}"
    say "  ${DIM}Self-hosted deploys on your own server.${RESET}"
    say ""
    return
  fi

  say ""
  row=1
  printf '%s\n' "$WORDMARK" | while IFS= read -r line; do
    printf '  %s%s%s\n' "$(row_colour "$row")" "$line" "$RESET"
    row=$((row + 1))
  done
  say ""
  say "  ${DIM}Your own tiny cloud. Self-hosted, on your own server.${RESET}"
  say ""
}

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

splash

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

# Alpine and friends build on musl rather than glibc, and a glibc binary there does
# not fail with a message about glibc: the shell says "not found" about a file that is
# obviously present, which sends people hunting for the wrong problem entirely. There
# is a separate build, so pick it.
if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | head -1 | grep -qi musl); then
  ARCH="$ARCH-musl"
  LIBC="musl"
else
  LIBC="glibc"
fi

# Read in a subshell. Sourcing os-release directly sets VERSION, NAME and others,
# which silently overwrote the version of Derailed being installed: every Ubuntu box
# ended up asking GitHub for a release called "v24.04.4 LTS (Noble Numbat)".
if [ -r /etc/os-release ]; then
  OS_NAME=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-$ID}")
  OS_ID=$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}${ID_LIKE:-}")
else
  OS_ID=""; OS_NAME="$(uname -s)"
fi

step "$OS_NAME ($ARCH)"

# Which package manager this machine has.
#
# Derailed itself is one static binary and does not care what distribution it is on.
# The only reason to know is to install curl, git and tar when they are missing, so
# this is a lookup rather than a supported-platforms list. An unrecognised manager is
# not a refusal: if the three tools are already there, nothing needs installing and
# the question never comes up.
PM=""
for candidate in apt-get dnf yum pacman apk zypper; do
  if command -v "$candidate" >/dev/null 2>&1; then PM="$candidate"; break; fi
done

install_packages() {
  # $* = package names
  case "$PM" in
    apt-get)
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      # shellcheck disable=SC2086
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $* >/dev/null
      ;;
    # shellcheck disable=SC2086
    dnf)    dnf install -y -q $* >/dev/null ;;
    # shellcheck disable=SC2086
    yum)    yum install -y -q $* >/dev/null ;;
    # shellcheck disable=SC2086
    pacman) pacman -Sy --noconfirm --needed $* >/dev/null ;;
    # shellcheck disable=SC2086
    apk)    apk add --no-cache $* >/dev/null ;;
    # shellcheck disable=SC2086
    zypper) zypper --non-interactive install -y $* >/dev/null ;;
    *) return 1 ;;
  esac
}

# How this machine starts things at boot.
#
# systemd is what nearly every server distribution uses, and OpenRC is what Alpine
# uses, which is the one people reach for when they want a small VM. Anything else
# gets the binary and a line telling them how to run it, which is honest and still
# leaves them with a working Derailed.
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  INIT="systemd"
elif command -v rc-update >/dev/null 2>&1; then
  INIT="openrc"
else
  INIT="none"
fi
HAS_SYSTEMD=0
[ "$INIT" = "systemd" ] && HAS_SYSTEMD=1

if [ "$INIT" = "none" ]; then
  warn "No systemd or OpenRC here, so Derailed won't be installed as a service."
fi

# Waits for the dashboard to answer, so "started" means started.
wait_for_health() {
  i=0
  while [ "$i" -lt 30 ]; do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------------ basic tools

MISSING=""
for tool in curl git tar; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done

# The musl build still wants the C++ runtime, which a minimal Alpine does not have.
# Without it the binary starts and immediately reports a missing shared library.
if [ "$LIBC" = "musl" ] && [ "$PM" = "apk" ] && [ ! -e /usr/lib/libstdc++.so.6 ]; then
  MISSING="$MISSING libstdc++"
fi

if [ -n "$MISSING" ]; then
  step "Installing:$MISSING"
  # shellcheck disable=SC2086
  if install_packages $MISSING; then
    ok "Installed:$MISSING"
  else
    die "Please install:$MISSING, then run this again."
  fi
fi

# ----------------------------------------------------------------------- docker

start_docker() {
  case "$INIT" in
    systemd) systemctl enable --now docker >/dev/null 2>&1 || true ;;
    openrc)  rc-update add docker default >/dev/null 2>&1; rc-service docker start >/dev/null 2>&1 || true ;;
    *)       return 0 ;;
  esac
}

docker_hint() {
  case "$INIT" in
    systemd) printf '%s' "Check: systemctl status docker" ;;
    openrc)  printf '%s' "Check: rc-service docker status" ;;
    *)       printf '%s' "Start the Docker daemon, then run this again." ;;
  esac
}

# get.docker.com covers Debian, Ubuntu, Fedora, CentOS, RHEL and openSUSE. It does
# not cover Alpine or Arch, which package Docker themselves and where the script
# refuses rather than doing something surprising, so those go through the
# distribution instead.
install_docker() {
  case "$PM" in
    apk)    install_packages docker docker-cli ;;
    pacman) install_packages docker ;;
    *)      curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 ;;
  esac
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker is already running"
elif command -v docker >/dev/null 2>&1; then
  step "Docker is installed but not running, starting it"
  start_docker
  docker info >/dev/null 2>&1 || die "Docker is installed but won't start. $(docker_hint)"
  ok "Docker started"
else
  say ""
  say "  Derailed runs your apps in Docker containers, so it needs Docker."
  confirm "Install Docker now?" || die "Nothing was changed. Install Docker, then run this again."
  step "Installing Docker. This takes a minute"
  install_docker || die "Docker install failed. Install it the way your distribution recommends, then run this again."
  start_docker
  docker info >/dev/null 2>&1 || die "Docker installed but isn't responding. $(docker_hint)"
  ok "Docker installed"
fi

# Derailed speaks Docker's API directly and pins a version of it, so a daemon too old
# to answer is worth saying now rather than after the install, from a dashboard that
# cannot start anything. The distribution packages on older releases are exactly this.
DOCKER_MAJOR=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1)
case "$DOCKER_MAJOR" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$DOCKER_MAJOR" -lt 25 ]; then
      warn "This Docker is version $(docker version --format '{{.Server.Version}}' 2>/dev/null), and Derailed needs 25 or newer."
      say "  ${DIM}Upgrade it with: curl -fsSL https://get.docker.com | sh${RESET}"
      confirm "Carry on anyway?" || die "Nothing was changed."
    fi
    ;;
esac

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

  # Checksums are published with every release, and this binary is about to run as
  # root, so a missing or mismatched one stops the install rather than warning about
  # it. The one thing that is allowed to be absent is `sha256sum` itself, on a machine
  # too minimal to have coreutils; that is said out loud rather than passed over.
  curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt" 2>/dev/null \
    || die "Couldn't fetch the checksums for this release, so nothing was installed."

  EXPECTED=$(grep " derailed-$ARCH\$" "$TMP/checksums.txt" | awk '{print $1}' | head -1)
  [ -n "$EXPECTED" ] || die "This release publishes no checksum for derailed-$ARCH. Nothing was installed."

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$TMP/derailed" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$TMP/derailed" | awk '{print $1}')
  else
    ACTUAL=""
    warn "No sha256sum on this machine, so the download could not be verified."
  fi

  if [ -n "$ACTUAL" ]; then
    [ "$EXPECTED" = "$ACTUAL" ] || die "The download didn't match its checksum. Nothing was installed."
    ok "Checksum verified"
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
    ADMIN_PASSWORD=$(ask_secret "Choose a password (10+ characters):")
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
  if [ ${#ADMIN_PASSWORD} -lt 10 ]; then
    warn "That password is too short, so the account wasn't created."
    ADMIN_EMAIL=""
  else
    step "Creating your account"
    # The password goes through the environment, not the command line. Two reasons:
    # arguments are world-readable in `ps` while the command runs, and building a
    # string of flags and letting the shell split it meant a passphrase with a space
    # in it was silently cut at the space, so the account was created with a password
    # nobody could type back.
    if [ -n "$PANEL_DOMAIN" ]; then
      DERAILED_SETUP_PASSWORD="$ADMIN_PASSWORD" "$BIN_PATH" setup \
        --email "$ADMIN_EMAIL" --domain "$PANEL_DOMAIN" >/dev/null \
        || die "Couldn't create the account."
    else
      DERAILED_SETUP_PASSWORD="$ADMIN_PASSWORD" "$BIN_PATH" setup \
        --email "$ADMIN_EMAIL" >/dev/null \
        || die "Couldn't create the account."
    fi
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
    wait_for_health || die "Derailed didn't come up. See what it said with: journalctl -u derailed -n 50 --no-pager"
    ok "Service started"
  fi
elif [ "$INIT" = "openrc" ]; then
  cat > "$OPENRC_PATH" <<'RC'
#!/sbin/openrc-run

description="Derailed"

command="__BIN__"
command_args="serve"
command_background=true
pidfile="/run/derailed.pid"
output_log="/var/log/derailed.log"
error_log="/var/log/derailed.log"
directory="__DATA__"

depend() {
	need docker
	after net
}
RC
  sed -i "s|__BIN__|$BIN_PATH|; s|__DATA__|$DATA_DIR|" "$OPENRC_PATH"
  printf 'export DERAILED_PORT=%s\n' "$PORT" > /etc/conf.d/derailed
  chmod 0755 "$OPENRC_PATH"
  rc-update add derailed default >/dev/null 2>&1

  if [ "$START_SERVICE" = "1" ]; then
    rc-service derailed restart >/dev/null 2>&1
    wait_for_health || die "Derailed didn't come up. See what it said in: /var/log/derailed.log"
    ok "Service started"
  fi
else
  warn "Start it yourself with: $BIN_PATH serve"
fi

# ------------------------------------------------------------------------- done

[ -n "$IP" ] || IP="your-server-ip"

say ""
if [ "$INIT" != "none" ] && [ "$START_SERVICE" = "1" ]; then
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
  if [ "$INIT" = "openrc" ]; then
    say "  ${DIM}Logs      tail -f /var/log/derailed.log${RESET}"
    say "  ${DIM}Restart   rc-service derailed restart${RESET}"
  else
    say "  ${DIM}Logs      journalctl -u derailed -f${RESET}"
    say "  ${DIM}Restart   systemctl restart derailed${RESET}"
  fi
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
  if [ "$INIT" = "systemd" ]; then
    say "  Start it   ${BOLD}systemctl start derailed${RESET}"
    say "  ${DIM}${NEXT}${RESET}"
  elif [ "$INIT" = "openrc" ]; then
    say "  Start it   ${BOLD}rc-service derailed start${RESET}"
    say "  ${DIM}${NEXT}${RESET}"
  else
    say "  Start it   ${BOLD}derailed serve${RESET}"
    say "  ${DIM}${NEXT}${RESET}"
    say "  ${DIM}There's no service manager here, so nothing will restart it for you.${RESET}"
  fi
fi
say ""
