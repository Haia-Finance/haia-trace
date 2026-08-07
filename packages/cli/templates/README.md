# templates/

The operation templates that ship with `@usehaia/trace-cli` — `x402-buyer`,
`x402-seller`, `x402-facilitator` and `escrow-arc`. They ride into the published
tarball via the `files` list in `package.json`, so every install can
`haia-trace build --template <name>` with no network fetch.

📖 What each one expects, stage by stage:
**[developers.haia.finance/cli/template](https://developers.haia.finance/cli/template)**

Templates are **data, not code**: a new scenario is a new file here plus, if the
events are new, a capture adapter — never a change to the assembler.

## Writing your own

Do it in your project, not here:

```sh
haia-trace template new my-op   # writes .trace/templates/my-op.yaml
haia-trace build --template my-op
```

`build` searches `.trace/templates/` before this directory, so a project template
also shadows a built-in of the same name.

## Editing one here

Files here are parsed by `../src/templates.ts` and validated against the Template
Contract by `assertOperationTemplate` from `@usehaia/trace-core`, which throws on
the first mismatch rather than producing a wrong receipt. `template:` must match
the file name, and a change to a shipped template's stages usually means the
fixtures under `../fixtures/` and the page linked above need updating with it.
