# Haia Trace documentation site

The public docs site, built with [Mintlify](https://mintlify.com). Content lives
here as `.mdx`; the repo is the source of truth.

## Preview locally

```sh
npm install -g mint     # the Mintlify CLI
cd docs
mint dev                # serves http://localhost:3000
```

`mint dev` hot-reloads as you edit. Run `mint broken-links` to check internal
links before pushing.

## Structure

- `docs.json` — site config: name, theme, colors, and the navigation tree.
- `index.mdx`, `quickstart.mdx` — the landing and getting-started pages.
- `concepts/` — the product model (what a Receipt is).
- `cli/` — the `haia-trace` command reference.
- `sdk/` — the `@usehaia/trace-x402` and `@usehaia/trace-core` package docs.

## Deploy

Connect this repository in the Mintlify dashboard once; thereafter every push to
`main` publishes automatically. Set the docs directory to `docs/`.

## Conventions

- The site is the canonical home for narrative and reference. Keep package
  READMEs short and link here, so content doesn't diverge.
- `docs.json` colors and `favicon.svg` are placeholders — swap them for the Haia
  brand.
