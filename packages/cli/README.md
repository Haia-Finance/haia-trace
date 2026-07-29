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

The template resolves exactly as `build` resolves it (`--templates-dir` included),
so a name means the same file in both commands. Only the *events* are always
built-in: a template with no bundled fixture set has nothing to replay.

### `haia-trace build [file...] [options]`

The core command. Read a run's events and produce **one Receipt per operation**.

Events are grouped into operations by their `context_id`; each group is folded
through the assembler independently. Every assembled receipt is written to
`.trace/receipts/<run>~<context_id>.json`.

```sh
haia-trace build                       # build the latest run in .trace/events/
haia-trace build --all                 # build every run in .trace/events/
haia-trace build ./run.ndjson          # build a specific run file
haia-trace build .trace/events/17217*.ndjson   # or a few of them
haia-trace build --template x402-seller
haia-trace build --template my-op      # your own, from .trace/templates/
haia-trace build --json                # machine-readable output for agents
```

| Argument / option        | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `[file...]`              | NDJSON run files to build from. Default: the latest in `.trace/events/`.   |
| `--all`                  | Build every run in the events directory. Not combinable with `[file...]`.  |
| `--template <name\|path>` | Operation template applied to every operation. Default: `x402-buyer`.      |
| `--templates-dir <path>` | Where your own templates live. Default: `.trace/templates/`.                |
| `--json`                 | Emit `{ runs: [{ run, path, receipts, unassigned }], template }` as JSON instead of a terminal summary. |

Several runs mean several builds, never one merged event set. An event carries no
run id — the run *is* its file name — and `context_id` is only unique within a
run, since an adapter may number operations per session (the x402 one does:
`op-1`, `op-2`, …). Folding two runs together would therefore merge two unrelated
payments that happen to share an id. So each run is read, assembled and reported
on its own, and its receipts are stored under its run id — which is also why the
receipt file name carries both.

For the same reason, two run files with the *same name* in different directories
are refused rather than built: their receipts would collide on disk, and the
second would silently replace the first. Build them one command at a time, or
rename one.

A `--template` **name** is looked up in `.trace/templates/` first and then in the
templates shipped with the CLI, so your own `my-op` is found with no extra flags
and a local `x402-buyer.yaml` deliberately shadows the built-in one. Anything that
isn't a bare name — `./ops/refund.yaml`, an absolute path — is read as a path to a
template file. A template that exists but doesn't parse always fails the build; it
never falls back to a built-in of the same name.

Run-level events that carry no `context_id` (chain confirmations, capture
attestations) belong to no single operation and are reported separately as
`unassigned` rather than attributed or dropped.

`--json` prints the full [Receipt](https://github.com/Haia-Finance/haia-trace/tree/main/packages/core)
objects — the machine-readable basis an agent reads (`completeness`, `missing`)
to decide whether to continue a chain of spending.

### `haia-trace template list | new`

A template is the declarative shape of an operation — the milestones that have to
be witnessed for it to count as complete. Two ship with the CLI (`x402-buyer`,
`x402-seller`); any other operation needs one you write.

```sh
haia-trace template list          # everything `build --template` will accept
haia-trace template new my-op     # scaffold .trace/templates/my-op.yaml
```

`list` shows the built-in templates and your project's own, each labelled with the
file `build` would actually load:

```text
📋 Operation templates

  ✔ my-op        .trace/templates/my-op.yaml
  ✔ x402-buyer   built-in
  ✔ x402-seller  built-in

3 templates available.
```

`new` writes a commented starter template into `.trace/templates/` — the same
directory `build` searches first, so `haia-trace build --template my-op` picks it
up as soon as you've edited the stages. It refuses to overwrite an existing file
unless you pass `--force`, and both subcommands take `--templates-dir <path>` if
your templates live somewhere else.

### Global flags

- `-v, --version` — print the version and exit.
- `-h, --help` — help for the program or any command (`haia-trace build --help`).

## The `.trace/` directory

The CLI reads and writes a project-local `.trace/` directory — no daemon, no
database, no network:

```text
.trace/
  events/<run_id>.ndjson     # recorded events; one run = one file (the input)
  receipts/<run>~<context_id>.json # assembled receipts, one per operation (the output)
  templates/<name>.yaml      # your own operation templates (yours to edit)
```

A run file is newline-delimited JSON — one event per line, append-only. It's the
source of truth; a Receipt is a derived, reproducible artifact, so re-building
the same run always yields the same Receipt.

`events/` and `receipts/` are derived and belong in `.gitignore`; `templates/` is
source you write, so ignore the two subdirectories rather than `.trace/` as a
whole:

```gitignore
.trace/events/
.trace/receipts/
```

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
