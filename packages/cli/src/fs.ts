/**
 * The one filesystem predicate the CLI reaches for.
 *
 * Every path the CLI reads or writes is optional in some way — a run directory
 * that doesn't exist yet, a template a project hasn't authored, a file that must
 * not be clobbered — so the difference between "absent" and "broken" is a decision
 * each call site has to make deliberately. Distinguishing them by `errno` in one
 * place keeps that decision explicit and stops a real fault (a permission error, a
 * directory where a file was expected) from being read as absence.
 */

/** Whether an error is a Node filesystem error carrying the given `code`. */
export function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === code
  );
}
