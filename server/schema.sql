-- Art Arena — first-boot schema bootstrap (v44)
-- Pure DDL + STATIC PLATFORM ROWS ONLY (randomizer categories + drawing
-- apps). Contains NO user data, no sessions, no tokens, no passwords.
-- Used by entrypoint.sh when the database is empty; the randomizer word
-- pool (10,467 elements) is seeded by the app itself from
-- server/randomizer_seed.json on startup (see server/seed.js).
-- Generated 2026-09-03 from the live schema (PostgreSQL 17).

--
-- PostgreSQL database dump
--

\restrict cucxbxNgIcbHXao7HeUObCXiGdoa3x8avnMtwujjO25SRoabFDI4fcEmmAo18N0

-- Dumped from database version 17.11 (Debian 17.11-0+deb13u1)
-- Dumped by pg_dump version 17.11 (Debian 17.11-0+deb13u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: auth_token_purpose; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.auth_token_purpose AS ENUM (
    'email_verification',
    'password_reset',
    'oauth_handoff'
);


--
-- Name: battle_format; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.battle_format AS ENUM (
    'one_on_one',
    'multi'
);


--
-- Name: battle_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.battle_status AS ENUM (
    'waiting',
    'ready',
    'locked',
    'randomizing',
    'challenge_locked',
    'countdown',
    'active',
    'time_expired',
    'submitting',
    'submission_locked',
    'judging',
    'result',
    'complete',
    'forfeited',
    'cancelled',
    'disqualified'
);


--
-- Name: cheat_flag; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cheat_flag AS ENUM (
    'normal',
    'flagged',
    'under_review'
);


--
-- Name: competition_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.competition_type AS ENUM (
    'casual',
    'friendly',
    'quick_match',
    'tournament',
    'grand_arena'
);


--
-- Name: dispute_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_status AS ENUM (
    'open',
    'under_review',
    'resolved',
    'dismissed'
);


--
-- Name: dispute_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_type AS ENUM (
    'connection',
    'submission',
    'suspected_cheating',
    'technical',
    'other'
);


--
-- Name: elimination_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.elimination_status AS ENUM (
    'active',
    'eliminated',
    'disqualified',
    'withdrawn'
);


--
-- Name: event_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_status AS ENUM (
    'announced',
    'registration_open',
    'bracket',
    'in_progress',
    'completed',
    'cancelled'
);


--
-- Name: granted_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.granted_role AS ENUM (
    'admin',
    'judge',
    'moderator'
);


--
-- Name: match_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.match_status AS ENUM (
    'pending',
    'live',
    'completed',
    'forfeited'
);


--
-- Name: mm_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mm_status AS ENUM (
    'queued',
    'matched',
    'expired',
    'cancelled'
);


--
-- Name: notification_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_type AS ENUM (
    'battle_invitation',
    'battle_accepted',
    'battle_starting',
    'challenge_generated',
    'battle_result',
    'room_invitation',
    'tournament_reminder',
    'new_follower',
    'message',
    'livestream_start',
    'achievement',
    'dispute_update'
);


--
-- Name: participant_outcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.participant_outcome AS ENUM (
    'win',
    'loss',
    'draw',
    'forfeit',
    'disqualified',
    'eliminated',
    'not_started'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'pending',
    'confirmed',
    'failed',
    'refunded'
);


--
-- Name: platform_name; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.platform_name AS ENUM (
    'youtube',
    'twitch',
    'google',
    'discord'
);


--
-- Name: post_visibility; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.post_visibility AS ENUM (
    'public',
    'unlisted',
    'private'
);


--
-- Name: report_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_status AS ENUM (
    'open',
    'in_review',
    'action_taken',
    'dismissed'
);


--
-- Name: result_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.result_method AS ENUM (
    'voting_community',
    'voting_player',
    'judging_official',
    'host_decision',
    'forfeit',
    'none'
);


--
-- Name: room_participant_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.room_participant_state AS ENUM (
    'waiting',
    'ready',
    'disconnected',
    'left'
);


--
-- Name: room_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.room_status AS ENUM (
    'lobby',
    'starting',
    'in_battle',
    'ended'
);


--
-- Name: room_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.room_type AS ENUM (
    'casual',
    'quick_match',
    'tournament',
    'grand_arena'
);


--
-- Name: room_visibility; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.room_visibility AS ENUM (
    'public',
    'private',
    'password'
);


--
-- Name: stream_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.stream_status AS ENUM (
    'scheduled',
    'live',
    'ended',
    'removed'
);


--
-- Name: submission_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.submission_source AS ENUM (
    'auto_integration',
    'share_sheet',
    'manual_upload',
    'admin'
);


--
-- Name: submission_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.submission_status AS ENUM (
    'submitted',
    'processing',
    'accepted',
    'rejected',
    'locked'
);


--
-- Name: submission_verification; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.submission_verification AS ENUM (
    'verified',
    'standard',
    'manual_review'
);


--
-- Name: user_account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_account_status AS ENUM (
    'active',
    'suspended',
    'banned',
    'deactivated'
);


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: trg_battle_status_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_battle_status_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM battle_state_transitions t
    WHERE t.from_status = OLD.status
      AND t.to_status   = NEW.status
  ) THEN
    RAISE EXCEPTION 'Illegal battle state transition: % -> %',
      OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: trg_result_winner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_result_winner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.winner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM battle_participants p
    WHERE p.battle_id = NEW.battle_id
      AND p.user_id   = NEW.winner_id
  ) THEN
    RAISE EXCEPTION 'Result winner % is not a participant of battle %',
      NEW.winner_id, NEW.battle_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: trg_submission_locked(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_submission_locked() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'locked' AND (
       NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
    OR NEW.status      <> OLD.status
  ) THEN
    RAISE EXCEPTION 'Submission % is locked and cannot be modified', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: achievement_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.achievement_definitions (
    key text NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id bigint NOT NULL,
    admin_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id uuid,
    reason text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.admin_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    purpose public.auth_token_purpose NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_auth_tokens_expiry CHECK ((expires_at > created_at))
);


--
-- Name: battle_challenge_elements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_challenge_elements (
    challenge_id uuid NOT NULL,
    category text NOT NULL,
    element_id uuid NOT NULL,
    value text NOT NULL
);


--
-- Name: battle_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    battle_id uuid NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    summary_text text
);


