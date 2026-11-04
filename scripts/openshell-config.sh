#!/usr/bin/env bash
# Print the paperclip-plugin-openshell environment config values that can be
# discovered from this OpenShell host. Run it as the user who runs the CLI.
#   scripts/openshell-config.sh [gateway-name]      (default: the active gateway)
# JSON goes to stdout (paste into the environment form); notes go to stderr.
# No secret values are read or printed: cert/key paths only, never contents.
set -euo pipefail

cfg="${XDG_CONFIG_HOME:-$HOME/.config}/openshell"
name="${1:-${OPENSHELL_GATEWAY:-}}"
[ -n "$name" ] || name="$(cat "$cfg/active_gateway" /etc/openshell/active_gateway 2>/dev/null | head -n1 || true)"
[ -n "$name" ] || { echo "no gateway: pass a name or run 'openshell gateway add' first" >&2; exit 1; }

meta="$cfg/gateways/$name/metadata.json"
[ -f "$meta" ] || meta="/etc/openshell/gateways/$name/metadata.json"
[ -f "$meta" ] || { echo "no metadata.json for gateway '$name'" >&2; exit 1; }
mtls="$cfg/gateways/$name/mtls"

providers='[]'
if command -v openshell >/dev/null; then
  providers="$(openshell provider list -o json -g "$name" 2>/dev/null || echo '{}')"
else
  echo "note: openshell CLI not on PATH; 'providers' left empty" >&2
fi

META="$meta" MTLS="$mtls" PROVIDERS="$providers" python3 -I - <<'EOF'
import json, os, sys
m = json.load(open(os.environ["META"]))
mtls = os.environ["MTLS"]
try:
    raw = json.loads(os.environ["PROVIDERS"])
except ValueError:
    raw = {}
items = raw.get("providers", []) if isinstance(raw, dict) else []
names = [(p.get("metadata") or p).get("name") for p in items]
mode = m.get("auth_mode") or "mtls"
out = {"gatewayEndpoint": m.get("gateway_endpoint"), "workspace": "default",
       "providers": [n for n in names if n]}
if mode == "mtls":
    for key, f in (("caCertPath", "ca.crt"), ("clientCertPath", "tls.crt"), ("clientKeyPath", "tls.key")):
        p = os.path.join(mtls, f)
        out[key] = p
        if not os.path.isfile(p):
            print(f"warning: {p} missing", file=sys.stderr)
else:
    print(f"warning: auth_mode={mode}; set oidcToken by hand (the plugin has no mTLS path for this mode)",
          file=sys.stderr)
print("note: the Paperclip server must be able to read these paths; 'providers' lists ALL "
      "providers, keep only the ones this environment should attach", file=sys.stderr)
print(json.dumps(out, indent=2))
EOF
