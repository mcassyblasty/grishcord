CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

INSERT INTO app_settings(key, value)
VALUES ('anti_spam_level', '5'::jsonb), ('voice_bitrate', '32000'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  display_name text NOT NULL,
  display_color text,
  password_hash text NOT NULL,
  session_version integer NOT NULL DEFAULT 1,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_color text;

CREATE TABLE IF NOT EXISTS invites (
  id bigserial PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  used_by bigint REFERENCES users(id),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_tokens (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  clicked_at timestamptz,
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  position integer NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('text', 'voice'));

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  author_id bigint NOT NULL REFERENCES users(id),
  channel_id bigint REFERENCES channels(id),
  dm_peer_id bigint REFERENCES users(id),
  reply_to bigint REFERENCES messages(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(body) <= 10000)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to bigint REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS uploads (
  id bigserial PRIMARY KEY,
  storage_name text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  owner_id bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_uploads (
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  upload_id bigint REFERENCES uploads(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, upload_id)
);
