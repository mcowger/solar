# Changelog

All notable changes to Solar are documented here, newest first.

Solar releases use CalVer tags (`YYYY.MM.DD`, with an optional `.N` same-day
counter). Add each user-visible change under the UTC date it lands, grouped
under `Added`, `Changed`, or `Fixed`. Pushing a release tag publishes a Docker
image and creates GitHub release notes from changelog sections newer than the
previous release.

## [2026-10-20]

### Added

- A model sync now reports presets and personal default models that no longer resolve to a model, in the provider's sync status.

### Fixed

- New Chat no longer fails silently when a preset's model has been removed: the chat starts with the default model, says which preset it skipped, and other failures show an error instead of doing nothing.
- Presets whose model is gone stay listed and editable, marked as unavailable, so they can be pointed at a new model. Saving, deleting and starring a preset now report failures instead of appearing to do nothing.
- "New chat from preset" disables presets with an unavailable model instead of offering an entry that always fails.

## [2026-10-16]

### Added

- Paseo can now run the production deployment command.

### Changed

- Solar releases now publish a versioned Docker image to GHCR and generate GitHub release notes from this changelog.
