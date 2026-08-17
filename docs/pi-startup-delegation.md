# Pi startup delegation required by `pi --cloud`

## Problem

Pi Cloud is installed as an ordinary Pi extension on a Mac. The extension can register `--cloud`, but Pi 0.84.x cannot let that extension own startup before a local agent session is created.

The current startup trace is:

```text
main
→ create local SessionManager
→ createAgentSessionServices
  → create ModelRuntime
  → load extension factories
  → bind values for extension-defined flags
→ createAgentSessionFromServices
→ create AgentSessionRuntime
→ start InteractiveMode
```

An extension factory cannot inspect `pi.getFlag("cloud")` because unknown CLI flag values are bound only after factories finish. A `session_start` handler can inspect the flag, but by then Pi has created the local session runtime. Launching another TUI from either point risks two terminal owners and local session side effects.

Pi Cloud therefore must not use `process.exit()`, a PATH wrapper, a copied `InteractiveMode`, or a throwaway local session as a takeover mechanism.

## Smallest generic upstream seam

Pi should allow an extension to register a startup handler during its normal factory call. After extension flag values are bound, but before `createAgentSessionFromServices`, the CLI asks registered handlers whether one owns the invocation.

A transport-neutral API could have this shape:

```ts
pi.registerStartupHandler({
  name: "cloud",
  when: () => pi.getFlag("cloud") === true,
  async run(context) {
    await runCloudTerminal(context);
    return { handled: true };
  },
});
```

The exact name is an upstream decision. The required contract is:

- registration is available to ordinary installed extensions;
- `when` runs after extension CLI flags have their parsed values;
- `run` runs before an `AgentSession` or `AgentSessionRuntime` is created;
- a handled invocation does not emit `session_start` for a local session or start `InteractiveMode`;
- the context exposes normalized cwd, core CLI intent such as print/continue/resume, initial prompt input, an abort signal, and terminal streams;
- startup diagnostics and extension-load failures are reported before delegation;
- at most one handler may own an invocation; multiple matches are an actionable error;
- plain Pi behavior is unchanged when no handler matches;
- help can include extension flags without running a handler; and
- shutdown awaits the handler and restores signal handling without forcing `process.exit()`.

The seam must not know about Pi Cloud, HTTP, WebSockets, hosted sessions, or authentication.

## Pi Cloud behavior before the seam exists

`packages/cloud/index.ts` registers the intended flags. On current Pi versions, `pi --cloud` fails closed with a precise startup-delegation error and requests graceful shutdown. This guard prevents a cloud prompt from accidentally running against the local repository, but it is not the finished startup path and does not satisfy the MVP gate.

The curl installer must eventually enforce the minimum Pi version containing the upstream seam before installing `@pi-cloud/extension`.
