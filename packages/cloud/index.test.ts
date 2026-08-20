import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cloud, {
  CLOUD_DETACH_FLAG,
  CLOUD_FLAG,
  guardCloudStartup,
  STARTUP_DELEGATION_REQUIRED,
} from "./index.js";

type SessionStartHandler = (event: never, context: never) => void;

function loadExtension(cloudEnabled: boolean) {
  const flags = new Map<string, { type: string; default?: boolean }>();
  let sessionStart: SessionStartHandler | undefined;
  const api = {
    registerFlag(name: string, options: { type: string; default?: boolean }) {
      flags.set(name, options);
    },
    getFlag(name: string) {
      return name === CLOUD_FLAG ? cloudEnabled : false;
    },
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStart = handler;
    },
  } as unknown as ExtensionAPI;

  cloud(api);
  return { flags, sessionStart };
}

test("cloud remains a small Pi extension that registers only its client flags", () => {
  const { flags } = loadExtension(false);

  assert.deepEqual([...flags.keys()], [CLOUD_FLAG, CLOUD_DETACH_FLAG]);
  assert.equal(flags.get(CLOUD_FLAG)?.type, "boolean");
  assert.equal(flags.get(CLOUD_FLAG)?.default, false);
  assert.equal(flags.get(CLOUD_DETACH_FLAG)?.type, "boolean");
  assert.equal(flags.get(CLOUD_DETACH_FLAG)?.default, false);
});

test("unsupported Pi versions fail closed instead of running a local prompt", () => {
  const { sessionStart } = loadExtension(true);
  const notifications: Array<{ message: string; level: string }> = [];
  let shutdown = false;

  assert.ok(sessionStart);
  sessionStart({} as never, {
    mode: "tui",
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    shutdown() {
      shutdown = true;
    },
  } as never);

  assert.deepEqual(notifications, [{ message: STARTUP_DELEGATION_REQUIRED, level: "error" }]);
  assert.equal(shutdown, true);
});

test("print, JSON, and RPC sessions hard-fail instead of running a local prompt", () => {
  for (const mode of ["print", "json", "rpc"]) {
    const notifications: string[] = [];
    let shutdown = false;
    assert.throws(
      () =>
        guardCloudStartup({
          mode,
          notify(message) {
            notifications.push(message);
          },
          shutdown() {
            shutdown = true;
          },
          hardFail() {
            throw new Error("hard fail");
          },
        }),
      /hard fail/,
    );
    assert.equal(shutdown, false);
    assert.deepEqual(notifications, [STARTUP_DELEGATION_REQUIRED]);
  }
});

test("interactive sessions fail closed with a graceful shutdown request", () => {
  const notifications: string[] = [];
  let shutdown = false;
  guardCloudStartup({
    mode: "tui",
    notify(message) {
      notifications.push(message);
    },
    shutdown() {
      shutdown = true;
    },
    hardFail() {
      throw new Error("unexpected hard fail");
    },
  });

  assert.equal(shutdown, true);
  assert.deepEqual(notifications, [STARTUP_DELEGATION_REQUIRED]);
});
