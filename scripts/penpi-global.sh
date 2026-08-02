#!/usr/bin/env bash
#
# PENpi global install — run PENpi from ANY directory (e.g. a sandbox project),
# not just the repo. Everything points back at this repo (single source of truth),
# so editing the repo updates the install. Fully reversible: `uninstall`.
# Portable across Linux + macOS, bash / zsh / fish.
#
#   scripts/penpi-global.sh install     # wire it up
#   scripts/penpi-global.sh status      # show what's installed
#   scripts/penpi-global.sh uninstall   # remove everything it added
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/packages/coding-agent/dist/cli.js"
EXT_SRC="$REPO/.pi/extensions/penpi"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
BIN_DIR="$HOME/.local/bin"
PI_LINK="$BIN_DIR/pi"
EXT_LINK="$AGENT_DIR/extensions/penpi"
SETTINGS="$AGENT_DIR/settings.json"
MCP="$AGENT_DIR/mcp.json"          # adapter's canonical config (getAgentPath("mcp.json"))
ADAPTER="npm:pi-mcp-adapter@2.10.0"
SETTINGS_EDITOR="$REPO/scripts/penpi-settings.mjs"
BEGIN="#PENPI_GLOBAL_BEGIN"
END="#PENPI_GLOBAL_END"

# Pick the right shell rc + export syntax (macOS defaults to zsh).
case "$(basename "${SHELL:-/bin/bash}")" in
  zsh)  PROFILE="$HOME/.zshrc";  PROFILE_KIND=posix ;;
  fish) PROFILE="$HOME/.config/fish/config.fish"; PROFILE_KIND=fish ;;
  *)    PROFILE="$HOME/.bashrc"; PROFILE_KIND=posix ;;
esac
if [ "$PROFILE_KIND" = fish ]; then
  ENV_L1='set -gx PATH $HOME/.local/bin $PATH'
  ENV_L2="set -gx PENPI_MCP_CONFIG_PATH \"$MCP\""
else
  ENV_L1='export PATH="$HOME/.local/bin:$PATH"'
  ENV_L2="export PENPI_MCP_CONFIG_PATH=\"$MCP\""
fi

# Validate the managed shell block before ANY install/uninstall mutation. A partial,
# duplicated, or reversed marker pair is user data we do not understand; fail closed.
managed_block_state() {
  [ -f "$1" ] || { echo absent; return; }
  awk -v b="$BEGIN" -v e="$END" '
    $0==b {bc++; if(!bi)bi=NR}
    $0==e {ec++; if(!ei)ei=NR}
    END {
      if(bc==0 && ec==0) print "absent";
      else if(bc==1 && ec==1 && bi<ei) print "valid";
      else print "invalid";
    }' "$1"
}

validate_block() {
  state="$(managed_block_state "$1")"
  [ "$state" != invalid ] || {
    echo "❌ $1 contains an incomplete, duplicated, or reversed PENpi block — refusing to modify it." >&2
    echo "   Repair or remove the $BEGIN / $END marker lines, then retry." >&2
    return 1
  }
}

# Remove our already-validated managed block (portable — no `sed -i`).
remove_block() {
  [ "$(managed_block_state "$1")" = valid ] || return 0
  tmp="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" '$0==b{s=1} s==0{print} $0==e{s=0}' "$1" >"$tmp" && mv "$tmp" "$1"
}

# A managed marker must start on its own line. Shell rc files are allowed to end
# without a newline, so normalize that boundary before appending our block.
ensure_trailing_newline() {
  [ ! -s "$1" ] || [ "$(tail -c 1 "$1" | od -An -t u1 | tr -d '[:space:]')" = "10" ] || printf '\n' >>"$1"
}

# Re-point a symlink, portable (BSD `ln -sf` follows an existing dir symlink).
# Refuses to delete anything that isn't already a symlink — a real file/dir there
# belongs to someone else (e.g. an existing upstream-pi install) and is not ours
# to remove.
relink() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "❌ $2 exists and is not a symlink — refusing to overwrite it." >&2
    echo "   Move it aside and re-run, or install PENpi elsewhere." >&2
    exit 1
  fi
  rm -rf "$2"; ln -s "$1" "$2"
}

