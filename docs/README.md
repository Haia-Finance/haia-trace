# Haia Trace documentation site

The public docs site, built with [Mintlify](https://mintlify.com). Content lives
here as `.mdx`; the repo is the source of truth.

## Preview locally

```sh
npm install -g mint     # the Mintlify CLI
cd docs
mint dev                # serves http://localhost:3000
```

`mint dev` hot-reloads as you edit. Run `mint broken-links` before pushing.

## Structure

- `docs.json` — site config: name, theme, colors, and the navigation tree. A new
  page is only reachable once it is listed there.
- `index.mdx`, `quickstart.mdx`, `demo.mdx` — the landing and getting-started
  pages. `demo.mdx` is deliberately short: recordings of a real run plus the apps
  running the adapters for real, and no implementation detail a `sdk/`, `cli/` or
  `concepts/` page already carries.
- `assets/` — the terminal recordings on `demo.mdx`: each `.gif` is rendered from
  the `.cast` beside it with [`agg`](https://docs.asciinema.org/manual/agg/).
- `concepts/` — the product model (what a Receipt is).
- `cli/` — the `haia-trace` command reference, one page per command.
- `sdk/` — one page per published package: `trace-x402`, `trace-circle`,
  `trace-core`.

## This is the reference; READMEs are landing pages

A package README says what the package is, how to install it, one minimal working
example, and links here. Everything exhaustive — every event, flag, option, exit
code — lives only in these pages, so there is one copy to keep right:

| Code | Docs page | README |
| --- | --- | --- |
| `packages/core` | `docs/sdk/core.mdx` | `packages/core/README.md` |
| `packages/x402` | `docs/sdk/x402.mdx` | `packages/x402/README.md` |
| `packages/circle` | `docs/sdk/circle.mdx` | `packages/circle/README.md` |
| `packages/cli` | `docs/cli/*.mdx` | `packages/cli/README.md` |

Change a public API, a flag, a default or a shipped template and the docs page is
what has to move. Touch the README only when the change breaks its example or its
one-line summary. Grep `docs/` for the symbol you changed before calling a docs
update done.

## Deploy

Connect this repository in the Mintlify dashboard once, with the docs directory
set to `docs/`; thereafter every push to `main` publishes to
[developers.haia.finance](https://developers.haia.finance).
