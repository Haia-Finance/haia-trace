/**
 * `@usehaia/trace-cli` — the programmatic surface of the Trace CLI.
 *
 * The executable lives in `./cli.ts` (the package's `bin: trace`); this module is
 * the library entry point (`exports["."]`), re-exporting the pieces usable
 * without spawning the process: template loading and the command registry.
 */

export type { TraceCommand } from "./commands/index.js";
export { commands } from "./commands/index.js";
export * from "./templates.js";
