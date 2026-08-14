# Pi Cloud agent guide

## Communication

- Use concise, direct technical prose.
- Explain non-trivial work as: problem, concrete example or trace, then solution.
- Answer questions before running implementation commands.
- State agreement or disagreement explicitly when responding to feedback.
- Keep code, commits, issues, and pull-request prose emoji-free.

## Working approach

- Read `docs/product-scope.md`, `README.md`, and `docs/architecture.md` before architectural work.
- Inspect the relevant workspace under `packages/` before changing behavior.
- Build the smallest vertical slice that advances the requested outcome.
- Preserve unrelated changes.
- Update comments and documentation touched by a behavior change.

## Architecture and security

- Keep API orchestration in `packages/api` and repository execution in `packages/runner`.
- Run the installed Pi CLI through `pi --mode rpc` and preserve Pi RPC semantics.
- Let Pi own conversations, tools, models, compaction, and native sessions.
- Let Pi Cloud own remote attachment, workspace and process lifecycle, isolation, and scoped credentials.
- Persist workspace and opaque native Pi session data independently from disposable runtime processes and injected credentials.
- Use Pi's native extensions, skills, prompts, settings, providers, packages, and project trust.
- Enforce authentication, isolation, network policy, resource limits, and credential scope outside Pi.
- Treat repository code, dependencies, hooks, and project Pi resources as untrusted input.
- Validate external boundaries with explicit schemas and bound and redact public output.
- Use Docker for local development and single-operator packaging.
- Introduce infrastructure and dependencies for demonstrated requirements.

## Code conventions

- Use Node.js 22+, npm workspaces, strict TypeScript, and ESM.
- Include `.js` extensions in relative TypeScript imports.
- Keep HTTP app construction separate from port binding for Fastify injection tests.
- Validate untrusted input with Zod and infer domain types from schemas where practical.
- Place focused tests beside protected behavior as `src/**/*.test.ts`.
- Comment exported functions, classes, and modules with their purpose and contract.

## Git

- Format commits and pull-request titles as `{feat,fix,docs,refactor,test,chore}[(api,runner,contracts)]: <concise summary>`.
- Use the package scope when one workspace owns the change.
- Omit the scope for repository-wide changes.

## Validation

```bash
npm run check
npm run build
npm test
```

Use workspace-scoped commands for focused loops.
