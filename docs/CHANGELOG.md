# Changelog

All notable changes to Grishcord are documented in this file.

The format is inspired by Keep a Changelog and follows semantic-ish version tags maintained in the top-level `VERSION` file.

## [0.3.46] - 2026-02-26
### Fixed
- Edit-mode attachment chips no longer display raw upload database IDs (e.g., `#5`) for single-file messages; labels now show user-friendly attachment names (`Attached image` / `Attached file`) and only include sequence numbers when multiple attachments exist.

## [0.3.45] - 2026-02-26
### Fixed
- Message edit attachments now support both image and `.zip` files: users can remove existing attachments from an already-sent message and add new allowed files before saving edits.
- Edit attachment chips now label existing attachments as image/file for clearer remove behavior while editing.

## [0.3.44] - 2026-02-25
### Fixed
- `grishcordctl.sh update-start` now updates source code before rebuilding: it performs `git pull --ff-only` for git checkouts, or uses installer metadata to re-download archives for wget/curl installs.
- Installer now writes `.grishcord-install.env` (method/repo/archive metadata) so update workflows can be automated consistently.

## [0.3.43] - 2026-02-25
### Changed
- Added support for `.zip` file uploads up to 100MB (`MAX_UPLOAD_BYTES`), alongside existing image attachments.
- Composer attachment picker now accepts image files and `.zip` files.
- Message rendering now shows non-image attachments as downloadable links.

## [0.3.42] - 2026-02-25
### Changed
- Message edit flow now supports attachment management: users can remove already attached images and add new images while editing, then save all changes together.

### Fixed
- Exiting the reply banner via its cancel button now returns input focus to the bottom composer.
- Exiting message edit mode (Save/Cancel/Escape) now returns focus to the bottom composer for faster follow-up sending.

## [0.3.41] - 2026-02-25
### Fixed
- Prevented Compose backend startup misconfiguration by defaulting backend `DATABASE_URL` to use service host `postgres` when the env var is unset.
- Added a backend startup guardrail that detects container runtime + localhost DB host and emits a clear error explaining to use `postgres` instead.
- Updated env/docs guidance to avoid `ECONNREFUSED 127.0.0.1:5432` migration failures when Postgres is healthy in another container.

## [0.3.40] - 2026-02-25
### Changed
- Added a top-level interactive installer script `install_grishcord.sh` that can run from anywhere and supports install via `git`, `wget`, or `curl`.
- If `git` is chosen and git identity is missing, the installer now prompts through configuring global git `user.name` and `user.email`.

## [0.3.39] - 2026-02-25
### Changed
- Improved `grishcordctl` lifecycle efficiency and reliability with optional Compose `--wait` support, terminal-state detection during readiness polling, and post-start HTTP endpoint verification.
- Added `grishcordctl restart` and `grishcordctl doctor` commands for faster operational workflows and diagnostics.
- Updated `run_grishcord.sh` to pass through an optional command (default `start`) to `grishcordctl`.

## [0.3.38] - 2026-02-20
### Fixed
- Enabling Admin Mode now immediately refreshes full admin state so hidden/archived channels are available for inline sidebar re-enable toggles without needing to reopen Admin Settings.

## [0.3.37] - 2026-02-17
### Changed
- In Admin Mode, the sidebar now renders the full channel inventory (including hidden/archived channels) for both text and voice sections.
- Added per-channel inline `On`/`Off` buttons in Admin Mode to quickly toggle channel visibility without opening the three-dot menu.

## [0.3.36] - 2026-02-17
### Security
- Added authentication endpoint rate limiting for login, registration, and recovery redeem/reset flows, returning HTTP 429 with `Retry-After`.
- Replaced permissive CORS reflection with allowlist-based origin validation (`CORS_ORIGINS`, plus `PUBLIC_BASE_URL` origin).
- Added same-origin enforcement for state-changing API requests (`POST/PATCH/PUT/DELETE`) using Origin/Referer host checks to reduce CSRF risk.

## [0.3.35] - 2026-02-17
### Fixed
- Replying to a message now behaves like a ping for the replied user: reply targets receive persistent notifications and incoming reply messages are visually highlighted like mentions.
- Reply-triggered notifications now participate in existing notification-sound playback, so replied users hear the same alert used for pings/DMs.

## [0.3.34] - 2026-02-17
### Changed
- Simplified delegated roles back to admin-only controls in Admin Settings: removed moderator role toggles and role API usage from the Users panel.
- Added a global `Enable voice channels` admin setting and wired channel loading to hide all voice channels when disabled.
- Improved Admin Users layout and channel action-menu anchoring/alignment to reduce UI chaos and make three-dot channel actions reliably clickable.

