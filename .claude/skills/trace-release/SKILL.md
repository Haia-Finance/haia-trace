---
name: trace-release
argument-hint: "[patch|minor|major|X.Y.Z]"
arguments: version
description: Bump the shared version of the four published npm packages (@usehaia/trace-core, trace-x402, trace-cli, trace-circle), commit the bump with this repo's `chore` release subject, and cut the matching vX.Y.Z tag. Use this skill whenever the user wants to release/publish/ship the packages, cut or tag a version, bump the package version, or asks what the next release number should be — even if they only say something short like "release a patch" or "bump to 0.1.0" and never mention the word "skill". Also use it when they ask how a release works here or why a version tag matters, since the tag is what triggers the npm publish. Not for bumping a dependency or devDependency version (including anything in the `catalog:` block), Node or `engines` version questions, the `version:` field inside operation templates, or deploying the docs site — none of those touch a release.
---

# Releasing haia-trace

A release here is four lines of JSON, one commit, and one tag. The tag is the
part that matters: pushing `vX.Y.Z` triggers `.github/workflows/release.yml`,
which publishes every package to npm's `latest`. **A published npm version
is permanent — it can never be replaced.** So the work is cheap and the mistake
is expensive, which is why this skill front-loads verification and stops before
the push.

## What carries the version

Exactly four files, all bumped in lockstep to the same number:

- `packages/core/package.json`
- `packages/x402/package.json`
- `packages/cli/package.json`
- `packages/circle/package.json`

The workflow publishes with `pnpm -r publish`, which takes whatever the
workspace exposes rather than a list it keeps in step by hand. A new publishable
package therefore ships the moment it exists — so adding one means adding it to
`scripts/bump.mjs` too, or it would be published at whatever stale version its
manifest still carried.

Nothing else. Deliberately *not* bumped:

- the root `package.json` — private, stays `0.0.0`
- `examples/x402-agent/package.json` — private, never published, stays `0.0.0`
- `pnpm-lock.yaml` — the workspace packages resolve through `workspace:*`, so the
  lockfile records no version for them and needs no regeneration
- the README badges — they read live from the npm registry (shields.io), so they
  update themselves once the publish lands
- `haia-trace --version` — `packages/cli/src/cli.ts` reads it from its own
  manifest at runtime, precisely so there is one source of truth

That list is the reason step 4 below greps for the old version: if it turns up
anywhere outside those four manifests, someone has hardcoded a version since
this skill was written, and it needs bumping too (and probably de-hardcoding).

## Steps

### 1. Preflight

Do not start editing until all of this holds — a release cut from a dirty or
stale tree publishes something nobody reviewed:

```sh
git rev-parse --abbrev-ref HEAD      # must be main
git status --porcelain               # must be empty
git fetch origin && git status -sb   # must not be behind origin/main
git tag --sort=-creatordate | head -5
```

If the working tree is dirty or the branch isn't `main`, stop and say so rather
than committing unrelated work into a release commit. If `main` is *ahead* of
origin, mention it — those commits haven't been through CI, and while the release
workflow re-checks types and tests, it's worth knowing what you're shipping.

### 2. Decide the version

Either way, first read what's shipping since the last tag — the user should see
what the number covers before anything is committed:

```sh
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
```

**If the skill was invoked with an argument, that is the version.** It arrives as
`$version` (from `/trace-release 0.0.5`, `/trace-release patch`, and so on), and
it is empty when the skill was invoked bare:

> version argument: `$version`

When it's set, don't re-ask — the user has already answered. Summarise the range,
say which version you're bumping to, and go straight to step 3, which validates
the value anyway and refuses anything that isn't `patch`, `minor`, `major`, or a
real `X.Y.Z`.

When it's empty, recommend a number and let the user confirm. **Recommend a patch
bump by default.** Pre-1.0 this project bumps the patch even across breaking
changes — `v0.0.4` shipped two `feat(core)!:` commits and was still a patch — so
inferring minor or major from conventional-commit types alone would contradict how
the project actually versions. Summarise what's in the range, say what you'd pick,
and take their answer.

### 3. Bump

```sh
node .claude/skills/trace-release/scripts/bump.mjs <patch|minor|major|X.Y.Z>
```

