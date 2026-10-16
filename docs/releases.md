# Releases

Solar releases use CalVer tags: `YYYY.MM.DD`, with `.N` for another release on the same day. Tags have no `v` prefix.

A pushed tag runs CI, publishes a Linux/amd64 Docker image to GHCR as both `:<tag>` and `:latest`, then creates a GitHub release. The release notes are generated from `CHANGELOG.md`, including every dated section newer than the previous release. CI and Docker publishing must pass before the GitHub release is created.

## Before a release

Add a user-facing entry to `CHANGELOG.md` in the same change, under the UTC date it lands. Group entries under `Added`, `Changed`, or `Fixed`. Keep entries short and describe the behavior users see. Don't add `Unreleased` or version-number headings.

Preview today's release notes:

```sh
bun run release:preview
```

Or pass a tag explicitly:

```sh
bun run release:preview -- 2026.10.16
```

## Cut a release

Release from a clean, up-to-date `main` branch after CI passes:

```sh
bun run release:cut
```

Or pass a tag explicitly:

```sh
bun run release:cut -- 2026.10.16
```

The command checks the tag format and date, clean working tree, current branch, sync with `origin/main`, tag uniqueness, and a changelog heading. It prints the generated notes and asks for confirmation before creating and pushing an annotated tag. Follow the Actions run and verify the GHCR image and GitHub release were created.

The image name is `ghcr.io/<owner>/solar`. For public Docker pulls, set the GHCR package visibility to Public after its first publish. Use a pinned image in deployment config, such as `ghcr.io/<owner>/solar:2026.10.16`; `:latest` is convenient but mutable.

## Same-day releases and corrections

Use `.1`, `.2`, and so on for same-day follow-ups. Add the fix to that day's changelog section before cutting the tag. Changelog notes are date-based, so same-day releases can repeat that date's section.

Don't move or overwrite a published tag, and don't hand-edit a GitHub release's notes. Fix forward on `main` and publish the next tag. If a tag is wrong before the workflow starts, delete it locally and remotely, then re-cut it from the correct commit.

## Linux x64 executable

A Bun `--compile` build succeeds, but Solar isn't currently a standalone executable. The production bundle leaves `@struktoai/mirage-node` external, and the server starts the pi CLI as a child process from its installed package files. A compiled executable alone fails to resolve Mirage at startup. Shipping a working release would require an archive with the executable and its runtime package tree, then a Linux x64 smoke test. The current release publishes the Docker image only; don't treat an untested binary as a supported artifact.
