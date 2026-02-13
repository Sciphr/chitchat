-- ChitChat Database Schema (SQLite)
-- This is a reference file. The server auto-creates the database on first run.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  about TEXT,
  push_to_talk_enabled INTEGER DEFAULT 0,
  push_to_talk_key TEXT DEFAULT 'Space',
  audio_input_id TEXT,
  video_input_id TEXT,
  audio_output_id TEXT,
  activity_game TEXT,
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'dnd')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
  created_by TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now')),
  category_id TEXT REFERENCES room_categories(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_temporary INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS room_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  enforce_type_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS friends (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS user_room_notification_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('all', 'mentions', 'mute')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);
CREATE INDEX IF NOT EXISTS idx_user_room_notification_prefs_user_id ON user_room_notification_prefs(user_id);
CREATE INDEX IF NOT EXISTS idx_room_categories_position ON room_categories(position);

-- Default rooms
INSERT OR IGNORE INTO rooms (id, name, type, created_by) VALUES ('general', 'general', 'text', 'system');
INSERT OR IGNORE INTO rooms (id, name, type, created_by) VALUES ('random', 'random', 'text', 'system');
INSERT OR IGNORE INTO rooms (id, name, type, created_by) VALUES ('voice-lobby', 'Lobby', 'voice', 'system');
INSERT OR IGNORE INTO room_categories (id, name, position, enforce_type_order) VALUES ('default', 'Channels', 0, 1);
UPDATE rooms SET category_id = 'default' WHERE type != 'dm' AND is_temporary = 0 AND (category_id IS NULL OR category_id = '');
