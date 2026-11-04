import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.openshell-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "OpenShell Sandbox Provider",
  description:
    "Provisions NVIDIA OpenShell sandboxes as Paperclip execution environments, over the OpenShell gateway gRPC API (@nvidia/openshell-sdk). With openshell-firecracker configured as OpenShell's compute driver, each sandbox is a Firecracker microVM.",
  author: "community",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "openshell",
      kind: "sandbox_provider",
      displayName: "NVIDIA OpenShell Sandbox",
      description:
        "Runs each Paperclip agent in an OpenShell sandbox via the gateway gRPC API. Egress policy, TLS inspection and credential injection are enforced by the gateway; the compute backend (e.g. Firecracker via openshell-firecracker) is chosen operator-side.",
      configSchema: {
        type: "object",
        required: ["image", "gatewayEndpoint"],
        properties: {
          image: {
            type: "string",
            description:
              "OCI image ref or rootfs tar for the sandbox (SandboxSpec.image). Must satisfy OpenShell/Paperclip sandbox requirements: node, sh, tar and the agent CLIs on PATH, and writable workspace/home/cache/tmp.",
          },
          gatewayEndpoint: {
            type: "string",
            description:
              "OpenShell gateway URL, http(s)://host:port. Required. The default local gateway requires mTLS — set clientCert/clientKey.",
          },
          workspace: {
            type: "string",
            description: "OpenShell workspace for the sandboxes. Defaults to `default`.",
          },
          caCertPath: {
            type: "string",
            description:
              "PEM contents of the CA bundle for the gateway TLS (public material; paste inline). Omit to use system roots.",
          },
          clientCertPath: {
            type: "string",
            description:
              "PEM contents of the client certificate for mTLS auth to the gateway (public material; paste inline).",
          },
          clientKeyPath: {
            type: "string",
            format: "secret-ref",
            description:
              "PEM contents of the client private key for mTLS auth to the gateway. Sensitive — bind to a secret.",
          },
          oidcToken: {
            type: "string",
            format: "secret-ref",
            description:
              "Static OIDC bearer token for the gateway (alternative/addition to mTLS). For long-running use prefer an OIDC client-credentials provider configured at the gateway.",
          },
          insecureSkipVerify: {
            type: "boolean",
            description: "Skip gateway TLS verification (dev only).",
            default: false,
          },
          allowInsecureAuth: {
            type: "boolean",
            description: "Allow sending the token over plaintext http to a non-loopback host (dev only).",
            default: false,
          },
          policyRef: {
            type: "string",
            description:
              "Path to a JSON policy document applied as the sandbox's create-time SandboxPolicy. OpenShell is default-deny, so this (or a gateway/workspace policy) MUST allow the Paperclip HTTP bridge (via host.openshell.internal:<port>) and each agent's model endpoint.",
          },
          providers: {
            type: "array",
            items: { type: "string" },
            description:
              "OpenShell provider names to attach at create. The proxy injects these credentials (e.g. the model key); the key never sits in the sandbox.",
            default: [],
          },
          reuseLease: {
            type: "boolean",
            description: "On lease release, stop-and-retain (reuse) instead of delete. Explicit destroy still deletes.",
            default: false,
          },
          remoteCwd: {
            type: "string",
            description: "Working directory realized inside the sandbox.",
            default: "/paperclip-workspace",
          },
          cpu: {
            type: "string",
            description: "CPU request, e.g. `2` or `500m` (set via the SDK proto escape hatch). Optional.",
          },
          memory: {
            type: "string",
            description: "Memory request, e.g. `4Gi`. Optional.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Default per-command timeout in milliseconds (converted to the SDK's timeoutSecs). The host may override per command. Defaults to 1 hour.",
            default: 3600000,
          },
          noLoginShell: {
            type: "boolean",
            description:
              "Pass noLoginShell to exec for predictable, profile-free startup. Leave false when the image sets PATH via login profiles.",
            default: false,
          },
        },
      },
    },
  ],
};

export default manifest;
