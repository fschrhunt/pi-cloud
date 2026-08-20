# Pi Cloud terminal MVP plan

## Product decision

Pi Cloud is **Pi running on another machine**, not a new coding agent and not a web application.

The MVP gives one operator an installable Linux server and a local terminal command that feels like Pi while the real, unmodified Pi process, repository, tools, credentials, and native session run durably on the server.

```text
local terminal                         operator-owned Linux server

pi --cloud ─ authenticated HTTPS/WSS ─> API ──> isolated workspace
 local TUI          Pi RPC records                    pi --mode rpc
                                                        repository
                                                        native Pi session
```

The client renders Pi. It does not run another agent, mirror the repository, interpret tool calls, or own conversation state. Pi remains authoritative for messages, tools, models, compaction, extensions, and native sessions.

## What “MVP” means

The MVP is complete when a new operator can:

1. install Pi Cloud on a clean supported Linux server from one versioned release;
2. configure one API identity, one model-provider credential, and optional Git credentials;
3. install the Pi Cloud extension into the existing local Pi;
4. run `pi --cloud` from a Git repository and receive a Pi-like interactive terminal session;
5. prompt, steer, follow up, abort, inspect tool output, and answer extension dialogs;
6. disconnect without terminating active work;
7. reconnect from another terminal and recover the authoritative transcript and live state;
8. stop and restart Pi Cloud, then resume the same repository and native Pi session;
9. make commits in the remote workspace and push them through ordinary Git; and
10. back up and restore the server, proving that the workspace and Pi session still resume.

This is a **single-operator, single-server release**. It is useful without a Pi Cloud account, browser, GitHub App, managed control plane, or proprietary agent behavior.

## Target experience

### Server

A versioned release contains the API image, runner image, Compose definition, and environment template. After the operator configures the public URL, generated service secrets, model credentials, and optional Git credentials, the server uses ordinary Compose commands:

```bash
docker compose up -d
docker compose ps
docker compose logs -f
```

The server never installs the Pi Cloud extension and never invokes `pi --cloud`. The runner image contains upstream Pi and invokes only `pi --mode rpc` for hosted sessions.

The first server release supports a clean, documented Linux target: Ubuntu 24.04 LTS or Debian 12 on x86-64, with Docker Engine and Compose v2. Supporting more server platforms is post-MVP unless it is free.

### Local terminal

The curl installer and `pi --cloud` run on the operator’s Mac mini, MacBook, or other supported client machine—not on the server. Apple Silicon macOS is the first required client platform.

```bash
curl -fsSL https://raw.githubusercontent.com/fschrhunt/pi-cloud/main/scripts/install.sh | sh

cd ~/src/project
pi --cloud                         # start a new remote Pi session
pi --cloud "fix the failing test"  # start with an initial prompt
pi --cloud -c                      # continue the latest session for this repository
pi --cloud -r                      # select a remote session for this repository
pi --cloud -p "review this commit" # stream one task until Pi settles, then exit
pi --cloud --detach "run tests"    # submit work and leave it running
```

The first `pi --cloud` invocation prompts for the server URL and bearer token if no connection is configured. There is no separate public client executable or login command.

The cloud startup path infers the canonical HTTPS `origin` and full local `HEAD`. It fails clearly when the directory is not a Git repository, the revision has not been pushed, or the server cannot fetch it. Explicit `--repo` and `--revision` flags exist for automation, not as the primary path.

Local credentials are stored in `~/.config/pi-cloud/config.json` with mode `0600`. Tokens never appear in command arguments, URLs, shell history, or logs.

## Pi terminal compatibility contract

The goal is the normal Pi interaction loop, not complete byte-for-byte parity in the first release.

### Required in MVP

- streaming assistant text and thinking;
- Pi tool start, update, and result rendering;
- multiline editor and prompt history;
- Enter to steer while Pi is active;
- Alt+Enter to queue a follow-up;
- Escape to abort;
- Ctrl+L and `/model` for server-side model selection;
- Shift+Tab for server-side thinking level;
- `/compact`, `/name`, and `/session`;
- `/new`, `/resume`, and `-c` mapped to hosted-session lifecycle;
- `!command` executed in the remote workspace through Pi RPC;
- extension, skill, and prompt-template command discovery;
- RPC extension dialogs: select, confirm, input, and editor;
- notifications, status, widgets, and terminal title where RPC supports them;
- reconnect rehydration from `get_state` and `get_entries` using native entry IDs as cursors;
- clear indication that the workspace and shell are remote.