--
-- Name: battle_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    battle_id uuid NOT NULL,
    claimant_id uuid NOT NULL,
    type public.dispute_type NOT NULL,
    details text,
    status public.dispute_status DEFAULT 'open'::public.dispute_status NOT NULL,
    resolution text,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: battle_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_event_log (
    id bigint NOT NULL,
    battle_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_id uuid,
    payload jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battle_event_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.battle_event_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.battle_event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: battle_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_participants (
    battle_id uuid NOT NULL,
    user_id uuid NOT NULL,
    seat smallint DEFAULT 0 NOT NULL,
    outcome public.participant_outcome,
    final_position smallint,
    connected boolean DEFAULT true NOT NULL,
    ready_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battle_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    battle_id uuid NOT NULL,
    method public.result_method NOT NULL,
    winner_id uuid,
    scores jsonb DEFAULT '{}'::jsonb NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: battle_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    host_id uuid,
    code character varying(12),
    name text,
    room_type public.room_type DEFAULT 'casual'::public.room_type NOT NULL,
    visibility public.room_visibility DEFAULT 'public'::public.room_visibility NOT NULL,
    password_hash text,
    max_players smallint DEFAULT 2 NOT NULL,
    time_limit_seconds integer DEFAULT 1200 NOT NULL,
    result_method public.result_method DEFAULT 'voting_community'::public.result_method NOT NULL,
    spectator_allowed boolean DEFAULT true NOT NULL,
    chat_enabled boolean DEFAULT true NOT NULL,
    livestream_allowed boolean DEFAULT true NOT NULL,
    randomizer_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.room_status DEFAULT 'lobby'::public.room_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    starts_at timestamp with time zone,
    ended_at timestamp with time zone,
    battle_mode text DEFAULT '1v1'::text NOT NULL,
    auto_start boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT battle_rooms_max_players_check CHECK (((max_players >= 2) AND (max_players <= 16))),
    CONSTRAINT battle_rooms_name_check CHECK ((char_length(name) <= 60)),
    CONSTRAINT battle_rooms_time_limit_seconds_check CHECK ((time_limit_seconds > 0)),
    CONSTRAINT ck_room_password CHECK (((visibility = 'password'::public.room_visibility) = (password_hash IS NOT NULL)))
);


--
-- Name: battle_state_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_state_transitions (
    from_status public.battle_status NOT NULL,
    to_status public.battle_status NOT NULL
);


--
-- Name: battle_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_votes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    battle_id uuid NOT NULL,
    voter_id uuid NOT NULL,
    voted_for uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_no_self_vote CHECK ((voter_id <> voted_for))
);


