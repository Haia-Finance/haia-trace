# @usehaia/trace-cli

The `haia-trace` command-line tool. It assembles **Operation Receipts** — one
verdict per payment operation — from recorded events, and renders them in the
terminal or as JSON. Part of [Haia Trace](https://github.com/Haia-Finance/haia-trace).

Requires **Node ≥ 20**.

## Install

```sh
npm install -g @usehaia/trace-cli
# or run without installing:
npx @usehaia/trace-cli <command>
```

Both expose the `haia-trace` command.

## Quickstart

```sh
haia-trace sample x402-buyer
```

`sample` replays a bundled fixture run through the real assembler, so you see a
Receipt with no setup:

```text
🧾 x402-buyer · op-2 · PARTIAL

  ✔ challenge   confirmed
  ✔ payment     confirmed
  ✖ settlement  not confirmed  required

  missing
    settlement — the payment was submitted, but no settlement response was observed

  operation not complete
```

The fixture contains three operations — a **FULL** one, the **PARTIAL** one
above, and one carrying an observed fault — so a single command shows the whole
model.

## Commands

### `haia-trace sample [template]`

Assemble receipts from bundled fixtures — the zero-setup first taste. Defaults to
the `x402-buyer` template (the paying agent's view); `x402-seller` shows the
resource server's view. The template name selects both the template and its
fixture set.

### `haia-trace build [file] [options]`

The core command. Read a run's events and produce **one Receipt per operation**.

Events are grouped into operations by their `context_id`; each group is folded
through the assembler independently. Every assembled receipt is written to
`.trace/receipts/<context_id>.json`.

```sh
haia-trace build                       # build the latest run in .trace/events/
haia-trace build ./run.ndjson          # build a specific run file
haia-trace build --template x402-seller
haia-trace build --json                # machine-readable output for agents
```

| Argument / option    | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `[file]`             | NDJSON run file to build from. Default: the latest in `.trace/events/`.  |
| `--template <id>`    | Operation template applied to every operation. Default: `x402-buyer`.  |
| `--json`             | Emit `{ receipts, unassigned }` as JSON instead of a terminal summary.  |

Run-level events that carry no `context_id` (chain confirmations, capture
attestations) belong to no single operation and are reported separately as
`unassigned` rather than attributed or dropped.

`--json` prints the full [Receipt](https://github.com/Haia-Finance/haia-trace/tree/main/packages/core)
objects — the machine-readable basis an agent reads (`completeness`, `missing`)
to decide whether to continue a chain of spending.

### `haia-trace templates`

List the operation templates shipped with the CLI.

```sh
haia-trace templates
```

### Global flags

- `-v, --version` — print the version and exit.
- `-h, --help` — help for the program or any command (`haia-trace build --help`).

## The `.trace/` directory

The CLI reads and writes a project-local `.trace/` directory — no daemon, no
database, no network:

```text
.trace/
  events/<run_id>.ndjson    # recorded events; one run = one file (the input)
  receipts/<context_id>.json # assembled receipts, one per operation (the output)
```

A run file is newline-delimited JSON — one event per line, append-only. It's the
source of truth; a Receipt is a derived, reproducible artifact, so re-building
the same run always yields the same Receipt.

## Producing a run file

`build` needs a `.trace/events/*.ndjson` run file.
[`@usehaia/trace-x402`](https://github.com/Haia-Finance/haia-trace/tree/main/packages/x402)
writes one from a live x402 app — attach it to your client or resource server and
`build` picks the run up with no path to configure, since both sides default to
`.trace/events`. Any NDJSON whose lines match the Event Contract works just as
well (the bundled [`fixtures/x402-buyer.ndjson`](./fixtures/x402-buyer.ndjson) is
a working example).

Build a capture against the template for the side that recorded it: `x402-buyer`
is the default, `--template x402-seller` for a resource server.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
