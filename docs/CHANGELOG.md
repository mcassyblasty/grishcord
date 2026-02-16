# Changelog

All notable changes to Grishcord are documented in this file.

The format is inspired by Keep a Changelog and follows semantic-ish version tags maintained in the top-level `VERSION` file.

## [0.3.13] - 2026-02-16
### Added
- Added admin user-deletion flow in Admin Settings with strong verification: exact case-sensitive username re-entry plus explicit confirmation checkbox before delete is allowed.

### Changed
- Admin user list now supports freeze/unfreeze and delete actions in one panel.

### Fixed
- Deleting a user now cleans up related rows safely (messages, uploads, invite references) and notifies connected clients.

## [0.3.12] - 2026-02-16
### Fixed
- Top-bar app version now resolves reliably in containerized runtime by checking multiple VERSION file paths (including `/app/VERSION`) instead of a single parent-path assumption.
- Multiline messages now preserve newlines exactly as typed (`Shift+Enter`): composer sends raw textarea content and timeline rendering uses `white-space: pre-wrap` so line breaks are visible.

## [0.3.11] - 2026-02-16
### Added
- Added admin channel-management APIs and UI for channel editor workflows: create text/voice channels, rename channels, reorder channels, and archive channels from Admin Settings.
- Added explicit Admin Mode toggle in Admin Settings; message delete controls are now shown only when Admin Mode is enabled.

### Changed
- Sidebar now renders voice channels dynamically from backend channel data instead of fixed lobby buttons.
- DM list refresh is now proactive (WebSocket-triggered + periodic polling) to surface new DM peers quickly without requiring a manual page reload.

## [0.3.10] - 2026-02-16
### Fixed
- Logout now immediately invalidates the active session server-side by incrementing `session_version` during `/api/logout`, preventing reuse of an existing cookie token.
- Cookie clearing now uses consistent cookie attributes (`httpOnly`, `sameSite=lax`, `secure` on HTTPS, `path=/`) so browser logout reliably removes the auth cookie.

## [0.3.9] - 2026-02-16
### Added
- Implemented real in-browser voice transmission for `lobby-a` and `lobby-b` using WebRTC audio with WebSocket signaling (join/leave, mute/unmute, peer connect/disconnect status).
- Added admin message deletion support (`DELETE /api/messages/:id`) and wired delete controls in the message timeline for the admin account.

### Changed
- Composer now supports multiline drafting: `Shift+Enter` inserts a newline, while plain `Enter` sends.
- Simplified invite generation UI to a single "Generate" action with default server-side TTL (removed confusing numeric TTL input).
- Fixed DM timeline targeting logic so both directions of a DM conversation are loaded reliably.

## [0.3.8] - 2026-02-16
### Changed
- Moved `DMs` button above `Server` in the sidebar quick-switch row.
- Invite and recovery generation now returns and displays raw shareable keys directly in admin UI (with optional URL preview), matching key-first invite/recovery workflows.
- Added an embedded living release-summary subsection in `docs/GRISHCORD_SPEC.tex` to keep LaTeX spec changelog visibility current.

## [0.3.7] - 2026-02-16
### Changed
- Sidebar now lands on the server view with a compact `DMs` button to switch contexts instead of listing DMs above channels by default.
- DMs list now appears in its own view and is sorted by most recent conversation activity (newest first).
- Added a dedicated `VOICE CHANNELS` section under text channels with lobby buttons (`lobby-a`, `lobby-b`).

## [0.3.6] - 2026-02-16
### Changed
- Reworked left sidebar structure to be Discord-like sectioned navigation: static headings for `DIRECT MESSAGES` and `TEXT CHANNELS` instead of mode-switch buttons.
- Kept channels and DMs as clickable list rows under their own headings so context switching feels familiar to Discord users.

## [0.3.5] - 2026-02-16
### Fixed
- Repaired broken admin invite and recovery SQL interval syntax that caused backend errors in admin actions.
- Added channel-scoped and DM-scoped message fetching/sending paths so compose actions target a concrete destination.

### Changed
- Sidebar channel items are now real buttons that switch the active channel context.
- Added a DMs navigation button with a DM list and direct-message context switching.
- Moved admin controls from always-visible panel to an admin-only pop-out opened from Settings.
- Eliminated minor viewport jitter by constraining app layout to full-height non-scrolling shell.

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
