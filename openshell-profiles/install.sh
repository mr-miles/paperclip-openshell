#!/usr/bin/env bash
# Install the OpenShell egress provider profiles + instances that the
# paperclip-openshell plugin attaches to its sandboxes.
#
# Run this on the OpenShell gateway/operator host (the `openshell` CLI must be
# on PATH). It lints + imports each profile, then creates a provider instance
# of the same name. Re-runnable: an existing profile is updated, an existing
# provider instance is left as-is.
#
#   ./install.sh [--workspace NAME] [--gateway NAME]
#
# Defaults: --workspace paperclip (match the plugin's `workspace` config so the
# sandboxes, which run in that workspace, can attach the providers by name).
#
# After running, set the Paperclip environment's `providers` to:
#   ["anthropic-egress", "paperclip-egress"]
set -euo pipefail

WORKSPACE="paperclip"
GATEWAY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --workspace=*) WORKSPACE="${1#*=}"; shift ;;
    --gateway|-g) GATEWAY="$2"; shift 2 ;;
    --gateway=*) GATEWAY="${1#*=}"; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v openshell >/dev/null 2>&1 || { echo "error: 'openshell' CLI not on PATH" >&2; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILES=(anthropic-egress paperclip-egress)

# openshell invocation with the shared scope flags.
osh() {
  if [ -n "$GATEWAY" ]; then
    openshell -g "$GATEWAY" --workspace "$WORKSPACE" "$@"
  else
    openshell --workspace "$WORKSPACE" "$@"
  fi
}

# Run a command; if it fails only because the resource already exists, treat it
# as success (idempotent). Any other failure is fatal.
tolerate_exists() {
  local err; err="$(mktemp)"
  if "$@" 2>"$err"; then rm -f "$err"; return 0; fi
  if grep -qiE "already.*exist|exist.*already|conflict" "$err"; then
    echo "   (already exists — skipping)"
    rm -f "$err"; return 0
  fi
  cat "$err" >&2; rm -f "$err"; return 1
}

echo "Target workspace: $WORKSPACE${GATEWAY:+ (gateway: $GATEWAY)}"

for p in "${PROFILES[@]}"; do
  f="$DIR/$p.yaml"
  [ -f "$f" ] || { echo "error: profile file not found: $f" >&2; exit 1; }
  echo "== profile '$p': lint =="
  osh provider profile lint -f "$f"
  echo "== profile '$p': import =="
  err="$(mktemp)"
  if ! osh provider profile import -f "$f" 2>"$err"; then
    if grep -qiE "already.*exist|exist.*already|conflict" "$err"; then
      echo "   profile exists — updating"
      osh provider profile update "$p" -f "$f"
    else
      cat "$err" >&2; rm -f "$err"; exit 1
    fi
  fi
  rm -f "$err"
done

for p in "${PROFILES[@]}"; do
  echo "== provider instance '$p': create =="
  tolerate_exists osh provider create --name "$p" --type "$p"
done

echo "== verify =="
osh provider profile list
osh provider list

echo
echo "Done. Now set the Paperclip environment's providers to:"
echo "  [\"anthropic-egress\", \"paperclip-egress\"]"
