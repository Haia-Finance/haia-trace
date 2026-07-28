/**
 * The starter template `haia-trace template new` writes.
 *
 * It lives here as text rather than as a file under `templates/` for two reasons:
 * a shipped file would show up in `template list` as a template you could build
 * against, and the `template:` field has to carry the name the user chose. Keeping
 * it a function makes the substitution ordinary string interpolation instead of a
 * rewrite pass over parsed YAML.
 *
 * What it emits is a *valid* template — a test parses it through the same
 * `assertOperationTemplate` contract as the shipped ones — but a deliberately
 * inert one: the placeholder event types match nothing, so building against an
 * unedited scaffold yields PARTIAL receipts rather than a false clean verdict.
 */

import { stringify } from "yaml";

/** Render the starter template for `name` — commented YAML, ready to edit. */
export function renderScaffold(name: string): string {
  // Let YAML decide whether the name needs quoting rather than pasting it in bare.
  // A slug like `42` or `null` is a perfectly good template name and file name, but
  // written plain it parses back as a number or a null and the template we just
  // wrote fails its own contract. `stringify` quotes exactly those and leaves an
  // ordinary `my-op` alone.
  const templateName = stringify(name).trimEnd();

  return `# ${name} — the operation this template gives a verdict on.
#
# A template is the declarative shape of one operation: the milestones that have
# to be witnessed for it to count as complete. \`build\` folds each operation's
# events through this file and returns FULL when every required stage closed,
# PARTIAL otherwise — with an explanation for each one that did not.
#
# Replace the placeholder event types below with the ones your recorder emits.
template: ${templateName}
version: 1
stages:
  # A stage closes the first time any event in its \`match\` list is observed. The
  # list is an OR, not a sequence: one entry per witness that proves the same
  # milestone, so a single template can cover several ways of doing the work.
  - id: request
    required: true
    match:
      - event: your.namespace.requested
    # Shown on the receipt when a required stage never closed. Say what the gap
    # means for the operation, not that an event was missing.
    missing_explanation: "the operation was never requested"

  # \`required: false\` marks a progress marker rather than a milestone: it is
  # reported when observed, but its absence never makes a receipt partial.
  - id: authorization
    required: false
    match:
      - event: your.namespace.authorized

  - id: settlement
    required: true
    match:
      - event: your.namespace.settled
    missing_explanation: "the operation was requested, but never settled"

# Faults observed during the operation. An exception is surfaced on the receipt
# even when every stage closed, so an operation that looks complete cannot hide
# one that went wrong along the way.
exceptions:
  - your.namespace.failed
  - your.namespace.canceled
`;
}
