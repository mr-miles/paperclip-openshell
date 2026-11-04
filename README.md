# paperclip-plugin-openshell

A [Paperclip](https://github.com/paperclipai/paperclip) **sandbox-provider** plugin that runs each agent inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox, talking to the OpenShell **gateway over its gRPC API** (`@nvidia/openshell-sdk`). With [openshell-firecracker](https://github.com/mr-miles/openshell-firecracker) configured as OpenShell's compute driver, each sandbox is a Firecracker microVM.

```
Paperclip server ─▶ this plugin (out-of-process worker)
                      └─ @nvidia/openshell-sdk (gRPC/HTTP-2, persistent connection) ─▶ OpenShell gateway
                                                                                        ─▶ compute driver (e.g. openshell-firecracker)
                                                                                           ─▶ Firecracker microVM
```

The plugin drives sandbox lifecycle and streaming exec over one persistent gateway connection. It does **not** shell out to the `openshell` CLI. OpenShell's gateway enforces egress policy, TLS inspection and credential injection; choosing Firecracker is an operator-side OpenShell config, not something this plugin does.

`driverKey: openshell` · plugin id `paperclip.openshell-sandbox-provider` · provider key `paperclip.openshell-sandbox-provider:openshell`.

## Prerequisites (operator)

1. **A reachable OpenShell gateway URL** (`gatewayEndpoint`, `http(s)://host:port`). The default local gateway requires **mTLS**, so set `clientCertPath` + `clientKeyPath` (and `caCertPath` unless the gateway uses system-trusted TLS). Alternatively/additionally an `oidcToken`; for long-running automation prefer an OIDC client-credentials provider configured at the gateway.
2. **Compute driver.** For Firecracker microVMs, configure openshell-firecracker as OpenShell's compute driver (see `../openshell-migration.md`). Any OpenShell driver works — de-risk with Docker/Podman first.
3. **A sandbox image** (`image`) that meets the Paperclip sandbox contract (`SANDBOX-REQUIREMENTS.md`): `node`, `sh`, `tar` and the agent CLIs on PATH, plus writable workspace/home/cache/tmp. `onEnvironmentProbe` checks sh/tar/node.
4. **Egress policy.** OpenShell is default-deny, so the sandbox must be allowed to reach the **Paperclip HTTP bridge** (via `host.openshell.internal:<bridge-port>` — the Firecracker guest has no NIC and loopback is a forbidden destination) and each **agent model endpoint**. Provide it as a create-time `policyRef` (a JSON policy document), or configure a gateway/workspace policy.
5. **Model-credential providers** (`providers`): OpenShell providers for the model keys (`anthropic`/`openai`/…), attached at create; the proxy injects them so the key never sits in the sandbox.

## Build

```bash
cd paperclip-plugin-openshell
# Both deps come from non-public registries:
#  - @nvidia/openshell-sdk  → GitHub Packages. Add to .npmrc:
#      @nvidia:registry=https://npm.pkg.github.com
#      //npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
#  - @paperclipai/plugin-sdk → from the Paperclip monorepo (link/file: if not published),
#      version-matched to the Paperclip server you run.
npm install
npm run build        # tsc → dist/ (dist/worker.js is the manifest entrypoint)
```

## Load it into Paperclip

**Local / self-hosted:** put the built package where Paperclip's loader discovers it (`~/.paperclip/plugins`):

```bash
mkdir -p ~/.paperclip/plugins
ln -s "$PWD" ~/.paperclip/plugins/paperclip-plugin-openshell   # or copy (include dist/)
```

Restart the Paperclip server; it validates the manifest (the `environment.drivers.register` capability gates sandbox passthrough) and activates the out-of-process worker.

**Via npm:** publish as `paperclip-plugin-openshell` (the prefix Paperclip's installer expects) and install through its plugin-install flow.

## Configure an environment

**Company Settings → Environments → new**, `driver: sandbox`, provider **NVIDIA OpenShell Sandbox** (`paperclip.openshell-sandbox-provider:openshell`), config:

| Field | Required | Meaning |
|---|---|---|
| `image` | yes | sandbox image (`SandboxSpec.image`) |
| `gatewayEndpoint` | yes | gateway URL `http(s)://host:port` |
| `workspace` | no | OpenShell workspace (default `default`) |
| `clientCertPath` / `clientKeyPath` | usually | PEM client cert+key for gateway mTLS |
| `caCertPath` | no | PEM CA for gateway TLS (else system roots) |
| `oidcToken` | no | static bearer token |
| `insecureSkipVerify` / `allowInsecureAuth` | no | dev-only TLS/auth relaxations |
| `policyRef` | strongly advised | path to a JSON SandboxPolicy allowing the Paperclip bridge + model endpoints |
| `providers` | advised | OpenShell provider names (model credentials) to attach |
| `reuseLease` | no | stop-and-retain vs delete on release (default delete) |
| `remoteCwd` | no | working dir in the sandbox (default `/paperclip-workspace`) |
| `cpu` / `memory` | no | resource requests (via the SDK proto escape hatch) |
| `timeoutMs` | no | default per-command timeout (default 1h) |
| `noLoginShell` | no | profile-free exec startup |

Run the environment's probe first to confirm the image is viable, then run an agent.

## How hooks map to the SDK

All gateway calls live in `src/openshell.ts`.

| Hook | `@nvidia/openshell-sdk` call |
|---|---|
| acquire lease | `client.sandbox.create({ image, command:["tail","-f","/dev/null"], providers, policy, … })` → `.name` is the lease id |
| resume lease | `client.sandbox.get(name)` (+ `client.raw.startSandbox` if stopped); `null` lease if `not_found` |
| release lease | `reuseLease`/`stop_and_retain` ? `client.raw.stopSandbox` : `client.sandbox.delete(name,{allowMissing})` |
| stop / destroy | `client.raw.stopSandbox` / `client.sandbox.delete` |
| realize workspace | `client.exec(name, ["mkdir","-p",cwd])` |
| execute | `client.exec(name, [cmd,...args], { workdir, environment, timeoutSecs, stdin, noLoginShell })` → `{ exitCode, stdout, stderr }` |
| probe | create → `client.exec(name, ["sh","-c","…command -v sh tar node…"])` → delete |

## Limitations / caveats

- **SDK is pre-1.0.** Types here are intentionally loose at the SDK boundary and mirror the documented surface (`sdk/typescript/src/client.ts`). Reconcile with the published `@nvidia/openshell-sdk` on `npm install`, and upgrade gateway + SDK together.
- **Uncurated RPCs.** `stop`/`start` go through `client.raw.*`; confirm the `StopSandboxRequest`/`StartSandboxRequest` field names (`name`/`workspace`) against the generated proto types.
- **CPU/memory + policy.** `cpu`/`memory` are set via the create escape hatch (`resourceRequirements`); `policyRef` is read as a JSON SandboxPolicy. Confirm both shapes against the SDK/proto.
- **Exit vs transport.** A non-zero command exit is returned (`exitCode`), not thrown; transport/RPC errors throw and propagate (the sandbox-gone case is handled by resume/get `not_found`).
- **No file upload/download in the SDK** — workspace sync uses Paperclip's command fallback (host-driven `tar` over `exec`).
- **Lease expiry.** v1 sets no provider-side deadline; a run that sets `requestedExpiresAt` and gets no `expiresAt` back is failed closed by the server (safe).
- **openshell-firecracker is unproven** and needs an upstream launcher hook; see `../openshell-migration.md`.

## Files

- `src/manifest.ts` — manifest + `configSchema`.
- `src/openshell.ts` — the `@nvidia/openshell-sdk` adapter (every gateway call; connection cached).
- `src/plugin.ts` — `definePlugin` hooks.
- `src/worker.ts` — out-of-process worker entrypoint (`runWorker`).
