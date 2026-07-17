# templates/

Declarative operation templates (yaml) that ship with `@usehaia/trace-cli`.

Each template describes the expected flow of an operation — its stages, which
events close each stage, allowed conclusions, and what to connect next when a
stage is missing. Templates are **data, not code**: a new scenario is a new file
here plus (if needed) a capture adapter, never a change to the core assembler.

_Empty for now — templates land with the core contracts._