### Allowed differences in MVP

- `--cloud` selects the remote runtime; plain `pi` remains exactly upstream Pi and keeps all local behavior.
- `/login` is server administration, not an interactive client command. The server receives provider credentials through operator configuration.
- `@` file search is omitted initially because the authoritative filesystem is remote. Pi can still read files through its native tools. Add remote file completion only after the core loop is reliable.
- `/tree`, `/fork`, `/clone`, `/export`, `/import`, `/share`, package installation, and custom TUI components may return a precise “not available remotely yet” message.
- RPC-degraded extension UI remains degraded exactly as documented by Pi. Pi Cloud does not emulate unsupported custom terminal components.
- Local Pi themes and keybinding files are not silently applied to the server. The client may use Pi’s default terminal theme and keybindings for the MVP.

These differences must be listed in `pi --cloud --help` and the release notes. We should not claim “full Pi parity” until the list is empty.

## Scope

### In scope

- one operator identity and statically configured bearer authentication;
- one Linux server;
- Apple Silicon macOS clients running upstream Pi plus the Pi Cloud extension;
- one API process and one long-lived runner supervisor;
- multiple persistent repositories, with at most one active Pi process per workspace;
- public HTTPS Git repositories;
- private GitHub HTTPS repositories through an optional fine-grained PAT;
- exact first checkout followed by a mutable persistent cloud branch;
- provider credentials injected only into the claimed Pi process;
- ordinary reviewed global Pi resources mounted read-only;
- trusted or untrusted project-resource policy selected when the workspace is created;
- native Pi session files as opaque persistent data;
- local interactive and print-mode clients;
- installation, health, logs, upgrade, rollback, backup, and restore documentation.

### Explicitly out of scope

- browser or mobile UI;
- teams, invitations, RBAC, SSO, billing, or multi-tenancy;
- a hosted Pi Cloud service;
- autoscaling, worker pools, Kubernetes, or horizontal API scaling;
- PR creation, automatic commits, code review UI, artifacts, screenshots, or remote desktop;
- GitHub/GitLab Apps and repository webhooks;
- issue, Slack, Linear, or chat integrations;
- environment snapshots, prebuild farms, or multi-repository workspaces;
- a custom agent loop, model gateway, memory system, plan mode, or task abstraction;
- transcript duplication in Pi Cloud’s database;
- syncing a live local working tree to the server;
- unpushed commits or dirty local changes;
- arbitrary private Git providers in the first release;
- administrative Pi sessions and the thin cloud capability extension unless a concrete MVP requirement cannot be met without them.

Cursor Cloud is a reference for the **remote execution property**—an isolated repository environment continues without the laptop—not for its product surface.

## Current foundation

The repository already has the difficult server-side vertical slice:

- authenticated workspace and hosted-session lifecycle;
- SQLite migrations and restart recovery;
- atomic runtime claims and single-use tunnel authority;
- authenticated public and internal WebSockets;
- strict, bounded Pi RPC envelopes and LF JSONL supervision;
- exact revision checkout;
- persistent workspace and native Pi session directories;
- stop, restart, reconnect, and native session resume;
- per-workspace Linux UIDs, process cleanup, resource limits, and network policy;
- scoped environment credentials and outbound redaction;
- a runner image and real hosted smoke script.

At the time this plan was written, `npm run check`, `npm run build`, and all 97 tests pass on `main`, and current CI is green.

The foundation is not an MVP because it lacks the terminal client, mutable Git workflow, complete server distribution, and operator lifecycle.

## Architectural decisions

### 1. Keep unmodified Pi in RPC mode

The Linux server never runs `pi --cloud`. The runner continues to launch its installed upstream Pi CLI with:

```bash
pi --mode rpc --session-dir <persistent-dir> [--session <native-file>]
```

Pi owns the session and all agent behavior. Pi Cloud must not parse session JSONL files directly when Pi can answer through `get_state`, `get_entries`, `get_tree`, or another native RPC command.

A PTY/SSH/tmux design would preserve the complete upstream TUI, but it would replace the established RPC contract and conflict with the project’s isolation and orchestration architecture. It is not the MVP architecture.

### 2. Make `pi --cloud` the only client entry point

Pi already allows installed extensions to register CLI flags, so `@pi-cloud/extension` owns the boolean `--cloud` flag and cloud-only flags such as `--detach`. The documented installation is:

