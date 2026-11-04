import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  createSandbox,
  deleteSandbox,
  execInSandbox,
  getSandbox,
  startSandbox,
  stopSandbox,
  type OpenshellConfig,
} from "./openshell.js";

function str(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function strList(raw: Record<string, unknown>, key: string): string[] {
  const v = raw[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseConfig(raw: Record<string, unknown>): OpenshellConfig {
  const timeoutMs = Number(raw.timeoutMs ?? 3_600_000);
  return {
    image: str(raw, "image") ?? "",
    workspace: str(raw, "workspace"),
    policyRef: str(raw, "policyRef"),
    providers: strList(raw, "providers"),
    reuseLease: raw.reuseLease === true,
    remoteCwd: str(raw, "remoteCwd") ?? "/paperclip-workspace",
    cpu: str(raw, "cpu"),
    memory: str(raw, "memory"),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 3_600_000,
    noLoginShell: raw.noLoginShell === true,
    gatewayEndpoint: str(raw, "gatewayEndpoint"),
    caCertPath: str(raw, "caCertPath"),
    clientCertPath: str(raw, "clientCertPath"),
    clientKeyPath: str(raw, "clientKeyPath"),
    oidcToken: str(raw, "oidcToken"),
    insecureSkipVerify: raw.insecureSkipVerify === true,
    allowInsecureAuth: raw.allowInsecureAuth === true,
  };
}

function leaseMetadata(config: OpenshellConfig, name: string, resumed: boolean) {
  return {
    provider: "openshell",
    sandboxName: name,
    image: config.image,
    remoteCwd: config.remoteCwd,
    reuseLease: config.reuseLease,
    resumedLease: resumed,
  };
}

function resolveRemoteCwd(
  config: OpenshellConfig,
  lease: PluginEnvironmentLease,
  workspace?: { remotePath?: string; localPath?: string },
): string {
  const fromMeta = lease.metadata?.remoteCwd;
  if (typeof fromMeta === "string" && fromMeta.trim().length > 0) return fromMeta.trim();
  return workspace?.remotePath ?? config.remoteCwd;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("OpenShell sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "OpenShell sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseConfig(params.config);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.image) {
      errors.push("`image` is required (OCI image ref or rootfs tar).");
    }
    if (!config.gatewayEndpoint) {
      errors.push("`gatewayEndpoint` (gateway URL) is required to reach the OpenShell gateway.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("`timeoutMs` must be between 1 and 86400000.");
    }
    if (
      config.gatewayEndpoint &&
      !config.gatewayEndpoint.startsWith("http://") &&
      !config.gatewayEndpoint.startsWith("https://")
    ) {
      errors.push("`gatewayEndpoint` must be an http:// or https:// URL.");
    }
    if (!config.policyRef) {
      warnings.push(
        "No `policyRef`: OpenShell is default-deny, so the agent may be unable to reach the Paperclip bridge or its model endpoint unless the sandbox's base policy already allows them.",
      );
    }
    if (config.providers.length === 0) {
      warnings.push(
        "No `providers`: no model credential will be injected. Ensure the image/policy supplies the agent's credentials another way.",
      );
    }

    if (errors.length > 0) return { ok: false, errors, warnings };
    return { ok: true, warnings, normalizedConfig: { ...params.config } };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseConfig(params.config);
    let name: string | null = null;
    try {
      const created = await createSandbox(config);
      name = created.name;
      const check = await execInSandbox(config, name, {
        command: "sh",
        args: ["-c", "for c in sh tar node; do command -v \"$c\" >/dev/null || echo \"missing:$c\"; done"],
        timeoutMs: 60_000,
      });
      const missing = check.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("missing:"))
        .map((l) => l.slice("missing:".length));
      if (missing.length > 0) {
        return {
          ok: false,
          summary: `OpenShell sandbox is missing required tools on PATH: ${missing.join(", ")}.`,
          metadata: { provider: "openshell", image: config.image, missing },
        };
      }
      return {
        ok: true,
        summary: `Created an OpenShell sandbox from ${config.image}; sh/tar/node present.`,
        metadata: { provider: "openshell", image: config.image, sandboxName: name },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `OpenShell sandbox probe failed for image ${config.image}.`,
        metadata: {
          provider: "openshell",
          image: config.image,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      if (name) await deleteSandbox(config, name).catch(() => undefined);
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const { name } = await createSandbox(config, {
      labels: { "paperclip.run": params.runId, "paperclip.environment": params.environmentId },
    });
    // v1 cannot bound the sandbox to a provider-side deadline via a known CLI
    // flag. Per the protocol, a caller that sets `requestedExpiresAt` and gets
    // no `expiresAt` back is failed closed and released — correct (safe) for
    // those special, deadline-bearing sessions. Ordinary runs omit it and keep
    // the default lifetime.
    return {
      providerLeaseId: name,
      metadata: leaseMetadata(config, name, false),
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const observed = await getSandbox(config, params.providerLeaseId);
    if (!observed) {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    const phase = observed.phase.toLowerCase();
    if (phase.includes("stop")) {
      await startSandbox(config, params.providerLeaseId);
    }
    return {
      providerLeaseId: params.providerLeaseId,
      metadata: leaseMetadata(config, params.providerLeaseId, true),
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = parseConfig(params.config);
    const retain = params.resourceDisposition === "stop_and_retain" || config.reuseLease;
    if (retain) {
      await stopSandbox(config, params.providerLeaseId);
      return { providerLeaseId: params.providerLeaseId, state: "stopped" };
    }
    await deleteSandbox(config, params.providerLeaseId);
    return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
  },

  async onEnvironmentStopLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt> {
    const config = parseConfig(params.config);
    if (!params.providerLeaseId) {
      throw new Error("onEnvironmentStopLease requires a providerLeaseId");
    }
    await stopSandbox(config, params.providerLeaseId);
    return { providerLeaseId: params.providerLeaseId, state: "stopped" };
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = parseConfig(params.config);
    await deleteSandbox(config, params.providerLeaseId);
    return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseConfig(params.config);
    const remoteCwd = resolveRemoteCwd(config, params.lease, params.workspace);
    if (params.lease.providerLeaseId) {
      await execInSandbox(config, params.lease.providerLeaseId, {
        command: "mkdir",
        args: ["-p", remoteCwd],
        timeoutMs: 60_000,
      });
    }
    return { cwd: remoteCwd, metadata: { provider: "openshell", remoteCwd } };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "No provider lease ID for execution." };
    }
    const config = parseConfig(params.config);
    const result = await execInSandbox(config, params.lease.providerLeaseId, {
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdin: params.stdin,
      timeoutMs: params.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
});

export default plugin;
