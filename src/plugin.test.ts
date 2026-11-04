import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./openshell.js", () => ({
  createSandbox: vi.fn(),
  deleteSandbox: vi.fn(),
  execInSandbox: vi.fn(),
  getSandbox: vi.fn(),
  startSandbox: vi.fn(),
  stopSandbox: vi.fn(),
}));

import * as os from "./openshell.js";
import plugin from "./plugin.js";

const hooks = plugin.definition as any;
const config = { image: "img:1", gatewayEndpoint: "https://gw:1" };
const base = { driverKey: "openshell", companyId: "c", environmentId: "e", config };
const m = vi.mocked(os, true);

beforeEach(() => {
  vi.resetAllMocks();
  m.deleteSandbox.mockResolvedValue(undefined);
  m.stopSandbox.mockResolvedValue(undefined);
  m.startSandbox.mockResolvedValue(undefined);
});

describe("onEnvironmentValidateConfig", () => {
  it("accepts a minimal config and warns about policy and providers", async () => {
    const r = await hooks.onEnvironmentValidateConfig({ ...base });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(2);
  });

  it("requires image and gatewayEndpoint", async () => {
    const r = await hooks.onEnvironmentValidateConfig({ ...base, config: {} });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
  });

  it("rejects a non-http gateway URL and a bad timeout", async () => {
    const r = await hooks.onEnvironmentValidateConfig({
      ...base,
      config: { ...config, gatewayEndpoint: "gw:1", timeoutMs: 99_999_999_999 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/http/);
  });
});

describe("onEnvironmentProbe", () => {
  it("reports missing tools and always deletes the sandbox", async () => {
    m.createSandbox.mockResolvedValue({ name: "sb", raw: {} });
    m.execInSandbox.mockResolvedValue({ exitCode: 0, stdout: "missing:node\n", stderr: "", timedOut: false });
    const r = await hooks.onEnvironmentProbe({ ...base });
    expect(r.ok).toBe(false);
    expect(r.metadata.missing).toEqual(["node"]);
    expect(m.deleteSandbox).toHaveBeenCalledWith(expect.anything(), "sb");
  });

  it("returns ok:false (not a throw) when create fails", async () => {
    m.createSandbox.mockRejectedValue(new Error("boom"));
    const r = await hooks.onEnvironmentProbe({ ...base });
    expect(r.ok).toBe(false);
    expect(r.metadata.error).toBe("boom");
    expect(m.deleteSandbox).not.toHaveBeenCalled();
  });
});

describe("leases", () => {
  it("acquire returns the sandbox name as the lease id", async () => {
    m.createSandbox.mockResolvedValue({ name: "sb-1", raw: {} });
    const lease = await hooks.onEnvironmentAcquireLease({ ...base, runId: "r" });
    expect(lease.providerLeaseId).toBe("sb-1");
  });

  it("resume returns a null lease when the sandbox is gone", async () => {
    m.getSandbox.mockResolvedValue(null);
    const lease = await hooks.onEnvironmentResumeLease({ ...base, providerLeaseId: "sb" });
    expect(lease.providerLeaseId).toBeNull();
  });

  it("resume starts a stopped sandbox", async () => {
    m.getSandbox.mockResolvedValue({ phase: "Stopped", raw: {} });
    await hooks.onEnvironmentResumeLease({ ...base, providerLeaseId: "sb" });
    expect(m.startSandbox).toHaveBeenCalled();
  });

  it("release deletes by default and stops when retaining", async () => {
    const del = await hooks.onEnvironmentReleaseLease({ ...base, providerLeaseId: "sb" });
    expect(del.state).toBe("destroyed");
    const keep = await hooks.onEnvironmentReleaseLease({
      ...base,
      providerLeaseId: "sb",
      resourceDisposition: "stop_and_retain",
    });
    expect(keep.state).toBe("stopped");
    expect(m.stopSandbox).toHaveBeenCalledTimes(1);
  });

  it("release honours reuseLease from config", async () => {
    const r = await hooks.onEnvironmentReleaseLease({
      ...base,
      config: { ...config, reuseLease: true },
      providerLeaseId: "sb",
    });
    expect(r.state).toBe("stopped");
  });
});

describe("onEnvironmentExecute", () => {
  it("fails cleanly without a lease id", async () => {
    const r = await hooks.onEnvironmentExecute({ ...base, lease: { providerLeaseId: null }, command: "ls" });
    expect(r.exitCode).toBe(1);
    expect(m.execInSandbox).not.toHaveBeenCalled();
  });

  it("passes command, args, cwd, env and stdin through and maps the result", async () => {
    m.execInSandbox.mockResolvedValue({ exitCode: 3, stdout: "o", stderr: "e", timedOut: false });
    const r = await hooks.onEnvironmentExecute({
      ...base,
      lease: { providerLeaseId: "sb" },
      command: "sh",
      args: ["-c", "x"],
      cwd: "/w",
      env: { A: "1" },
      stdin: "in",
      timeoutMs: 5,
    });
    expect(m.execInSandbox).toHaveBeenCalledWith(expect.anything(), "sb", {
      command: "sh", args: ["-c", "x"], cwd: "/w", env: { A: "1" }, stdin: "in", timeoutMs: 5,
    });
    expect(r).toEqual({ exitCode: 3, timedOut: false, stdout: "o", stderr: "e" });
  });
});
