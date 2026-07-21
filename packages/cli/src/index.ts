/**
 * Placeholder export for the monorepo bootstrap.
 *
 * The real surface — the `trace` commands (sample, last, rerun, anchor, init)
 * and their terminal / json / markdown renderers — lands here. The import below
 * exists to wire this package to `@usehaia/trace-core` while there is no product
 * code yet.
 */
import type { TraceEvent } from "@usehaia/trace-core";

/** Placeholder command-handler shape, proving the core type dependency resolves. */
export type CliEventHandler = (event: TraceEvent) => void;

export const CLI_PLACEHOLDER = "trace-cli/ready" as const;
