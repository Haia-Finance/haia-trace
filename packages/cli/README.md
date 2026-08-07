# @usehaia/trace-cli

The `haia-trace` command-line tool of
[Haia Trace](https://github.com/Haia-Finance/haia-trace). It reads a run of
recorded events and assembles **Operation Receipts** — one verdict per payment
operation — then renders them in the terminal or as JSON.

Local-first: it reads and writes a project-local `.trace/` directory. No daemon,
no database, no network.

ESM only, Node ≥ 22.

📖 **[developers.haia.finance/cli/overview](https://developers.haia.finance/cli/overview)**
— every command, flag and exit code.

## Install

```sh
npm install -g @usehaia/trace-cli
# or run it without installing:
npx @usehaia/trace-cli <command>
```

Both expose the `haia-trace` command.

## See a receipt with no setup

`sample` replays a bundled fixture run through the *real* assembler — only the
events come from a file that ships with the CLI:

```sh
haia-trace sample              # an x402 payment, as the paying client saw it
haia-trace sample escrow-arc   # an escrow on Arc, agreement to release or refund
```

```text
🧾 x402-buyer · op-2 · PARTIAL

  ✔ challenge   confirmed
  ✔ payment     confirmed
  ✖ settlement  not confirmed  required

  missing
    settlement — the payment was submitted, but no settlement response was observed

  operation not complete
```

## Commands

| | |
| --- | --- |
| `sample [template]` | Assemble receipts from bundled fixtures. |
| `build` | Assemble one receipt per operation from a run's events. |
| `receipt list` / `receipt show` | Read back what `build` wrote. |
| `template list` / `template new` | List the templates you can build against; scaffold your own. |

`build`, `receipt list` and `receipt show` also take `--json`. `--dir <path>`
relocates the whole `.trace/` root on any command.

## The `.trace/` directory

```text
.trace/
  events/<run>.ndjson              # recorded events — the input, and the source of truth
  receipts/<run>~<operation>.json  # assembled receipts — the output
  templates/<name>.yaml            # your own operation templates — source you author
```

A receipt is derived and reproducible: re-building the same run yields a
byte-identical receipt. Ignore the two derived subdirectories, not the root:

```gitignore
.trace/events/
.trace/receipts/
```

## Getting a run to build

The CLI assembles; it does not record. A capture adapter writes the run file:

- [`@usehaia/trace-x402`](https://www.npmjs.com/package/@usehaia/trace-x402) —
  in-process, for the x402 payment SDK.
- [`@usehaia/trace-circle`](https://www.npmjs.com/package/@usehaia/trace-circle) —
  in a webhook route, for Circle notifications.

Point the adapter at `events/` under whatever root you build with.

## Templates

Four ship with the CLI — `x402-buyer`, `x402-seller` and `x402-facilitator` for
the three sides of an x402 payment, and `escrow-arc` for an escrow on Arc.
`haia-trace template new <name>` scaffolds your own into `.trace/templates/`,
where a file of the same name shadows a shipped one.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
