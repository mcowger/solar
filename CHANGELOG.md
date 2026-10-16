# Changelog

All notable changes to Solar are documented here, newest first.

Solar releases use CalVer tags (`YYYY.MM.DD`, with an optional `.N` same-day
counter). Add each user-visible change under the UTC date it lands, grouped
under `Added`, `Changed`, or `Fixed`. Pushing a release tag publishes a Docker
image and creates GitHub release notes from changelog sections newer than the
previous release.

## [2026-10-16]

### Changed

- Solar releases now publish a versioned Docker image to GHCR and generate GitHub release notes from this changelog.
