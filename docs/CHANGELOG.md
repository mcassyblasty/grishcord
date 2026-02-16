# Changelog

All notable changes to Grishcord are documented in this file.

The format is inspired by Keep a Changelog and follows semantic-ish version tags maintained in the top-level `VERSION` file.

## [0.3.1] - 2026-02-16
### Changed
- Reworked authentication UX to a login-first screen with register and recovery hidden behind explicit toggle menus instead of being always visible.
- Added explicit login/register/recovery status handling and busy states so auth actions provide immediate feedback.
- Moved theme control into an authenticated settings menu and removed the always-visible top-left theme toggle.

## [0.3.0] - 2026-02-16
### Added
- Introduced explicit repository version tracking via top-level `VERSION`.
- Added backend version endpoint `GET /api/version` and included version in `/health` output.
- Added UI version display in the top navigation so operators can confirm the deployed build quickly.
- Added `docs/CHANGELOG.md` as canonical human-readable version history.

## [0.2.0] - 2026-02-16
### Added
- Interactive frontend with login, registration via invite token, recovery redemption/reset, messaging, responsive layout, and theme toggle.
- Admin panel UI for invite generation/revocation, recovery link generation, user enable/disable, anti-spam level selection, and voice bitrate configuration.
- Backend admin endpoints for state retrieval, invite revoke, user disable/enable, and settings updates.

## [0.1.0] - 2026-02-16
### Added
- Initial Grishcord bootstrap: docker-compose topology, backend scaffold, frontend scaffold, Caddy config, migrations, docs, and infra templates.
- Deterministic operations scripts and deployment hardening (`scripts/fix_everything.sh`, `scripts/run_grishcord.sh`, healthchecks, deterministic compose project usage).
