#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write("fake pi fixture\n");
  process.exit(0);
}
if (process.env.PI_CLOUD_FIXTURE_ARGV) {
  appendFileSync(process.env.PI_CLOUD_FIXTURE_ARGV, JSON.stringify(argv) + "\n");
}
const sessionArgument = argumentValue(argv, "--session");
const sessionDirectory = argumentValue(argv, "--session-dir") ?? "/sessions";
const sessionFile = sessionArgument ?? join(sessionDirectory, "native.jsonl");
const entriesFile = `${sessionFile}.fixture-entries.json`;
mkdirSync(dirname(sessionFile), { recursive: true });
try {
  appendFileSync(sessionFile, "");
} catch {
  writeFileSync(sessionFile, "");
}
if (process.env.PI_CLOUD_FIXTURE_MODE === "malformed") process.stdout.write("not-json\n");
if (process.env.PI_CLOUD_FIXTURE_MODE === "ignore-term") process.on("SIGTERM", () => undefined);

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const newline = pending.indexOf(0x0a);
    if (newline < 0) break;
    const command = JSON.parse(pending.subarray(0, newline).toString("utf8"));
    pending = pending.subarray(newline + 1);
    if (command.type === "get_state") {
      emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionFile,
          sessionId: "native-1",
          credentialPresent: process.env.ANTHROPIC_API_KEY === "scoped-secret",
          homeDirectory: process.env.HOME,
        },
      });
    } else if (command.type === "prompt") {
      if (process.env.PI_CLOUD_FIXTURE_MODE === "exit-on-prompt") process.exit(7);
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      const text = command.message === "inspect-environment"
        ? String(process.env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN ?? "not-inherited")
        : command.message === "inspect-provider"
          ? process.env.ANTHROPIC_API_KEY ? "provider-present" : "provider-absent"
          : String(command.message).includes("SMOKE_OK") ? "SMOKE_OK" : "fixture response";
      writeFileSync(entriesFile, JSON.stringify([
        { type: "message", id: "user-1", message: { role: "user", content: [{ type: "text", text: command.message }] } },
        { type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [{ type: "text", text }] } },
      ]));
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
      emit({ type: "agent_settled" });
    } else if (command.type === "get_entries") {
      emit({
        id: command.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: { entries: readEntries(), leafId: "assistant-1" },
      });
    }
  }
});

if (process.env.PI_CLOUD_FIXTURE_MODE !== "ignore-term") process.on("SIGTERM", () => process.exit(0));

function emit(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function argumentValue(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function readEntries() {
  try {
    return JSON.parse(readFileSync(entriesFile, "utf8"));
  } catch {
    return [];
  }
}