--
-- Name: battles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    source_battle_id uuid,
    competition_type public.competition_type DEFAULT 'casual'::public.competition_type NOT NULL,
    format public.battle_format DEFAULT 'one_on_one'::public.battle_format NOT NULL,
    status public.battle_status DEFAULT 'waiting'::public.battle_status NOT NULL,
    result_method public.result_method,
    result_method_config jsonb,
    time_limit_seconds integer NOT NULL,
    settings_locked_at timestamp with time zone,
    start_time timestamp with time zone,
    official_end_time timestamp with time zone,
    submission_deadline timestamp with time zone,
    cheat_flag public.cheat_flag DEFAULT 'normal'::public.cheat_flag NOT NULL,
    forfeit_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    countdown_ends_at timestamp with time zone,
    CONSTRAINT battles_time_limit_seconds_check CHECK ((time_limit_seconds > 0)),
    CONSTRAINT ck_battle_submission_window CHECK (((submission_deadline IS NULL) OR (official_end_time IS NULL) OR (submission_deadline >= official_end_time))),
    CONSTRAINT ck_battle_times CHECK (((start_time IS NULL) OR (official_end_time IS NULL) OR (official_end_time > start_time)))
);


--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_no_self_block CHECK ((blocker_id <> blocked_id))
);


--
-- Name: bracket_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bracket_matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    round_number smallint NOT NULL,
    match_number smallint NOT NULL,
    player_a uuid,
    player_b uuid,
    winner_id uuid,
    battle_id uuid,
    status public.match_status DEFAULT 'pending'::public.match_status NOT NULL,
    scheduled_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT bracket_matches_round_number_check CHECK ((round_number >= 1)),
    CONSTRAINT ck_match_distinct_players CHECK (((player_a IS NULL) OR (player_b IS NULL) OR (player_a <> player_b)))
);


--
-- Name: community_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    user_id uuid NOT NULL,
    parent_id uuid,
    body text NOT NULL,
    status text DEFAULT 'visible'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_comment_no_self_parent CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT community_comments_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000))),
    CONSTRAINT community_comments_status_check CHECK ((status = ANY (ARRAY['visible'::text, 'hidden'::text, 'removed'::text])))
);


--
-- Name: community_post_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_post_likes (
    post_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: community_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    battle_id uuid,
    title text,
    caption text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    image_storage_key text NOT NULL,
    visibility public.post_visibility DEFAULT 'public'::public.post_visibility NOT NULL,
    status text DEFAULT 'visible'::text NOT NULL,
    like_count integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT community_posts_caption_check CHECK ((char_length(caption) <= 1000)),
    CONSTRAINT community_posts_status_check CHECK ((status = ANY (ARRAY['visible'::text, 'hidden'::text, 'removed'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    participant_a uuid NOT NULL,
    participant_b uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_conversation_distinct CHECK ((participant_a <> participant_b))
);


--
-- Name: drawing_apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drawing_apps (
    app_key text NOT NULL,
    display_name text NOT NULL,
    integration_level smallint DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT drawing_apps_integration_level_check CHECK (((integration_level >= 1) AND (integration_level <= 3)))
);


--
-- Name: event_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_registrations (
    event_id uuid NOT NULL,
    user_id uuid NOT NULL,
    payment_id uuid,
    seed_position smallint,
    current_round smallint DEFAULT 0 NOT NULL,
    elimination_status public.elimination_status DEFAULT 'active'::public.elimination_status NOT NULL,
    final_placement smallint,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_registration_paid CHECK (((seed_position IS NULL) OR (payment_id IS NOT NULL)))
);


--
-- Name: follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.follows (
    follower_id uuid NOT NULL,
    following_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_no_self_follow CHECK ((follower_id <> following_id))
);


--
-- Name: grand_arena_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grand_arena_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    edition text,
    entry_fee numeric(12,2) DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    grand_prize numeric(12,2),
    max_participants smallint DEFAULT 32 NOT NULL,
    time_limit_seconds integer DEFAULT 1800 NOT NULL,
    judging_criteria jsonb DEFAULT '[]'::jsonb NOT NULL,
    rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.event_status DEFAULT 'announced'::public.event_status NOT NULL,
    registration_open_at timestamp with time zone,
    registration_close_at timestamp with time zone,
    starts_at timestamp with time zone,
    completed_at timestamp with time zone,
    champion_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grand_arena_events_entry_fee_check CHECK ((entry_fee >= (0)::numeric)),
    CONSTRAINT grand_arena_events_grand_prize_check CHECK (((grand_prize IS NULL) OR (grand_prize > (0)::numeric))),
    CONSTRAINT grand_arena_events_max_participants_check CHECK ((max_participants > 0)),
    CONSTRAINT grand_arena_events_time_limit_seconds_check CHECK ((time_limit_seconds > 0))
);


--
-- Name: judge_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.judge_assignments (
    judge_id uuid NOT NULL,
    battle_id uuid NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: judge_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.judge_scores (
    battle_id uuid NOT NULL,
    judge_id uuid NOT NULL,
    criterion text NOT NULL,
    score numeric(5,2) NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT judge_scores_score_check CHECK ((score >= (0)::numeric))
);


--
-- Name: matchmaking_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matchmaking_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.mm_status DEFAULT 'queued'::public.mm_status NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    matched_room_id uuid
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    payload_type text,
    payload jsonb,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 4000))),
    CONSTRAINT messages_payload_type_check CHECK ((payload_type = ANY (ARRAY['battle_invitation'::text, 'artwork_share'::text, 'room_share'::text])))
);


