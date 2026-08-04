# @usehaia/trace-cli

The `haia-trace` command-line tool. It assembles **Operation Receipts** — one
verdict per payment operation — from recorded events, and renders them in the
terminal or as JSON. Part of [Haia Trace](https://github.com/Haia-Finance/haia-trace).

Requires **Node ≥ 22**.

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
haia-trace build --dir .my-trace       # read and write a different root
haia-trace build --status partial      # write everything, show only the gaps
haia-trace build --json                # machine-readable output for agents
```

| Argument / option        | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `[file...]`              | NDJSON run files to build from. Default: the latest in the events directory. |
| `--all`                  | Build every run in the events directory. Not combinable with `[file...]`.  |
| `--template <name\|path>` | Operation template applied to every operation. Default: `x402-buyer`.      |
| `--dir <path>`           | Root holding `events/`, `receipts/` and `templates/`. Default: `.trace`.    |
| `--templates-dir <path>` | Where your own templates live. Overrides `--dir`. Default: `<dir>/templates/`. |
| `--status <full\|partial>` | Show only receipts with this verdict. A display filter: every receipt is still written to the store. |
| `--json`                 | Emit `{ runs: [{ run, path, assembled, receipts, unassigned }], template }` as JSON instead of a terminal summary. `--status` narrows `receipts` here too. |

Several runs mean several builds, never one merged event set. An event carries no
run id — the run *is* its file name — and `context_id` is only guaranteed unique
within a run, since an adapter may number operations per session. Folding two
runs together would therefore merge two unrelated payments that happen to share
an id. So each run is read, assembled and reported on its own, and its receipts
are stored under its run id — which is also why the receipt file name carries
both.

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

`--status` filters what is *shown*, never what is *written*: receipts are derived
and reproducible, so the store stays complete for `receipt list` and
`receipt show` whichever verdict a build chose to look at. The summary line still
reports everything assembled, with the shown subset noted after it, and each
run's JSON carries `assembled` — the unfiltered count — so an empty filtered
`receipts` never reads as a run that assembled nothing.

`--json` prints the full [Receipt](https://github.com/Haia-Finance/haia-trace/tree/main/packages/core)
objects — the machine-readable basis an agent reads (`completeness`, `missing`)
to decide whether to continue a chain of spending.

### `haia-trace receipt list | show`

Reading the receipts `build` has written. `list` answers "what's in the store?" —
one line per receipt — and `show` renders one verdict in full.

```sh
haia-trace receipt list                    # every receipt, grouped by run
haia-trace receipt list --run 1721709600000
haia-trace receipt list --status partial   # only the unresolved ones
haia-trace receipt show                    # the whole of the most recent run
haia-trace receipt show 9b5e7013           # one operation, named by an id prefix
haia-trace receipt show 9b5e7013 --run 1721709600000
haia-trace receipt list --json             # the index, for an agent to read
```

An operation is named in full or by any prefix that matches just one of the run's
operations — the x402 adapter mints a uuid per payment, so the short form is what
you reach for. The ids below are shortened for the same reason.

`list` groups by run, oldest first, and a run's operations in the order they
started:

```text
🧾 Receipts

  run 1721709600000
    ✔ op-1  FULL     x402-buyer
    ✖ op-2  PARTIAL  x402-buyer

  run 1721712000000
    ✔ op-1  FULL     x402-buyer

3 receipts across 2 runs.
```

| Argument / option | Applies to | Meaning                                                              |
| ----------------- | ---------- | -------------------------------------------------------------------- |
| `[operation]`     | `show`     | Operation to show. Default: every operation in the run.               |
| `--run <id>`      | both       | Which run. Default: every run for `list`, the most recent for `show`. |
| `--status <full\|partial>` | `list` | Show only receipts with this verdict.                          |
| `--dir <path>`    | both       | Root holding `events/`, `receipts/` and `templates/`. Default: `.trace`. |
| `--json`          | both       | Machine-readable output instead of a terminal rendering.              |

The two are deliberately read-only: a receipt is *derived* from a run's events, so
`build` is the only thing that creates one — there is no `receipt new`. To change a
verdict, change the template or the events and build again.

`show` with no operation renders the most recent run, which is the "how did the run
I just built go?" question. Naming an operation needs no `--run` either; it looks in
the most recent run unless you point it at an older one. Since an operation id is
only unique *within* a run, the two together are what address a receipt — which is
also why `show` is more than `cat`: an id that isn't a bare slug (a URL-ish
`context_id`) is escaped into the file name, so the file isn't nameable by hand and
this lookup is the only reliable way to it.

`list --json` emits an **index** — `{ receipts: [{ run, operation, path,
completeness, template }], unreadable }` — not whole receipts. It carries the
`completeness` an agent decides on, so a spend policy can read the store through
one command instead of globbing it. `show --json` emits the full Receipt objects as
`{ run, receipts, unreadable }`, the same shape whether or not you named an
operation.

A file in `receipts/` that can't be parsed is reported rather than skipped, so a
partly damaged store never presents as intact — on **stderr** in every case, so
`--json` stays parseable, and in the `unreadable` array of both commands' JSON,
which carries the run and operation its file name records. That holds even when a
query is refused, and a run whose receipts are all unreadable is still treated as
the most recent run rather than passed over for an older one whose verdicts would
look clean. Files the CLI didn't write are passed over in silence.

### `haia-trace template list | new`

A template is the declarative shape of an operation — the milestones that have to
be witnessed for it to count as complete. Three ship with the CLI — `x402-buyer`,
`x402-seller` and `x402-facilitator`, one per side of an x402 payment; any other
operation needs one you write.

```sh
haia-trace template list          # everything `build --template` will accept
haia-trace template new my-op     # scaffold .trace/templates/my-op.yaml
```

`list` shows the built-in templates and your project's own, each labelled with the
file `build` would actually load:

```text
📋 Operation templates

  ✔ my-op             .trace/templates/my-op.yaml
  ✔ x402-buyer        built-in
  ✔ x402-facilitator  built-in
  ✔ x402-seller       built-in

4 templates available.
```

`new` writes a commented starter template into `.trace/templates/` — the same
directory `build` searches first, so `haia-trace build --template my-op` picks it
up as soon as you've edited the stages. It refuses to overwrite an existing file
unless you pass `--force`, and both subcommands take `--dir <path>` (a different
root) or `--templates-dir <path>` (templates alone) if your templates live
somewhere else. The command `new` prints when it's done carries whichever of the
two you used, so the follow-up `build` resolves the file it just wrote.

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

`build` writes into `receipts/`, and [`receipt list` / `receipt show`](#haia-trace-receipt-list--show)
read it back — so nothing outside the CLI needs to know how a receipt file is
named.

`--dir` moves the root — `haia-trace build --dir .my-trace` — for a second project
in one checkout, or a scratch run that shouldn't touch the committed tree. What's
*inside* the root never changes: `events/`, `receipts/`, `templates/`. That's what
makes one flag enough, and what keeps a relocated directory readable by anyone who
only knows the default one. Every command that touches these takes `--dir`, and
`--templates-dir` still outranks it when you want templates alone somewhere else.

`events/` and `receipts/` are derived and belong in `.gitignore`; `templates/` is
source you write, so ignore the two subdirectories rather than `.trace/` as a
whole:

```gitignore
.trace/events/
.trace/receipts/
```

A relocated root needs its own entries — those two cover `.trace/` only, so
output under `.my-trace/` is untracked but not ignored, and the next `git add -A`
would commit it.

## Producing a run file

`build` needs an `events/*.ndjson` run file under the root.
[`@usehaia/trace-x402`](https://github.com/Haia-Finance/haia-trace/tree/main/packages/x402)
writes one from a live x402 app — attach it to your client or resource server:

```ts
import { createRunEventWriter } from "@usehaia/trace-core/file";
import { trace } from "@usehaia/trace-x402";

trace(client, { writer: createRunEventWriter(".trace/events") });
```

The recorder names its directory explicitly, so it's the one thing that has to
agree with the CLI: point it at `events/` under whatever root you `build` with. If
the directory you point `build` at is empty it says so by name; if it holds runs
from an *earlier* session, though, `build` assembles the newest of those without
complaint — so clear out or ignore a root you've stopped recording into.

Any NDJSON
whose lines match the Event Contract works just as well (the bundled
[`fixtures/x402-buyer.ndjson`](./fixtures/x402-buyer.ndjson) is a working example).

Build a capture against the template for the side that recorded it: `x402-buyer`
is the default, `--template x402-seller` for a resource server, `--template
x402-facilitator` for a facilitator.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