Pass whatever step 2 settled on — don't substitute a default here. It refuses to run if the
manifests disagree about the current version, since that means a previous
release was half-applied and the right fix is to look, not to overwrite.

### 4. Verify the diff is boring

```sh
git diff --stat
git diff
git grep -nF "<old-version>" -- ':!.claude'
```

Expect exactly four files, one changed line each. `git grep` searches tracked
files only, which is the scope that matters — no `node_modules`, no `dist`, and no
hand-maintained list of extensions to keep in step with the repo. The `:!.claude`
excludes this skill, which cites real version numbers as examples and would
otherwise report itself as a stray hardcoding on every release.

The grep should come back empty. If it doesn't, see "What carries the version"
above: something has hardcoded a version that shouldn't. Fix it, but commit that
fix separately — step 5 keeps the release commit to the four manifests.

### 5. Commit

Stage the four manifests by name rather than with `git commit -a`, so the
release commit stays a pure version bump even if something else is sitting in the
working tree:

```sh
git add packages/core/package.json packages/x402/package.json \
        packages/cli/package.json packages/circle/package.json
git commit -m "chore: release vX.Y.Z"
```

Subject only, no body — that's the established shape (`chore: release v0.0.4`).
The `v` prefix matches the most recent release; earlier ones omitted it, so
follow the newer form.

The husky `pre-commit` hook runs the full CI gate here — `pnpm lint`, `pnpm
build`, `pnpm -r run check-types`, `pnpm -r run test`. It takes a couple of
minutes. **Let it run; never reach for `--no-verify`.** The release workflow
re-runs build, check-types, and test before publishing — but deliberately *not*
lint, since a formatting nit can't make a tarball wrong. So this hook is the only
gate lint ever passes through on a release: bypass it and a lint failure publishes
silently, then turns up on the CI run after the push, when the version is already
permanent.

### 6. Tag

```sh
git tag vX.Y.Z
```

Lightweight, on the release commit — that's what `v0.0.2` through `v0.0.4` are.
(`v0.0.1` is annotated; it was the first release and is not the pattern to copy.)

### 7. Stop and hand back the push

Do not push. Print the commands and let the user run them, because this is the
irreversible step and it is theirs to take:

```sh
git push origin main
git push origin vX.Y.Z    # this publishes to npm
```

Tell them plainly that the second command is what publishes, and that they can
watch it at the repo's Actions tab. Pushing the branch without the tag is safe
and publishes nothing.

## Releasing a package for the first time

A package that has never been published is the one case this flow does not carry
end to end. Releases authenticate by trusted publishing, which npm configures
**per package**, from that package's settings page — and a package with no
versions has no settings page. `v0.0.6` proved it: the new name failed with
`404 Not Found - PUT …/@usehaia%2ftrace-circle`, npm's way of saying the
credential is not valid for a package that does not exist.

**And the run does not carry on past it.** `pnpm -r publish` works in dependency
order and stops at the first failure, so a new package in the middle of the
graph strands everything downstream: `v0.0.6` published `trace-core`, failed on
`trace-circle`, and never reached `trace-x402` or `trace-cli` — a half-applied
release whose published half is permanent.

So check *before* cutting the tag, never after: `npm view <name> version` on
every publishable package. If any name is missing, get it created on npm and its
trusted publisher registered first — a release is not the place to find out.

Recovering from a half-applied release is not a re-tag: `pnpm -r publish`
publishes only versions the registry does not have, so once the missing name
exists, re-running the same failed workflow finishes the release and skips what
already went out.

## If something goes wrong

- **Checks fail at commit time** — the bump is still in the working tree. Fix the
  failure, commit the fix as its own non-release commit, then re-run the release
  commit. Don't fold a fix into the release commit; it should stay a pure version
  bump so it reads clearly in `git log`.
- **Wrong version tagged, not yet pushed** — `git tag -d vX.Y.Z`, amend or reset
  the commit, redo. Nothing has escaped.
- **The bump script reports that the packages disagree** — either a write failed
  partway through its files, or a previous release was half-applied. Nothing
  is committed at that point, so `git checkout -- packages` returns you to a clean
  state; then look at why before re-running.
- **Tag already pushed** — the publish has likely already run. Deleting the tag
  does not unpublish; npm versions are immutable. The fix is to release the next
  patch, and to say so clearly rather than trying to paper over it.
