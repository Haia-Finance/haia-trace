/**
 * Placeholder export for the monorepo bootstrap.
 *
 * The real surface — the `trace` commands (sample, last, rerun, anchor, init)
 * and their terminal / json / markdown renderers — lands here. The import below
 * exists to wire this package to `@usehaia/trace-core` while there is no product
 * code yet.
 */
import { CORE_PLACEHOLDER } from "@usehaia/trace-core";

export const CLI_PLACEHOLDER = `${CORE_PLACEHOLDER}/cli` as const;
