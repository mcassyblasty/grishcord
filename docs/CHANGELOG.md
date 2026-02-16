# Changelog

All notable changes to Grishcord are documented in this file.

The format is inspired by Keep a Changelog and follows semantic-ish version tags maintained in the top-level `VERSION` file.

## [0.3.4] - 2026-02-16
### Changed
- Simplified login screen secondary actions into a single dropdown selector beneath login, with register/recovery forms shown contextually.
- Kept the login-first visual motif while reducing clutter from multiple standalone secondary buttons.

## [0.3.3] - 2026-02-16
### Fixed
- Frontend interactivity bug where login/register/recovery/settings buttons appeared non-functional in production due to inline script being blocked by the reverse-proxy CSP (`script-src 'self'`).
- Moved frontend logic into `frontend/app.js` and loaded it as a same-origin script so handlers execute correctly.
- Removed confusing empty auth notice box by hiding it until there is real success/error text.

### Changed
- Expanded canonical spec change-history section to reference changelog usage and current release progression.

## [0.3.2] - 2026-02-16
### Changed
- Fixed login session behavior for LAN/non-TLS usage by only setting a secure auth cookie when the request is actually HTTPS, preventing silent post-login session loss on HTTP.
- Improved auth error UX with explicit wrong-password messaging and visible success/error notice states.
- Polished login screen actions (login/register/recovery buttons) and added clearer visual hierarchy.
- Added a post-login empty-state home view in chat when there are no messages yet.

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
