# templates/

Declarative operation templates (yaml) that ship with `@usehaia/trace-cli` — they
are packaged into the published tarball (see the `files` list in `package.json`),
so every install carries them.

Each template describes the expected flow of an operation — its **stages**, which
**events close each stage** (matched on `event_type`), and what an unclosed stage
means (`missing_explanation`). Templates are **data, not code**: a new scenario is
a new file here plus (if needed) a capture adapter, never a change to the core
assembler.

Loaded via `loadTemplate(name)` from `../src/templates.ts`, which parses the yaml
and validates it against the Template Contract (`assertOperationTemplate` in
`@usehaia/trace-core`).