### Fixed
- Message edits now persist and display an `(edited)` marker, including after reloads.
- Channel/message moderation checks now align with admin-only permissions (plus immutable primary admin) instead of moderator delegation.

## [0.3.33] - 2026-02-17
### Changed
- Removed `scripts/fix_everything.sh` and replaced operations flow with a new verbose `scripts/grishcordctl.sh` command interface.
- Added `grishcordctl` commands: `start`, `stop`, `update-start`, `status`, and `logs`.
- `grishcordctl` now prints continuous elapsed-time progress during long-running operations and service readiness waits to avoid appearing frozen.
- `scripts/run_grishcord.sh` is now a compatibility wrapper that delegates to `grishcordctl start`.

## [0.3.32] - 2026-02-17
### Changed
- Reordered Admin Settings cards to: Admin Mode, Create Invite Key, Generate Recovery Key, Anti-Spam/Bitrate, Users, then Invites export.
- Replaced inline invite-history rendering with CSV export (`Download Invites CSV`) in Admin Settings.
- Added role escalation controls for both `moderator` and `admin` in the Users section.

### Fixed
- Message moderation delete permission now accepts moderators as well as admins/primary admin.

## [0.3.31] - 2026-02-17
### Fixed
- Added a built-in Web Audio fallback notification tone so DM/ping sounds still work even when no WAV files are present in `frontend/audio/`.
- Notification sound playback now degrades gracefully when asset files are unavailable or blocked by browser playback behavior.

## [0.3.30] - 2026-02-17
### Changed
- Added account-scoped notification-sound preference with a Notifications menu toggle (`Sounds: On/Off`) that persists across devices.

### Fixed
- Sound playback now respects the persisted account preference and defaults to enabled for users who have never changed the setting.

## [0.3.29] - 2026-02-17
### Changed
- Added frontend sound integration for notification WAV assets under `frontend/audio/` with resilient filename fallback loading.

### Fixed
- Incoming ping/DM websocket notifications now trigger the message-received sound so users hear alerts when mentioned or messaged.

## [0.3.28] - 2026-02-17
### Changed
- Admin access now supports multiple admins: the primary hard-coded admin remains authoritative, and additional admins can be toggled from Admin Settings with an `is admin` checkbox per user.
- Replaced blocking browser `alert/confirm/prompt` flows in the app shell with themed non-blocking toasts and modal prompts for message/channel/admin actions.
- Voice WebRTC setup now loads ICE server configuration from the backend (`/api/voice/config`) so deployments can provide TURN/STUN without client code edits.

### Fixed
- Notifications are now persistent across refresh/session reconnects via backend-backed notification records instead of in-memory-only state.
- Clicking a notification now consumes it server-side and performs a stronger jump-to-message flow using a message-lookup API before focusing the target message.
- Admin moderation checks are now unified so delegated admins can use moderation actions consistently with backend authorization.

## [0.3.27] - 2026-02-17
### Changed
- Message editing now uses inline in-message edit mode (textarea with Save/Cancel, Enter-to-save and Escape-to-cancel) instead of browser prompt dialogs for a Discord-like workflow.

### Fixed
- Navigation now places focus into the primary input for that area (server/DM composer, DM search when no DM selected, account display-name input when opening Settings, login username on auth view).

## [0.3.26] - 2026-02-17
### Fixed
- DM switch behavior on mobile now keeps the DM list open so users can choose a conversation instead of immediately collapsing the sidebar.
- DM view now supports an explicit landing state when no DM peer is selected, with clear guidance to select a conversation before messaging.
- Refined DM search input styling/alignment in the sidebar to ensure consistent width/text-box presentation.

## [0.3.25] - 2026-02-17
### Fixed
- Stabilized inline sidebar channel administration: drag-to-reorder now uses an explicit drag handle to avoid interfering with normal channel clicks.
- Hardened inline channel action menu opening behavior to prevent async event noise when opening three-dot controls.

## [0.3.24] - 2026-02-17
### Changed
- Channel administration is now inline in the server sidebar when Admin Mode is enabled: add buttons appear next to Text/Voice headers, per-channel three-dot action menus are available on each row, and drag-and-drop reorder is supported for text and voice lists.
- Deprecated the old modal-based channel editor card in favor of in-context sidebar controls for admin channel management.

## [0.3.23] - 2026-02-16
### Fixed
- Composer placeholder text is now mobile-aware: portrait/mobile views show the shorter `Plain-text message` prompt instead of desktop keyboard guidance text.
- Composer placeholder now re-evaluates on viewport resize while remaining compatible with mode-specific placeholders (e.g., voice-disabled state).

