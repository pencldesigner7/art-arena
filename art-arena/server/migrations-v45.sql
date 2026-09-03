
-- =====================================================================
-- ART ARENA — v44/v45 REPAIR + MIGRATION SCRIPT (manual run)
-- =====================================================================
-- The same steps the server runs at boot (server.js MIGRATION_STEPS), for
-- managed databases where the app's role may lack DDL permissions. Every
-- step is idempotent — the script can be re-run safely.
--
-- PRODUCTION INCIDENT this repairs: on databases with pre-v44 data, the
-- one-active-seat unique index could not be created (users legally held
-- several seats; orphaned seat rows existed), which aborted the WHOLE v44
-- migration block — including ALTER TABLE battle_rooms ADD deleted_at —
-- and every "column r.deleted_at does not exist" error followed.
--
-- Safe: repairs duplicate/orphaned SEATS only (they become 'left'); rooms,
-- battles, results, history and users are never deleted or rewritten.
-- Run as the database owner, e.g.:
--   psql "$DATABASE_URL" -f migrations-v45.sql
-- =====================================================================

BEGIN;

-- 1. sweep orphaned seats/spectators (point at rooms that no longer exist)
DELETE FROM room_participants rp
 WHERE NOT EXISTS (SELECT 1 FROM battle_rooms r WHERE r.id = rp.room_id);
DELETE FROM room_spectators rs
 WHERE NOT EXISTS (SELECT 1 FROM battle_rooms r WHERE r.id = rs.room_id);

-- 2. de-duplicate active seats: each user keeps exactly ONE waiting/ready
--    seat (their most-live room); the rest become 'left'
WITH ranked AS (
  SELECT rp.ctid AS ctid,
         row_number() OVER (
           PARTITION BY rp.user_id
           ORDER BY (CASE r.status WHEN 'in_battle' THEN 3 WHEN 'starting' THEN 2
                                   WHEN 'lobby' THEN 1 ELSE 0 END) DESC,
                    rp.joined_at DESC NULLS LAST,
                    r.created_at DESC NULLS LAST
         ) AS rn
    FROM room_participants rp
    LEFT JOIN battle_rooms r ON r.id = rp.room_id
   WHERE rp.state IN ('waiting','ready'))
UPDATE room_participants SET state = 'left', left_at = now()
 WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1);

-- 3. schema objects (all IF NOT EXISTS / guarded)
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'battle_rooms'::regclass AND contype = 'p') THEN
    ALTER TABLE battle_rooms ADD CONSTRAINT battle_rooms_pkey PRIMARY KEY (id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_battle_rooms_code ON battle_rooms (code);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'users'::regclass AND contype = 'p') THEN
    ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rematch_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES battle_rooms(id) ON DELETE CASCADE,
    from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz
);

-- 4. duplicate data guards, then the matching unique indexes
DELETE FROM battle_challenge_elements bce
 USING battle_challenges bc
 WHERE bce.challenge_id = bc.id
   AND bc.ctid NOT IN (SELECT DISTINCT ON (battle_id) ctid
                         FROM battle_challenges ORDER BY battle_id, generated_at);
DELETE FROM battle_challenges bc
 WHERE bc.ctid NOT IN (SELECT DISTINCT ON (battle_id) ctid
                         FROM battle_challenges ORDER BY battle_id, generated_at);
DELETE FROM battle_results br
 WHERE br.ctid NOT IN (SELECT DISTINCT ON (battle_id) ctid
                        FROM battle_results ORDER BY battle_id, decided_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rematch_pending_per_room
  ON rematch_requests (room_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_challenge_per_battle
  ON battle_challenges (battle_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_randomizer_element_name
  ON randomizer_elements (category, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_result_per_battle
  ON battle_results (battle_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_seat_per_user
  ON room_participants (user_id) WHERE state IN ('waiting','ready');

COMMIT;

-- verification (expect six t's)
SELECT EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name='battle_rooms' AND column_name='deleted_at') AS deleted_at,
       EXISTS(SELECT 1 FROM information_schema.tables
               WHERE table_name='rematch_requests') AS rematch_table,
       EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_one_active_seat_per_user') AS seat_guard,
       EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_one_challenge_per_battle') AS challenge_guard,
       EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_one_result_per_battle') AS result_guard,
       EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_randomizer_element_name') AS pool_guard;
