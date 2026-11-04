// OpenShell backend: talks to the gateway over gRPC via `@nvidia/openshell-sdk`
// (connect-es / HTTP-2) on a persistent, lazily-created connection. The plugin
// hooks only call the functions exported here.
//
// The SDK interaction is typed loosely (`any` at the boundary) against the
// SDK's documented surface (sdk/typescript/src/client.ts on NVIDIA/OpenShell):
//   OpenShellClient.connect(opts)
//   client.sandbox.create(spec) -> { id, name, workspace, phase, ... }
//   client.sandbox.get(name, { workspace })
//   client.sandbox.delete(name, { workspace, allowMissing })
//   client.exec(name, argv, { workdir, environment, timeoutSecs, stdin, noLoginShell, signal })
//        -> { exitCode, stdout: Buffer, stderr: Buffer }
//   client.raw.stopSandbox(req) / client.raw.startSandbox(req)
// Transport failures are thrown (duck-typed `.code`); a non-zero command exit is
// NOT a throw — it comes back as `exitCode`. Reconcile the loose types / the raw
// request field names with the published `@nvidia/openshell-sdk` when you build.

import { readFileSync } from "node:fs";
import { OpenShellClient } from "@nvidia/openshell-sdk";

export interface OpenshellConfig {
  image: string;
  workspace: string | null;
  policyRef: string | null; // path to a JSON policy document for spec.policy
  providers: string[];
  reuseLease: boolean;
  remoteCwd: string;
  cpu: string | null;
  memory: string | null;
  timeoutMs: number;
  noLoginShell: boolean;
  // Gateway gRPC connection
  gatewayEndpoint: string | null; // required: gateway URL (http(s)://…)
  caCertPath: string | null;
  clientCertPath: string | null;
  clientKeyPath: string | null;
  oidcToken: string | null;
  insecureSkipVerify: boolean;
  allowInsecureAuth: boolean;
}

export interface ExecRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxObservation {
  phase: string;
  raw: Record<string, unknown>;
}

// One lazy connection, reused across calls; rebuilt if the connection config
// changes. The SDK connection is lazy itself (no I/O until the first RPC).
let cached: { key: string; client: Promise<any> } | null = null;

function connectOptions(config: OpenshellConfig): Record<string, unknown> {
  if (!config.gatewayEndpoint) {
    throw new Error("openshell: `gatewayEndpoint` (gateway URL) is required.");
  }
  const opts: Record<string, unknown> = { gateway: config.gatewayEndpoint };
  // These carry PEM *contents* (not filesystem paths): Paperclip resolves a
  // `secret-ref` field to the secret's value and substitutes it inline, and a
  // plain field holds its literal value. The SDK wants PEM bytes, so wrap the
  // string in a Buffer — mirroring how `oidcToken` is used as a value below.
  if (config.caCertPath) opts.caCert = Buffer.from(config.caCertPath);
  if (config.clientCertPath) opts.clientCert = Buffer.from(config.clientCertPath);
  if (config.clientKeyPath) opts.clientKey = Buffer.from(config.clientKeyPath);
  if (config.oidcToken) opts.oidcToken = config.oidcToken;
  if (config.insecureSkipVerify) opts.insecureSkipVerify = true;
  if (config.allowInsecureAuth) opts.allowInsecureAuth = true;
  return opts;
}

async function client(config: OpenshellConfig): Promise<any> {
  const opts = connectOptions(config);
  const key = JSON.stringify([
    config.gatewayEndpoint,
    config.clientCertPath,
    config.clientKeyPath,
    config.caCertPath,
    config.oidcToken ? "token" : "",
    config.insecureSkipVerify,
    config.allowInsecureAuth,
  ]);
  if (!cached || cached.key !== key) {
    cached = { key, client: (OpenShellClient as any).connect(opts) };
  }
  return cached.client;
}

