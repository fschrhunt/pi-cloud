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
    guardCloudStartup({
      mode: ctx.mode,
      notify: (message, level) => ctx.ui.notify(message, level),
      shutdown: () => ctx.shutdown(),
      hardFail: hardFailCloudStartup,
    });
  });
}

type CloudStartupGuard = {
  mode: string;
  notify: (message: string, level: "error") => void;
  shutdown: () => void;
  hardFail: () => never;
};

/**
 * Refuses to run a local session when --cloud is set. Interactive mode shuts down immediately
 * because the session is idle at startup. Print and JSON modes bind no shutdown handler at all,
 * and RPC mode defers shutdown until after the next command, so those modes would execute the
 * cloud-intended prompt against the local repository; they hard-fail instead.
 */
export function guardCloudStartup(guard: CloudStartupGuard): void {
  guard.notify(STARTUP_DELEGATION_REQUIRED, "error");
  if (guard.mode === "tui") {
    guard.shutdown();
    return;
  }
  guard.hardFail();
}

/** Terminates Pi with a non-zero exit because no supported fail-closed path exists outside interactive mode. */
export function hardFailCloudStartup(): never {
  process.stderr.write(`${STARTUP_DELEGATION_REQUIRED}\n`);
  process.exit(1);
}
