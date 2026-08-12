# Architecture

## Purpose

Pi Cloud separates **orchestration** from **code execution**. The control plane coordinates identity, task state, policy, and durable records. A disposable runner is the only component allowed to clone repositories or invoke Pi.

## Components

### Control plane (`apps/api`)

Owns users, repository connections, task metadata, approvals, task leases, audit records, and the public event API. It must not mount a task workspace, run shell commands supplied by a repository, or receive long-lived model credentials from a runner.

### Runner (`apps/runner`)

Receives one signed, time-limited task lease. It creates an isolated workspace, checks out exactly the lease's repository revision, starts Pi with `pi --mode rpc`, and forwards a structured allowlisted event stream. The runner publishes a patch and selected artifacts, then destroys the workspace and its credentials.

### Sandbox provider

Abstracts VM/container lifecycle only. The local implementation is Docker, configured with a non-root user, read-only filesystem, dropped capabilities, resource limits, and no network. This is a developer smoke-test environment—not an adequate hosted multi-tenant boundary. Production should use one disposable microVM per task; the runner protocol must remain suitable for customer-hosted runners.

## Current vertical slice

`POST /v1/tasks` accepts an HTTPS repository URL, immutable revision, and prompt, then creates an in-memory `queued` task. This deliberately stops before dispatch: no user authentication, durable storage, runner lease, checkout, or Pi process exists yet. The narrow contract lets us add those components in order without putting repository execution in the API process.

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Browser → control plane | Authenticate every request; authorize by repository installation and task membership. |
| Control plane → runner | Use signed, single-task leases with expiry, audience, and replay protection. |
| Runner → repository | Treat checkout hooks, dependencies, and project-local Pi extensions as untrusted code. |
| Runner → external network | Deny by default; allow only required Git, package, model, and task endpoints. |
| Runner → control plane | Redact configured secrets; accept an allowlisted event schema and bounded artifact sizes. |

## Pi integration

The runner starts the installed Pi CLI in RPC mode and communicates using LF-delimited JSONL. Pi's local session file remains inside the task sandbox. Pi Cloud may retain a sanitized transcript and task metadata, but must not assume Pi's internal session format is a stable database schema.

## Deliberate non-goals for the first slice

- Browser-based IDE
- Multi-agent scheduling
- Persistent development VMs
- Broad, unrestricted network access
- Storing users' long-lived model provider tokens in runner images

The first end-to-end vertical slice is: create task → lease disposable runner → clone one repository → start Pi RPC → stream events → retain patch → destroy runner.