function wsOpts(config: OpenshellConfig): Record<string, unknown> {
  return config.workspace ? { workspace: config.workspace } : {};
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

export async function createSandbox(
  config: OpenshellConfig,
  opts: { name?: string; labels?: Record<string, string> } = {},
): Promise<{ name: string; raw: Record<string, unknown> }> {
  const c = await client(config);
  const spec: Record<string, unknown> = {
    image: config.image,
    // Long-lived idle main process so the sandbox stays up for exec. Blocks
    // forever on both coreutils and busybox.
    command: ["tail", "-f", "/dev/null"],
    restartPolicy: "never",
  };
  if (config.workspace) spec.workspace = config.workspace;
  if (config.providers.length > 0) spec.providers = config.providers;
  if (opts.name) spec.name = opts.name;
  if (opts.labels) spec.labels = opts.labels;
  if (config.cpu || config.memory) {
    // CPU/memory are not curated create fields; set them via the proto escape
    // hatch. Confirm `resourceRequirements` shape against the SDK proto.
    const rr: Record<string, string> = {};
    if (config.cpu) rr.cpu = config.cpu;
    if (config.memory) rr.memory = config.memory;
    spec.rawSpec = { resourceRequirements: rr };
  }
  if (config.policyRef) {
    spec.policy = JSON.parse(readFileSync(config.policyRef, "utf8"));
  }

  const ref = await c.sandbox.create(spec);
  const name = typeof ref?.name === "string" ? ref.name : null;
  if (!name) throw new Error(`openshell create returned no name: ${JSON.stringify(ref).slice(0, 500)}`);
  return { name, raw: ref as Record<string, unknown> };
}

export async function execInSandbox(
  config: OpenshellConfig,
  name: string,
  req: ExecRequest,
): Promise<ExecResult> {
  const c = await client(config);
  const argv = [req.command, ...req.args];
  const options: Record<string, unknown> = { ...wsOpts(config) };
  const cwd = req.cwd ?? config.remoteCwd;
  if (cwd) options.workdir = cwd;
  if (req.env) options.environment = req.env;
  const timeoutMs = req.timeoutMs ?? config.timeoutMs;
  if (timeoutMs && timeoutMs > 0) options.timeoutSecs = Math.ceil(timeoutMs / 1000);
  if (config.noLoginShell) options.noLoginShell = true;
  if (req.stdin != null) options.stdin = Buffer.from(req.stdin, "utf8");

  try {
    const res = await c.exec(name, argv, options);
    return {
      exitCode: typeof res?.exitCode === "number" ? res.exitCode : null,
      stdout: res?.stdout != null ? Buffer.from(res.stdout).toString("utf8") : "",
      stderr: res?.stderr != null ? Buffer.from(res.stderr).toString("utf8") : "",
      timedOut: false,
    };
  } catch (err) {
    const code = errCode(err);
    if (code === "aborted" || code === "canceled") {
      return { exitCode: null, stdout: "", stderr: String((err as Error)?.message ?? err), timedOut: true };
    }
    throw err; // transport/rpc/not_found: a real error, not a command exit
  }
}

export async function getSandbox(
  config: OpenshellConfig,
  name: string,
): Promise<SandboxObservation | null> {
  const c = await client(config);
  try {
    const ref = await c.sandbox.get(name, wsOpts(config));
    return { phase: String(ref?.phase ?? "unknown"), raw: ref as Record<string, unknown> };
  } catch (err) {
    if (errCode(err) === "not_found") return null;
    throw err;
  }
}

export async function startSandbox(config: OpenshellConfig, name: string): Promise<void> {
  const c = await client(config);
  // start/stop are not curated; use the raw wire client. Confirm the request
  // field names (name/workspace) against the generated StartSandboxRequest.
  await c.raw.startSandbox({ name, ...wsOpts(config) });
}

export async function stopSandbox(config: OpenshellConfig, name: string): Promise<void> {
  const c = await client(config);
  await c.raw.stopSandbox({ name, ...wsOpts(config) });
}

export async function deleteSandbox(config: OpenshellConfig, name: string): Promise<void> {
  const c = await client(config);
  await c.sandbox.delete(name, { ...wsOpts(config), allowMissing: true });
}