--
-- Name: mutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mutes (
    muter_id uuid NOT NULL,
    muted_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_no_self_mute CHECK ((muter_id <> muted_id))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type public.notification_type NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    event_id uuid,
    amount numeric(12,2) NOT NULL,
    currency character(3) NOT NULL,
    provider text NOT NULL,
    provider_transaction_ref text,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    CONSTRAINT ck_payment_verified CHECK (((status <> 'confirmed'::public.payment_status) OR (verified_at IS NOT NULL))),
    CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: prize_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prize_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    user_id uuid NOT NULL,
    placement smallint,
    amount numeric(12,2) NOT NULL,
    currency character(3) NOT NULL,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prize_payouts_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: randomizer_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.randomizer_categories (
    key text NOT NULL,
    display_name text NOT NULL,
    icon text,
    sort_order smallint DEFAULT 0 NOT NULL,
    is_optional boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: randomizer_elements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.randomizer_elements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text NOT NULL,
    name text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    source text DEFAULT 'official'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT randomizer_elements_source_check CHECK ((source = ANY (ARRAY['official'::text, 'community'::text]))),
    CONSTRAINT randomizer_elements_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending'::text, 'rejected'::text, 'retired'::text])))
);


--
-- Name: rematch_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rematch_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    from_user_id uuid NOT NULL,
    to_user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id uuid NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    reason text NOT NULL,
    details text,
    status public.report_status DEFAULT 'open'::public.report_status NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reports_target_type_check CHECK ((target_type = ANY (ARRAY['user'::text, 'post'::text, 'battle'::text, 'stream'::text, 'comment'::text, 'message'::text])))
);


--
-- Name: room_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_participants (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    state public.room_participant_state DEFAULT 'waiting'::public.room_participant_state NOT NULL,
    seat smallint,
    ready_at timestamp with time zone,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    drawing_app_key text,
    CONSTRAINT ck_room_ready CHECK (((state <> 'ready'::public.room_participant_state) OR (ready_at IS NOT NULL)))
);


--
-- Name: room_spectators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_spectators (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    user_agent text,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT ck_sessions_expiry CHECK ((expires_at > created_at))
);


--
-- Name: streams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.streams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    battle_id uuid,
    user_id uuid NOT NULL,
    platform public.platform_name NOT NULL,
    external_stream_id text,
    stream_url text,
    title text,
    status public.stream_status DEFAULT 'scheduled'::public.stream_status NOT NULL,
    is_official boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    battle_id uuid NOT NULL,
    artist_id uuid NOT NULL,
    storage_key text,
    file_sha256 character(64),
    file_size_bytes bigint,
    mime_type text,
    source public.submission_source NOT NULL,
    verification public.submission_verification DEFAULT 'standard'::public.submission_verification NOT NULL,
    status public.submission_status DEFAULT 'submitted'::public.submission_status NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    review_note text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT ck_submission_lock_order CHECK (((locked_at IS NULL) OR (locked_at >= submitted_at))),
    CONSTRAINT ck_submission_locked CHECK (((status <> 'locked'::public.submission_status) OR (locked_at IS NOT NULL)))
);