```bash
curl -fsSL https://raw.githubusercontent.com/fschrhunt/pi-cloud/main/scripts/install.sh | sh
```

The script runs on the client Mac, verifies a supported upstream Pi installation, resolves a pinned Pi Cloud release, verifies the downloaded release checksum, and installs `@pi-cloud/extension` through Pi’s native package system. It does not install or replace Pi, add a wrapper named `pi`, require global Node/npm installation, or modify shell startup files. Re-running the installer performs a versioned upgrade; a version flag allows reproducible installation and rollback.

Current Pi can parse an extension-defined `--cloud` flag, but it still constructs a local model/session runtime before the extension can take over. The MVP therefore requires a small generic upstream startup-delegation seam that runs after extension discovery and flag validation but before local model, session, and TUI initialization. The Pi Cloud extension uses that seam to mark the invocation handled and run its bundled remote terminal client. This seam must not contain Pi Cloud-specific URLs, authentication, or lifecycle logic.

Do not shadow the upstream `pi` executable, install a PATH wrapper named `pi`, call `process.exit()` from an extension factory, or initialize a disposable local Pi session behind the user’s back. If the upstream seam is unavailable, the MVP is blocked pending an explicit architecture decision; it does not ship a second documented command.

Keep the extension shaped like the operator’s existing Pi extensions:

```text
packages/cloud/
├── index.ts
└── package.json   # name: @pi-cloud/extension
```

`index.ts` is the ordinary Pi extension entry point. Add helper modules beside it only when a concrete behavior cannot remain readable in that file. Do not add a separate extension framework, launcher, generated wrapper, nested application, or unnecessary `src/` hierarchy.

### 3. Build a narrow remote TUI, not a Pi fork

Pi exports `@earendil-works/pi-tui`, message/tool renderers, selectors, theme utilities, and RPC types. Reuse those public exports inside the installable `packages/cloud`; it bundles the remote terminal client and does not expose another executable.

Do not copy `InteractiveMode`. Upstream `InteractiveMode` is coupled to a local `AgentSessionRuntime`; it is not a transport-neutral frontend. The client should contain only:

- hosted lifecycle and WebSocket transport;
- transcript/event projection;
- editor and key mapping;
- RPC-backed built-in commands; and
- extension UI request handling.

Pin the extension and runner to the same Pi version in each Pi Cloud release. Add a server/client/Pi protocol handshake and reject incompatible major versions with an actionable upgrade message.

### 4. Preserve one authoritative stream

On attach:

1. authenticate;
2. start a stopped hosted session if necessary;
3. wait for the runtime to report `running`;
4. attach the RPC WebSocket;
5. request `get_state`;
6. request `get_entries` from the client’s last durable entry ID, or all entries on first attach;
7. render persisted entries;
8. apply live events after the recovered cursor; and
9. treat `message_end` and persisted entries as authoritative over partial streaming projections.

The client must deduplicate the race between transcript recovery and live events. A reconnect must never duplicate a user message, tool result, or assistant response.

### 5. Make workspaces mutable after a sealed checkout

The current runner verifies that persistent `HEAD` always equals the workspace’s original revision. That prevents normal commits and must change.

The MVP model is:

- `repositoryUrl` and `baseRevision` are immutable workspace provenance;
- first materialization fetches and verifies the exact base revision;
- the runner creates a stable branch such as `pi-cloud/<workspace-id>` at that commit;
- subsequent launches verify the origin URL, workspace identity, branch identity, ownership, and Git repository integrity;
- subsequent launches do **not** require `HEAD` to remain at the base revision;
- uncommitted files and later commits persist across Pi process and API restarts.

Do not auto-commit or auto-push. Pi and the operator use ordinary Git. For private GitHub repositories, inject a fine-grained PAT through an ephemeral `GIT_ASKPASS` helper for clone, fetch, and push; never write it into `.git/config`, credential stores, remotes, or workspace files. Redact it from Pi output and diagnostics.

### 6. Ship one complete Compose stack

The release Compose file includes:

- API image;
- runner image;
- Caddy or an equivalently small TLS/WebSocket reverse proxy;
- metadata volume;
- workspace/session volume;
- read-only operator Pi resource mount;
- health checks, restart policies, log bounds, resource limits, and explicit networks.

Only the reverse proxy publishes host ports. The API has no workspace mount. The runner has no inbound public port. The root runner supervisor retains dispatcher authority while Pi runs as its workspace UID.