## [0.3.22] - 2026-02-16
### Fixed
- Portrait mobile layout was reworked for better usability: top bar now uses explicit left/right groups with improved truncation/compact controls, and the app shell uses flex-based sizing for more reliable viewport behavior.
- Mobile sidebar overlay now anchors to the app pane in portrait instead of fixed viewport offsets, improving consistency across mobile browser chrome sizes.
- Additional portrait-specific spacing refinements were applied to chat header/messages/composer for improved readability and interaction.

## [0.3.21] - 2026-02-16
### Fixed
- Clicking a notification now consumes/removes that notification entry from the notifications list after navigation.
- Mobile composer input height is now constrained to match the action-button row height for improved usability on narrow screens.
- Top-bar mobile responsiveness improved so notification/settings controls fit better in constrained widths.
- Voice channel section header/spacer now hide automatically when no voice channels are available.

## [0.3.20] - 2026-02-16
### Added
- Added a top-right Notifications menu (next to Settings) that tracks recent DM and mention activity and supports one-click navigation to the referenced message context.
- Added notification items with message preview + timestamp, and click-through navigation that jumps to/highlights the exact message in channel/DM history.

### Changed
- DM list entries now render with each user's configured display color for better visual identity consistency with message timelines.

## [0.3.19] - 2026-02-16
### Added
- Mention support in composer and timeline: typing `@username`/`@displayName` now pings users, and `Tab` autocomplete completes mention handles from indexed user identities.
- DM sidebar now includes a dedicated search field for quickly filtering direct-message peers by username or display name.

### Changed
- Messages that mention the current user are now visually highlighted for that recipient, making pings easier to notice in busy channels/DMs.

## [0.3.18] - 2026-02-16
### Fixed
- Improved mobile layout behavior so the top bar/settings control and bottom composer remain visible and usable across narrow/tall aspect ratios, with a more reliable slide-out sidebar overlay behavior.
- Message action controls (reply/edit/delete) are now compact and positioned at the top-right of each message card for cleaner, less intrusive interaction.
- Voice-room join/leave behavior is now more robust: voice channel buttons reflect current state (Join vs Leave), leaving a room resets navigation cleanly, and join errors now report actionable microphone availability/permission issues.

## [0.3.17] - 2026-02-16
### Added
- New user registrations now receive a randomly generated display-name color automatically, so accounts start with distinct identity coloring without admin/user setup.

### Changed
- Refined shared control styling to better match the app theme, including improved dark-mode select/dropdown rendering and clearer disabled/ghost button readability.

## [0.3.16] - 2026-02-16
### Fixed
- Eliminated Docker Compose APP_VERSION warning by removing the unset-required compose env reference and mounting `./VERSION` into backend at `/app/VERSION`.
- Runtime version reporting is now robust: empty/unset `APP_VERSION` falls back to `VERSION` file with startup source logging (`env`, `file:*`, or fallback).
- Voice join no longer throws on environments without `navigator.mediaDevices.getUserMedia`; it now enters a safe listen-only fallback.
- Mobile composer visibility and sidebar-close behavior improved for narrow layouts.

### Added
- Clipboard/file image attachment workflow in composer (paste image or `+` picker) with removable pending preview before send.
- Message image rendering with normalized in-chat sizing and full-resolution centered lightbox on click.
- Message reply/edit/delete interactions (Discord-like flow): reply for all, edit for own, delete for own (admin moderation retained in admin mode).
- Admin channel visibility controls (Hide/Unhide) in channel editor.

## [0.3.15] - 2026-02-16
### Fixed
- DM rendering now applies strict conversation matching in realtime and history paths using explicit DM participant metadata, preventing cross-conversation visibility.
- Voice join no longer crashes on browsers/origins where `getUserMedia` is unavailable; app falls back to listen-only join with a clear status note.
- Mobile layout now keeps the composer visible more reliably in narrow viewports and closes the sidebar when selecting navigation targets or clicking outside.

### Added
- Message actions: reply (all users), edit (own messages), and delete (own messages; admin can also moderate while Admin Mode is enabled).
- Reply threading support with quoted preview and reply target context in composer.
- Admin channel visibility toggle (Hide/Unhide) in channel editor for instant channel visibility control.

## [0.3.14] - 2026-02-16
### Fixed
- DM realtime filtering now enforces true two-party DM visibility using explicit participant IDs, preventing non-participant users from seeing another pair's DM messages.
- Mobile/sidebar behavior improved: on narrow layouts, clicking outside the opened sidebar now closes it immediately.

### Added
- User account settings in the main settings menu now support self-service display-name updates.
- User account settings now include display-color selection (color picker + hex input) and message author labels render with the chosen color.

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