check_relink_target() {
  if [ -e "$1" ] && [ ! -L "$1" ]; then
    echo "❌ $1 exists and is not a symlink — refusing to overwrite it." >&2
    echo "   Move it aside and re-run, or install PENpi elsewhere." >&2
    exit 1
  fi
}

case "${1:-install}" in
install)
  validate_block "$PROFILE"
  [ -f "$CLI" ] || { echo "❌ PENpi is not built: $CLI is missing. Run npm run build first." >&2; exit 1; }
  check_relink_target "$PI_LINK"
  check_relink_target "$EXT_LINK"

  # Global settings: pin the adapter package + compaction off (merge, never clobber).
  node "$SETTINGS_EDITOR" install "$SETTINGS" "$ADAPTER"

  mkdir -p "$BIN_DIR" "$AGENT_DIR/extensions"
  relink "$CLI" "$PI_LINK"            # `pi` on PATH -> the fork's built CLI
  relink "$EXT_SRC" "$EXT_LINK"       # extension (symlink to repo = single source of truth)

  # Search is optional and user-selected. The installer never touches user-managed
  # MCP servers. PENpi writes only its `penfield` entry here at runtime.

  # PATH + the mcp-config override, in the detected shell's rc (idempotent).
  if ! grep -qF "$BEGIN" "$PROFILE" 2>/dev/null; then
    mkdir -p "$(dirname "$PROFILE")"
    ensure_trailing_newline "$PROFILE"
    { echo "$BEGIN"; printf '%s\n' "$ENV_L1"; printf '%s\n' "$ENV_L2"; echo "$END"; } >>"$PROFILE"
  fi
  echo "✅ PENpi installed globally. Activate this shell:  source \"$PROFILE\""
  echo "   Then from any dir:  pi -a --provider zai --model glm-5.2"
  echo "   Optional web search: $REPO/docs/WEB_SEARCH.md"
  ;;

uninstall)
  validate_block "$PROFILE"
  # Validate + update settings before removing links. Malformed/wrong-type/symlink
  # settings fail with the installation untouched instead of reporting false success.
  node "$SETTINGS_EDITOR" uninstall "$SETTINGS" "$ADAPTER"
  # Only remove links that point into THIS repo — never someone else's `pi`.
  [ -L "$PI_LINK" ] && case "$(readlink "$PI_LINK")" in "$REPO"/*) rm -f "$PI_LINK";; esac
  [ -L "$EXT_LINK" ] && case "$(readlink "$EXT_LINK")" in "$REPO"/*) rm -rf "$EXT_LINK";; esac
  remove_block "$PROFILE"
  echo "✅ PENpi global install removed (repo + your other settings untouched)."
  ;;

status)
  echo "shell rc:  $PROFILE"
  echo "pi:        $([ -L "$PI_LINK" ] && readlink "$PI_LINK" || echo 'MISSING')"
  echo "extension: $([ -L "$EXT_LINK" ] && readlink "$EXT_LINK" || echo 'MISSING')"
  grep -q pi-mcp-adapter "$SETTINGS" 2>/dev/null && echo "settings:  adapter pinned ✓" || echo "settings:  adapter MISSING"
  search_state="$(node - "$MCP" <<'NODE'
const fs=require("fs");const[p]=process.argv.slice(2);
try{const d=JSON.parse(fs.readFileSync(p,"utf8"));const names=Object.keys(d.mcpServers||{}).filter(x=>x!=="penfield");
if(names.length)console.log(`optional MCP server(s): ${names.join(", ")}`);else console.log("optional; not configured");
}catch{console.log("optional; not configured")}
NODE
)"
  echo "web search: $search_state"
  grep -qF "$BEGIN" "$PROFILE" 2>/dev/null && echo "rc:        PATH + PENPI_MCP_CONFIG_PATH ✓" || echo "rc:        not set"
  ;;

*) echo "usage: penpi-global.sh [install|uninstall|status]"; exit 1;;
esac
