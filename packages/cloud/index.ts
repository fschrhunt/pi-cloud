import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLOUD_FLAG = "cloud";
export const CLOUD_DETACH_FLAG = "detach";
export const STARTUP_DELEGATION_REQUIRED =
  "pi --cloud requires Pi's pre-runtime extension startup delegation API; this Pi version cannot start cloud mode safely";

/** Registers the client-only cloud mode without changing normal local Pi behavior. */
export default function cloud(pi: ExtensionAPI): void {
  pi.registerFlag(CLOUD_FLAG, {
    description: "Run this Pi terminal against the configured Pi Cloud server",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(CLOUD_DETACH_FLAG, {
    description: "Submit the initial cloud prompt and disconnect after Pi accepts it",
    type: "boolean",
    default: false,
  });

  // Fail closed until upstream Pi can delegate before creating a local session runtime.
  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag(CLOUD_FLAG) !== true) return;
    ctx.ui.notify(STARTUP_DELEGATION_REQUIRED, "error");
    ctx.shutdown();
  });
}
