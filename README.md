# Haia Trace

Local-first **Operation Receipts** for agentic payments. Trace passively records
the lifecycle of a payment operation and assembles a single verdict — what
completed, what's missing, and what to connect next — entirely on your machine,
with no registration.

> Status: early scaffold. This repo currently contains the monorepo skeleton
> only; product functionality lands incrementally.

## Packages

| Package                | Role                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `@usehaia/trace-core`  | Contracts and the deterministic receipt assembler.         |
| `@usehaia/trace-x402`  | Capture adapter for the x402 payment SDK (records events). |
| `@usehaia/trace-cli`   | Command-line interface and renderers.                      |

`trace-x402` and `trace-cli` depend on `trace-core`.

## Quickstart

Requires **Node ≥ 20** and **pnpm**.

```sh
pnpm install
pnpm build   # compile all packages (topological: core first)
pnpm test    # run the test suite
```

`pnpm test` and `pnpm check-types` build first automatically, so they work on a
fresh checkout — no need to run `pnpm build` by hand beforehand.

## License

[MIT](./LICENSE)