Localhost development remains separate from the server distribution.

### 7. Reduce rather than generalize

The older agent/run/task API is not part of this MVP user journey. Freeze it during MVP work. Do not make the terminal client depend on it, and do not expand it to model hosted Pi sessions. After the MVP, decide whether to remove it or retain it as an automation API.

## Delivery plan

Each phase is a vertical, releasable slice. Do not begin broad hardening before the first terminal loop proves the product.

### Phase 0 — Lock the contract

**Deliverables**

- Update `docs/product-scope.md` and `README.md` to say “terminal client,” not browser-first.
- Replace the existing milestone ordering with this MVP sequence.
- Define versioned client configuration and server capability schemas in `packages/contracts`.
- Specify and pursue the generic upstream startup-delegation seam required by `pi --cloud`.
- Define the supported Pi RPC command/event matrix and incompatible-version behavior.
- Record the supported Linux, Docker, Git, Node, and Pi versions.

**Acceptance**

- A reader can determine exactly what ships and what does not.
- No open MVP issue requires browser work, multi-tenancy, a managed service, or a new agent abstraction.

### Phase 1 — Prove the terminal loop first

Create the simple `packages/cloud` Pi extension, published as `@pi-cloud/extension`, containing the remote terminal client. Expose it only through Pi’s `--cloud` startup delegation. Connect it to the existing hosted-session API before adding deployment features.

**Deliverables**

- checksum-verified curl installer using Pi’s native package system internally;
- Pi extension installation and `--cloud` flag registration;
- pre-runtime startup delegation with no local Pi session side effects;
- first-run URL/token configuration;
- Git origin and full-HEAD discovery;
- workspace lookup/create and hosted-session create/start/attach;
- Pi TUI-based editor and transcript;
- prompt, streaming text, tool rendering, steer, follow-up, abort, and Ctrl+C-safe terminal restoration;
- `get_state` plus full `get_entries` hydration;
- extension select/confirm/input/editor requests;
- concise connection, runtime, and remote-workspace status.

**Acceptance trace**

```text
terminal A: pi --cloud "inspect this repository"
→ Pi reads files and streams tool use
→ disconnect terminal A during the run
→ Pi continues on the server
terminal B: pi --cloud -c
→ prior entries render once
→ live work resumes without duplicated records
→ send a follow-up and receive a settled response
```

Test against fake Pi for deterministic protocol cases and real Pi for one release smoke flow.

**Stop condition**

If the exported Pi components cannot produce a maintainable terminal experience without copying upstream internals, stop and propose the smallest upstream Pi transport abstraction. Do not silently fork `InteractiveMode`.

### Phase 2 — Complete the Pi-like command surface

**Deliverables**

- list hosted sessions by workspace and recency;
- `pi --cloud`, `-c`, `-r`, `-p`, and `--detach` semantics;
- `/model`, model selector, thinking-level cycling, `/compact`, `/name`, and `/session`;
- remote `!command` and abort through Pi RPC;
- remote extension/skill/prompt command discovery;
- local handling for hosted `/new` and `/resume`;
- explicit messages for unsupported interactive commands;
- bounded reconnect with exponential backoff and a user-visible offline state.

**Server changes**

- add authenticated hosted-session listing;
- expand the public RPC command allowlist only for commands used by the client;
- expose a safe version/capability endpoint;
- retain schema, size, sequence, owner, and redaction enforcement.

**Acceptance**

- The required compatibility contract above has one focused test per behavior.
- Print mode exits with stable exit codes for success, Pi failure, authentication failure, and lost runtime.
- Detach confirms that Pi accepted the prompt before exiting.

### Phase 3 — Make the remote repository useful

**Deliverables**

- exact base-revision verification followed by a stable mutable branch;
- resume after uncommitted edits and after new local commits in the remote workspace;
- public HTTPS clone/fetch;
- optional private GitHub HTTPS clone/fetch/push using an ephemeral askpass credential;
- startup diagnostics for unreachable revision, expired credential, wrong origin, corrupt repository, and branch mismatch;
- no automatic commit, push, or PR behavior.

**Acceptance trace**

```text
create workspace at exact pushed revision
→ Pi edits files
→ stop and restart runtime
→ edits remain
→ Pi commits the edits
→ stop and restart API and runner
→ commit and native Pi session both resume
→ push cloud branch
→ verify token is absent from environment diagnostics, Git config, remote URL, files, and public records
```