--
-- Name: user_achievements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_achievements (
    user_id uuid NOT NULL,
    achievement text NOT NULL,
    unlocked_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb
);


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    user_id uuid NOT NULL,
    permission text NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_platform_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_platform_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform public.platform_name NOT NULL,
    external_user_id text NOT NULL,
    external_email public.citext,
    display_name text,
    access_secret_ref text,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    user_id uuid NOT NULL,
    bio text,
    avatar_storage_key text,
    country_code character(2),
    drawing_app_key text,
    is_discoverable boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_profiles_bio_check CHECK ((char_length(bio) <= 300))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role public.granted_role NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_statistics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_statistics (
    user_id uuid NOT NULL,
    battles integer DEFAULT 0 NOT NULL,
    wins integer DEFAULT 0 NOT NULL,
    losses integer DEFAULT 0 NOT NULL,
    draws integer DEFAULT 0 NOT NULL,
    win_streak integer DEFAULT 0 NOT NULL,
    best_streak integer DEFAULT 0 NOT NULL,
    rating numeric(8,2) DEFAULT 1000.00 NOT NULL,
    last_battle_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_stats_nonneg CHECK (((battles >= 0) AND (wins >= 0) AND (losses >= 0) AND (draws >= 0))),
    CONSTRAINT ck_stats_rating CHECK ((rating >= (0)::numeric))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username public.citext NOT NULL,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    display_name text,
    account_status public.user_account_status DEFAULT 'active'::public.user_account_status NOT NULL,
    two_factor_enabled boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    email_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_users_password_hash CHECK ((password_hash <> ''::text)),
    CONSTRAINT ck_users_username_len CHECK (((char_length((username)::text) >= 3) AND (char_length((username)::text) <= 30)))
);


--
-- Name: battle_rooms battle_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_rooms
    ADD CONSTRAINT battle_rooms_pkey PRIMARY KEY (id);


--
-- Name: rematch_requests rematch_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rematch_requests
    ADD CONSTRAINT rematch_requests_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_battle_rooms_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battle_rooms_code ON public.battle_rooms USING btree (code);


--
-- Name: uq_one_active_seat_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_one_active_seat_per_user ON public.room_participants USING btree (user_id) WHERE (state = ANY (ARRAY['waiting'::public.room_participant_state, 'ready'::public.room_participant_state]));


--
-- Name: uq_one_challenge_per_battle; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_one_challenge_per_battle ON public.battle_challenges USING btree (battle_id);


--
-- Name: uq_one_result_per_battle; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_one_result_per_battle ON public.battle_results USING btree (battle_id);


--
-- Name: uq_rematch_pending_per_room; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_rematch_pending_per_room ON public.rematch_requests USING btree (room_id) WHERE (status = 'pending'::text);


--
-- Name: rematch_requests rematch_requests_from_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rematch_requests
    ADD CONSTRAINT rematch_requests_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: rematch_requests rematch_requests_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rematch_requests
    ADD CONSTRAINT rematch_requests_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.battle_rooms(id) ON DELETE CASCADE;


--
-- Name: rematch_requests rematch_requests_to_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rematch_requests
    ADD CONSTRAINT rematch_requests_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict cucxbxNgIcbHXao7HeUObCXiGdoa3x8avnMtwujjO25SRoabFDI4fcEmmAo18N0


-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- v44.1 (deploy fix): the app's pool seeder (server/seed.js) upserts with
-- ON CONFLICT (category, name) — give it the matching unique constraint.
-- (The original dump shipped without PKs/uniques; existing databases get the
-- same index from the server.js v44 migration block, so both paths match.)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_randomizer_element_name
    ON public.randomizer_elements (category, name);

-- Static platform rows — run only on a first boot (empty database),
-- guarded so they can never duplicate. (pg_dump clears search_path
-- for the DDL above — restore it for these.)
-- ---------------------------------------------------------------------------
SET search_path TO public;

INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'character', 'Character', 1, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'character');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'environment', 'Environment', 2, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'environment');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'object', 'Object', 3, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'object');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'style', 'Style', 4, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'style');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'mood', 'Mood', 5, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'mood');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'lighting', 'Lighting', 6, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'lighting');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'color', 'Color', 7, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'color');
INSERT INTO randomizer_categories (key, display_name, sort_order, is_active) SELECT 'wildcard', 'Wildcard', 8, true WHERE NOT EXISTS (SELECT 1 FROM randomizer_categories WHERE key = 'wildcard');

