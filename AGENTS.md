# Pi Cloud agent guide

## Start here

- Read `README.md` and `docs/architecture.md` before making architectural changes.
- Inspect the relevant workspace under `apps/`; do not infer behavior from the roadmap.
- Keep changes small and vertical. Pi Cloud is pre-alpha, so prefer the simplest implementation that advances the current slice.

## Architecture and security

- Preserve the control-plane/runner boundary: `apps/api` orchestrates and stores metadata; it must never execute repository code or mount task workspaces.
- `apps/runner` is the only component that may clone repositories or invoke Pi. Treat repositories, dependencies, hooks, and project-local Pi extensions as untrusted code.
- Design each runner for one task with a short-lived lease, bounded resources, scoped credentials, sanitized output, and guaranteed cleanup.
- Deny network access by default and never place long-lived credentials in runner images, logs, events, patches, or fixtures.
- Validate every external boundary with explicit schemas. Keep runner events and artifacts allowlisted and size-bounded.
- Docker is only the local smoke-test provider, not a production multi-tenant security boundary.
- Keep Pi integration behind its RPC/JSONL contract; do not depend on Pi's internal session-file format.
- Do not add speculative infrastructure or dependencies. Document the concrete requirement before introducing a database, queue, storage service, or SDK.

## Code conventions

- Use Node.js 22+, npm workspaces, strict TypeScript, and ESM. Include `.js` extensions in relative TypeScript imports.
- Keep HTTP app construction separate from port binding so API tests can use Fastify injection.
- Use Zod at untrusted inputs and keep domain types inferred from their schemas where practical.
- Add focused tests beside the behavior they protect as `src/**/*.test.ts`; avoid broad framework smoke tests.
- Comment exported functions, classes, and modules with a concise purpose and contract. Update related comments and docs when behavior changes.
- Preserve unrelated changes and never expose secrets.

## Commands

Run the repository-wide checks before handing off:

```bash
npm run check
npm run build
npm test
```

For a focused loop, pass the workspace explicitly, for example:

```bash
npm test --workspace=@pi-cloud/api
npm run check --workspace=@pi-cloud/runner
```