### Phase 4 — Ship the server as a product

**Deliverables**

- multi-stage API image running as non-root;
- versioned production Compose bundle for proxy, API, and runner;
- ordinary `docker compose up|down|ps|logs` operator workflow;
- documented generation of high-entropy API, dispatcher, and lease credentials;
- TLS and WebSocket proxy configuration;
- health/readiness checks that distinguish API health from runner availability;
- graceful API and runner shutdown;
- bounded structured logs with authorization and secret redaction;
- release archives, the macOS client installer, Compose bundle, checksums, and pinned package/image versions;
- clean-host installation guide.

**Acceptance**

- A clean supported host reaches a working prompt without cloning this source repository or installing Node globally.
- Restarting any one container cannot create two Pi processes for one workspace.
- The API container cannot read repository or native session files.
- `doctor` detects wrong permissions, missing Pi resources, invalid URLs, unavailable provider credentials, stopped Docker, and incompatible versions.

### Phase 5 — Persistence, recovery, and operator lifecycle

**Deliverables**

- documented persistent-data manifest covering SQLite, WAL files, repositories, native Pi sessions, and operator Pi resources;
- quiesced `backup` and verified `restore` commands;
- schema/data version preflight before repository execution;
- versioned upgrade and rollback procedure;
- explicit archive and physical delete behavior with no orphaned data;
- API process signal handling and runner cleanup verification;
- disk-space checks and actionable bounded diagnostics.

**Acceptance trace**

```text
complete several Pi turns and edit repository files
→ stop/quiesce the stack
→ create backup
→ destroy the deployment volumes
→ reinstall the same release
→ restore backup
→ upgrade one supported version
→ pi --cloud -c
→ same repository files, branch, transcript, and native session resume
```

### Phase 6 — Release-candidate pilot

Run the real workflow for at least one week on one operator-owned Linux server.

**Required scenarios**

- public repository and private GitHub repository;
- interactive prompt and detached prompt;
- reconnect while idle and while streaming;
- client network loss;
- Pi idle shutdown and resume;
- API restart, runner restart, host reboot;
- model-provider failure and expired Git credential;
- long tool output near record limits;
- extension dialog round trip;
- backup and bare-host restore;
- upgrade and rollback.

Record setup time, resource use, failures, manual interventions, and data-loss observations. The MVP releases only when there are no known paths to silent transcript loss, workspace loss, duplicate active Pi processes, or credential disclosure.

## Test strategy

### Focused automated tests

- Pi package flag registration and pre-runtime startup delegation;
- client repository discovery and config permissions;
- lifecycle command mapping;
- strict hosted envelope sequence and reconnect reset;
- streaming projection followed by authoritative message replacement;
- entry-cursor hydration and deduplication;
- steering/follow-up/abort key behavior;
- extension UI request/response correlation;
- terminal restoration after signals and transport failure;
- mutable repository resume and Git credential scrubbing;
- client/server/Pi version compatibility;
- backup manifest and restore preflight.

### Integration tests

- API + runner + fake Pi for every pull request;
- built runner image + real Pi + fixture provider where possible;
- real provider/repository smoke on an explicit protected release workflow, never on untrusted pull requests;
- clean Linux VM installation for release candidates.

The existing `npm run check`, `npm run build`, and `npm test` remain mandatory. `npm run smoke:hosted` evolves into the terminal-client smoke rather than maintaining a separate bespoke protocol client.

## MVP release gates

All gates are binary:

- [ ] A checksum-verified curl install on Apple Silicon macOS enables `pi --cloud` without replacing Pi or modifying shell startup files.
- [ ] The Linux server neither installs the Pi Cloud extension nor invokes `pi --cloud`; hosted Pi starts only through `pi --mode rpc`.
- [ ] `pi --cloud` is the only user-facing client entry point and provides the required terminal compatibility contract.
- [ ] Active work survives client disconnect.
- [ ] Reconnect renders a correct transcript exactly once.
- [ ] Pi process, API, runner, and host restarts preserve workspace and native session state.
- [ ] Remote edits and commits survive restart and can be pushed.
- [ ] One versioned install works on a clean supported Linux host.
- [ ] Upgrade, rollback, backup, and destructive restore are tested.
- [ ] No API process has repository filesystem access.
- [ ] No sibling workspace or supervisor credential is readable by Pi.
- [ ] Public output, logs, Git configuration, and persisted metadata contain no configured secret.
- [ ] Failure diagnostics tell the operator what to do without exposing sensitive data.
- [ ] Documentation contains a 15-minute happy path from server install to first prompt.
- [ ] No browser, second client command, PATH wrapper, managed account, GitHub App, or Pi fork is required.