INSERT INTO drawing_apps (app_key, display_name, integration_level, is_active) SELECT 'clip_studio', 'Clip Studio Paint', 2, true WHERE NOT EXISTS (SELECT 1 FROM drawing_apps WHERE app_key = 'clip_studio');
INSERT INTO drawing_apps (app_key, display_name, integration_level, is_active) SELECT 'ibispaint', 'ibisPaint', 2, true WHERE NOT EXISTS (SELECT 1 FROM drawing_apps WHERE app_key = 'ibispaint');
INSERT INTO drawing_apps (app_key, display_name, integration_level, is_active) SELECT 'krita', 'Krita', 3, true WHERE NOT EXISTS (SELECT 1 FROM drawing_apps WHERE app_key = 'krita');
INSERT INTO drawing_apps (app_key, display_name, integration_level, is_active) SELECT 'other', 'Other', 1, true WHERE NOT EXISTS (SELECT 1 FROM drawing_apps WHERE app_key = 'other');
INSERT INTO drawing_apps (app_key, display_name, integration_level, is_active) SELECT 'photoshop', 'Adobe Photoshop', 2, true WHERE NOT EXISTS (SELECT 1 FROM drawing_apps WHERE app_key = 'photoshop');
INSERT INTO drawing_apps (app_key, display_name, integration_level, is_active) SELECT 'procreate', 'Procreate', 1, true WHERE NOT EXISTS (SELECT 1 FROM drawing_apps WHERE app_key = 'procreate');

-- ===========================================================================
-- v50: YOUTUBE LIVE FOUNDATION (see server/youtube.js)
-- One YouTube connection per artist (tokens stored SERVER-SIDE only — they
-- are never returned by any API), and real broadcasts bound to battles.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.youtube_connections (
    user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    channel_id text NOT NULL,
    channel_title text NOT NULL,
    channel_thumbnail text,
    access_token text NOT NULL,
    refresh_token text,
    token_expires_at timestamp with time zone,
    scopes text,
    status text NOT NULL DEFAULT 'active',
    connected_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- The dump ships without PKs on battles/battle_rooms (the server's boot
-- migrations add them); make this file self-contained before the FK below.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'battle_rooms'::regclass AND contype = 'p') THEN
        ALTER TABLE battle_rooms ADD CONSTRAINT battle_rooms_pkey PRIMARY KEY (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'battles'::regclass AND contype = 'p') THEN
        ALTER TABLE battles ADD CONSTRAINT battles_pkey PRIMARY KEY (id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.youtube_broadcasts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    room_id uuid REFERENCES public.battle_rooms(id) ON DELETE SET NULL,
    battle_id uuid REFERENCES public.battles(id) ON DELETE SET NULL,
    youtube_broadcast_id text NOT NULL UNIQUE,
    youtube_stream_id text,
    stream_name text,
    ingestion_address text,
    title text NOT NULL,
    privacy text NOT NULL DEFAULT 'private',
    scheduled_start timestamp with time zone,
    watch_url text,
    last_known_status text NOT NULL DEFAULT 'scheduled',
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_broadcast_per_battle_artist
    ON public.youtube_broadcasts (battle_id, user_id);

-- ===========================================================================
-- v51: FRIENDS + REMATCH EXPIRY (see server/server.js, server/rooms.js)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.friend_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    to_user uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    responded_at timestamp with time zone,
    CONSTRAINT no_self_friend CHECK (from_user <> to_user)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_request_pending
    ON public.friend_requests (from_user, to_user) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.friendships (
    user_a uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    user_b uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b),
    CONSTRAINT ordered_pair CHECK (user_a < user_b)
);

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'friend_request';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'friend_accepted';

-- ============================================================================
-- v52 — PREMIUM ENTITLEMENTS + UI THEMES + REMATCH NOTIFICATIONS
-- ============================================================================
-- Payments-agnostic entitlement table: today only test-mode rows (source
-- 'test'); a future Paystack webhook writes the same rows with source
-- 'paystack' after verified payment. Feature access reads ONLY this table.
CREATE TABLE IF NOT EXISTS premium_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'premium',
  status text NOT NULL DEFAULT 'active',      -- active | ended | revoked
  source text NOT NULL DEFAULT 'test',       -- test | paystack (future)
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_premium_per_user
  ON premium_subscriptions (user_id) WHERE status = 'active';

-- Persisted UI customization (server-sanitized: a revoked Premium account
-- reads back NULL and safely falls back to the free Light/Dark system).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_theme text;

-- Rematch requests join the ONE notification system (24 h TTL, bell, panel).
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'rematch_request';
