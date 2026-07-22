# CLAUDE.md

Engineering conventions for the `haia-trace` monorepo. **This repository is
public** — keep this file to engineering guidance only.

## Layout

```
packages/
  core/   @usehaia/trace-core   contracts + deterministic receipt assembler
  x402/   @usehaia/trace-x402   x402 capture adapter (records events)
  cli/    @usehaia/trace-cli    CLI, renderers, template loader
          cli/templates/*.yaml  operation templates — shipped in the CLI package
```

`x402` and `cli` depend on `core` via `"@usehaia/trace-core": "workspace:*"`.
The templates are plain yaml data (not code, not a workspace package); they live
in `packages/cli/templates/` and ride into the published tarball via the CLI's
`files` list, so every install carries them.

## Toolchain

- **pnpm** workspaces, **Node ≥ 20**. Shared dev-dependency versions are pinned
  in the `catalog:` block of `pnpm-workspace.yaml`; reference them as
  `"typescript": "catalog:"`, never with a literal version in a package.
- Build is plain **`tsc`** per package → `dist/` (no bundler). **Vitest** for tests.

## Commands

```sh
pnpm install
pnpm build         # pnpm -r run build — topological, core compiles first
pnpm test          # builds, then pnpm -r run test
pnpm check-types   # builds, then pnpm -r run check-types (tsc --noEmit)
pnpm clean         # remove dist/ in every package
```

`x402`/`cli` resolve `@usehaia/trace-core` through its built `dist`, so `test` and
`check-types` run `build` first — both are safe to run on a fresh checkout without
a manual build. Each package has two tsconfigs: `tsconfig.json` (includes tests, used
by `check-types`) and `tsconfig.build.json` (excludes tests, used by `build` so
`dist/` stays publish-clean).

## Code conventions

- **Zero third-party runtime dependencies in `core` and `x402`.** These packages
  are embedded in — or run right next to — the user's payment path, so their
  auditability is a trust guarantee: runtime code (anything shipped in `dist/`)
  must not add third-party `dependencies`. Internal `@usehaia/*` workspace deps are
  allowed; anything else goes in `devDependencies`. The `cli` is a tool you *run*,
  not embed, so it may carry small, well-audited runtime deps (e.g. `yaml`, which
  has no transitive deps) — keep them minimal and justified.
- **ESM only**, `"type": "module"`, TypeScript `module`/`moduleResolution` set to
  `NodeNext`. Because output runs on Node directly, **relative imports carry a
  `.js` extension** in source: `import { x } from "./foo.js"` (not `"./foo"`).
  Cross-package imports use the bare specifier: `from "@usehaia/trace-core"`.
- TypeScript **strict** (plus `noUncheckedIndexedAccess`); see `tsconfig.base.json`.
- Tests are co-located as `src/*.test.ts` and use `vitest`.
- **Comments are public-facing.** This repo is public — every comment must make
  sense to an outside reader with no access to internal material. Do not cite
  private design docs, internal spec section numbers (`§7.1`), tickets, or
  private URLs; state the rationale inline instead. Link only to public
  references (e.g. the x402 docs).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>(<optional scope>): <description>`, subject in imperative mood.

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.
- Scope is usually the package: `feat(x402): ...`, `fix(core): ...`.
- Breaking change: `!` after the type/scope (`feat(core)!: ...`) and/or a
  `BREAKING CHANGE:` footer.
- Keep the subject short (≤ 72 chars) and human-readable — a plain summary of
  the change, not an exhaustive changelog. Add a body only when the *why* isn't
  obvious from the subject.

## Adding a package

Copy an existing package's `package.json` + `tsconfig.json` shape into
`packages/<name>/`. The `packages/*` workspace glob picks it up automatically —
no root file needs editing. For a `core`/`x402`-style embeddable package, keep
`dependencies` free of third-party packages (see the invariant above).