## Suggested issue/milestone reset

Use one milestone: **Terminal MVP**. Close, rewrite, or move existing issues according to delivered behavior rather than preserving the old M2–M5 order.

Create these implementation issues:

1. Define the terminal MVP, compatibility matrix, and `pi --cloud` startup-delegation seam.
2. Build the minimal hosted Pi terminal loop behind `pi --cloud`.
3. Recover transcript and live state across reconnect.
4. Add hosted session discovery and CLI lifecycle commands.
5. Expose the required native Pi RPC command subset.
6. Preserve mutable cloud branches across runtime restarts.
7. Add scoped private GitHub checkout and push credentials.
8. Ship the complete single-server Compose release.
9. Add server doctor, health, version, and graceful shutdown.
10. Install, upgrade, roll back, back up, and restore one server.
11. Run the clean-host terminal MVP pilot.

Mark browser issues as post-MVP or close them if the product no longer intends to ship a browser.

## Effort and ordering

The highest-risk unknowns are the upstream startup-delegation seam and the quality and maintenance cost of the remote terminal frontend, so Phase 1 comes first. Do not spend weeks polishing installation before proving that `pi --cloud` feels sufficiently like Pi.

A reasonable planning range for one experienced engineer is **six to eight focused weeks**, assuming the exported Pi renderers are reusable and private Git is limited to GitHub HTTPS. Treat that as a sequencing estimate, not a release promise:

- terminal spike and reconnect: 2 weeks;
- command/lifecycle surface: 1–2 weeks;
- mutable Git and scoped push: 1 week;
- complete Compose distribution and operator workflow: 1–2 weeks;
- recovery, backup/restore, and pilot fixes: 1–2 weeks.

If Phase 1 cannot obtain a clean pre-runtime startup seam or requires forking Pi’s interactive mode, stop and re-estimate. Do not replace `pi --cloud` with a wrapper or second public command as an unreviewed fallback.

## Research basis

### Pi

- Pi is deliberately a minimal terminal coding harness; extensions and packages customize behavior instead of expanding the core.
- Pi supports interactive, print, JSON, RPC, and SDK modes.
- Native sessions are append-only JSONL trees and remain the canonical conversation state.
- RPC provides prompts, steering, follow-ups, abort, model/thinking controls, compaction, session state, durable entry cursors, tool events, and extension UI dialogs.
- Built-in interactive commands are not automatically available in RPC mode; a remote client must map them to RPC and hosted lifecycle operations.
- RPC intentionally degrades terminal-specific extension APIs.
- Pi explicitly recommends containerizing the whole process when filesystem, process, network, and credential isolation are required.
- Pi extensions can register custom CLI flags, so the installed Pi Cloud extension can make `--cloud` syntactically valid.
- Current extension flags are configuration values consumed after local service construction; they do not provide a clean pre-runtime takeover hook.
- Upstream exports `InteractiveMode`, TUI components, renderers, and RPC types, but `InteractiveMode` requires an `AgentSessionRuntime`; it is not a remote transport adapter.

Primary sources:

- <https://github.com/earendil-works/pi>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts>

### Cursor Cloud reference

Cursor’s useful cloud-agent core is: clone a repository into an isolated remote development environment, provide dependencies/secrets/network access, let work continue without the local machine, and reconnect to the work later. Cursor adds many surfaces—web/mobile, source-control apps, Slack, artifacts, remote desktop, teams, prebuilds, and PR workflows—that Pi Cloud does not need for this MVP.

The Cursor CLI confirms the terminal expectations worth retaining: interactive prompting, initial prompt arguments, print mode, session resume, and explicit cloud handoff. Pi Cloud should provide those properties directly against the operator’s server without copying Cursor’s broader platform.

Primary sources:

- <https://cursor.com/docs/cloud-agent>
- <https://cursor.com/docs/cloud-agent/setup>
- <https://cursor.com/docs/cli/overview>
- <https://cursor.com/docs/cli/using>

## Final constraint

When a choice exists between adding cloud product behavior and preserving Pi behavior, preserve Pi. Pi Cloud should own only remote attachment, repository/process lifecycle, isolation, scoped credentials, persistence, and operator packaging.
