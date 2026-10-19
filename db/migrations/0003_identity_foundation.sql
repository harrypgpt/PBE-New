-- 0003_identity_foundation.sql
-- Purpose: user accounts, password credentials, server-side sessions, TOTP MFA, sign-in throttling
--          and the separate, append-only security-event log.
-- Stage:   6 (STAGE-06-PLAN.md §3; ADR-026, ADR-027)
-- Author:  coding agent; requires owner review like every migration.
-- pbe:phase expand
--
-- Additive only: new tables, functions, a trigger and privileges. Nothing existing is changed.
-- Objects are created as pbe_owner by the runner; search_path is pg_catalog only.
--
-- ACCESS MODEL (ADR-027): the runtime role pbe_app gets NO table privileges on any identity
-- table. It reaches them only through the SECURITY DEFINER functions below, each owned by
-- pbe_owner, with a fixed search_path, and each acting on ONE key (one email, one session-token
-- hash or one user id). No function returns more than one credential. The security-event log is
-- INSERT-only for pbe_app, and a trigger refuses UPDATE, DELETE and TRUNCATE for everyone.
-- Function bodies are dollar-quoted, so the runner's lexical checks do not inspect them (R-003):
-- reviewers must read them.

-- 1. Accounts. Users are platform-level: one person may belong to several tenants (Stage 7).
CREATE TABLE platform.user_account (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  -- Three separate checks: a combined AND expression is re-bracketed by pg_dump/restore, which
  -- the restore drill would (correctly) report as a schema difference.
  email            text        NOT NULL
                   CONSTRAINT user_account_email_length CHECK (char_length(email) BETWEEN 3 AND 254)
                   CONSTRAINT user_account_email_trimmed CHECK (email = btrim(email))
                   CONSTRAINT user_account_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  email_normalized text        GENERATED ALWAYS AS (lower(email)) STORED,
  display_name     text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  mfa_required     boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_account_email_unique_ci ON platform.user_account (email_normalized);
COMMENT ON TABLE platform.user_account IS 'User accounts. ids are permanent UUIDv7 values; email is unique ignoring case. No direct pbe_app access (ADR-027).';

CREATE TABLE platform.password_credential (
  user_id       uuid        PRIMARY KEY REFERENCES platform.user_account (id),
  password_hash text        NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  changed_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.password_credential IS 'Argon2id password hashes (PHC string, parameters included). Never plaintext.';

CREATE TABLE platform.user_session (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  token_hash          bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  user_id             uuid        NOT NULL REFERENCES platform.user_account (id),
  state               text        NOT NULL CHECK (state IN ('pending_mfa', 'pending_enrolment', 'active')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  ended_at            timestamptz,
  end_reason          text CHECK (end_reason IN ('logout', 'expired_idle', 'expired_absolute', 'rotated',
                                                 'password_changed', 'password_reset', 'user_deactivated',
                                                 'mfa_reset', 'policy_changed')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX user_session_open_by_user ON platform.user_session (user_id) WHERE ended_at IS NULL;
COMMENT ON TABLE platform.user_session IS 'Server-side sessions. Only the SHA-256 of the session token is stored.';

CREATE TABLE platform.mfa_totp_factor (
  user_id           uuid        PRIMARY KEY REFERENCES platform.user_account (id),
  secret_ciphertext bytea       NOT NULL,
  key_id            text        NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,40}$'),
  confirmed_at      timestamptz,
  last_used_step    bigint,
  created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.mfa_totp_factor IS 'TOTP secrets, encrypted by the API (AES-256-GCM, key outside the database; R-010). last_used_step blocks replay.';

CREATE TABLE platform.mfa_recovery_code (
  user_id   uuid        NOT NULL REFERENCES platform.user_account (id),
  code_hash bytea       NOT NULL CHECK (octet_length(code_hash) = 32),
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);
COMMENT ON TABLE platform.mfa_recovery_code IS 'Single-use MFA recovery codes, stored as SHA-256 only.';

CREATE TABLE platform.auth_throttle (
  throttle_key      bytea       PRIMARY KEY CHECK (octet_length(throttle_key) = 32),
  failures          integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until     timestamptz
);
COMMENT ON TABLE platform.auth_throttle IS 'Sign-in failure counters keyed by SHA-256 of "account:<email>" or "address:<ip>" (no plain identifiers).';

-- 2. Security-event log (D-6): separate from the business audit trail (Stage 7) and technical logs.
CREATE TABLE audit.security_event (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  event_type     text        NOT NULL CHECK (event_type ~ '^[a-z][a-z_]{1,62}$'),
  outcome        text        NOT NULL CHECK (outcome IN ('success', 'failure', 'info')),
  user_id        uuid        REFERENCES platform.user_account (id),
  session_id     uuid,
  request_id     uuid,
  actor          text        NOT NULL DEFAULT 'user' CHECK (actor IN ('user', 'operator', 'system')),
  client_address inet,
  detail         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX security_event_by_user_time ON audit.security_event (user_id, occurred_at);
COMMENT ON TABLE audit.security_event IS 'Append-only security events. Never contains passwords, tokens, codes or secrets.';

CREATE FUNCTION audit.security_event_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  RAISE EXCEPTION 'audit.security_event is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
CREATE TRIGGER security_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit.security_event
  FOR EACH ROW EXECUTE FUNCTION audit.security_event_append_only();
CREATE TRIGGER security_event_no_truncate
  BEFORE TRUNCATE ON audit.security_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.security_event_append_only();
REVOKE ALL ON FUNCTION audit.security_event_append_only() FROM PUBLIC;

-- 3. Privileges on tables: nothing for PUBLIC; pbe_app may only INSERT security events.
REVOKE ALL ON platform.user_account, platform.password_credential, platform.user_session,
  platform.mfa_totp_factor, platform.mfa_recovery_code, platform.auth_throttle,
  audit.security_event FROM PUBLIC;
GRANT INSERT ON audit.security_event TO pbe_app;

-- 4. Reviewed access functions (ADR-027). All: SECURITY DEFINER, owned by pbe_owner,
--    search_path pinned, one key per call, EXECUTE for pbe_app only.

-- 4.1 Accounts (operator commands).
CREATE FUNCTION platform.auth_user_create(p_email text, p_display_name text) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    INSERT INTO platform.user_account (email, display_name) VALUES (p_email, p_display_name)
    RETURNING id
  $fn$;

CREATE FUNCTION platform.auth_user_id_by_email(p_email text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT id FROM platform.user_account WHERE email_normalized = lower(p_email) $fn$;

CREATE FUNCTION platform.auth_user_set_mfa_required(p_user_id uuid, p_required boolean) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    UPDATE platform.user_account SET mfa_required = p_required, updated_at = now()
     WHERE id = p_user_id
    RETURNING true
  $fn$;

CREATE FUNCTION platform.auth_user_get(p_user_id uuid)
  RETURNS TABLE (id uuid, email text, display_name text, status text, mfa_required boolean, mfa_enrolled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT u.id, u.email, u.display_name, u.status, u.mfa_required,
           EXISTS (SELECT 1 FROM platform.mfa_totp_factor f
                    WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL)
      FROM platform.user_account u WHERE u.id = p_user_id
  $fn$;

-- 4.2 Sign-in look-up: one email in, at most one row out.
CREATE FUNCTION platform.auth_login_lookup(p_email text)
  RETURNS TABLE (user_id uuid, status text, mfa_required boolean, mfa_enrolled boolean, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT u.id, u.status, u.mfa_required,
           EXISTS (SELECT 1 FROM platform.mfa_totp_factor f
                    WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL),
           c.password_hash
      FROM platform.user_account u
      JOIN platform.password_credential c ON c.user_id = u.id
     WHERE u.email_normalized = lower(p_email)
  $fn$;

-- 4.3 Credentials: read one user's hash (to check the current password), or set it.
CREATE FUNCTION platform.auth_credential_get(p_user_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$ SELECT password_hash FROM platform.password_credential WHERE user_id = p_user_id $fn$;

CREATE FUNCTION platform.auth_credential_set(p_user_id uuid, p_hash text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    INSERT INTO platform.password_credential (user_id, password_hash) VALUES (p_user_id, p_hash)
    ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, changed_at = now()
  $fn$;

-- 4.4 Sessions: keyed by the SHA-256 of the session token.
CREATE FUNCTION platform.auth_session_create(p_user_id uuid, p_token_hash bytea, p_state text,
                                             p_idle_seconds integer, p_absolute_seconds integer)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_idle_seconds NOT BETWEEN 60 AND 86400 OR p_absolute_seconds NOT BETWEEN 300 AND 604800 THEN
    RAISE EXCEPTION 'session lifetime out of range';
  END IF;
  INSERT INTO platform.user_session (token_hash, user_id, state, idle_expires_at, absolute_expires_at)
  VALUES (p_token_hash, p_user_id, p_state,
          now() + make_interval(secs => p_idle_seconds),
          now() + make_interval(secs => p_absolute_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

-- Finds one session and checks it: expired, ended or deactivated-user sessions are ended and
-- reported (end_reason set); a valid session's idle expiry is extended.
CREATE FUNCTION platform.auth_session_resolve(p_token_hash bytea, p_idle_seconds integer)
  RETURNS TABLE (session_id uuid, user_id uuid, state text, user_status text, mfa_required boolean,
                 mfa_enrolled boolean, end_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
#variable_conflict use_column
DECLARE
  s platform.user_session%ROWTYPE;
  u platform.user_account%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO s FROM platform.user_session WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR s.ended_at IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT * INTO u FROM platform.user_account WHERE id = s.user_id;
  v_reason := CASE
    WHEN now() >= s.absolute_expires_at THEN 'expired_absolute'
    WHEN now() >= s.idle_expires_at THEN 'expired_idle'
    WHEN u.status <> 'active' THEN 'user_deactivated'
  END;
  IF v_reason IS NOT NULL THEN
    UPDATE platform.user_session SET ended_at = now(), end_reason = v_reason WHERE id = s.id;
  ELSE
    UPDATE platform.user_session
       SET last_seen_at = now(),
           idle_expires_at = least(now() + make_interval(secs => p_idle_seconds), s.absolute_expires_at)
     WHERE id = s.id;
  END IF;
  RETURN QUERY SELECT s.id, s.user_id, s.state, u.status, u.mfa_required,
    EXISTS (SELECT 1 FROM platform.mfa_totp_factor f WHERE f.user_id = s.user_id AND f.confirmed_at IS NOT NULL),
    v_reason;
END
$fn$;

CREATE FUNCTION platform.auth_session_end(p_token_hash bytea, p_reason text)
  RETURNS TABLE (session_id uuid, user_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    UPDATE platform.user_session SET ended_at = now(), end_reason = p_reason
     WHERE token_hash = p_token_hash AND ended_at IS NULL
    RETURNING id, user_id
  $fn$;

CREATE FUNCTION platform.auth_session_end_all(p_user_id uuid, p_reason text, p_except uuid)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    WITH ended AS (
      UPDATE platform.user_session SET ended_at = now(), end_reason = p_reason
       WHERE user_id = p_user_id AND ended_at IS NULL AND id IS DISTINCT FROM p_except
      RETURNING 1)
    SELECT count(*)::integer FROM ended
  $fn$;

-- 4.5 TOTP and recovery codes: one user per call.
CREATE FUNCTION platform.auth_totp_get(p_user_id uuid)
  RETURNS TABLE (secret_ciphertext bytea, key_id text, confirmed boolean, last_used_step bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT secret_ciphertext, key_id, confirmed_at IS NOT NULL, last_used_step
      FROM platform.mfa_totp_factor WHERE user_id = p_user_id
  $fn$;

-- Starts (or restarts) an UNCONFIRMED enrolment. Refuses if a confirmed factor exists.
CREATE FUNCTION platform.auth_totp_begin(p_user_id uuid, p_ciphertext bytea, p_key_id text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  INSERT INTO platform.mfa_totp_factor (user_id, secret_ciphertext, key_id)
  VALUES (p_user_id, p_ciphertext, p_key_id)
  ON CONFLICT (user_id) DO UPDATE
     SET secret_ciphertext = EXCLUDED.secret_ciphertext, key_id = EXCLUDED.key_id,
         created_at = now(), last_used_step = NULL
   WHERE platform.mfa_totp_factor.confirmed_at IS NULL;
  RETURN FOUND;
END
$fn$;

-- Confirms enrolment only with a verified code's time step (checked by the API first).
CREATE FUNCTION platform.auth_totp_confirm(p_user_id uuid, p_step bigint) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    UPDATE platform.mfa_totp_factor SET confirmed_at = now(), last_used_step = p_step
     WHERE user_id = p_user_id AND confirmed_at IS NULL
    RETURNING true
  $fn$;

-- Replay protection: a time step can be used once, and never an older one.
CREATE FUNCTION platform.auth_totp_use_step(p_user_id uuid, p_step bigint) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    UPDATE platform.mfa_totp_factor SET last_used_step = p_step
     WHERE user_id = p_user_id AND confirmed_at IS NOT NULL
       AND (last_used_step IS NULL OR last_used_step < p_step)
    RETURNING true
  $fn$;

CREATE FUNCTION platform.auth_recovery_codes_replace(p_user_id uuid, p_hashes bytea[]) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  IF cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION 'exactly 10 recovery codes are required';
  END IF;
  DELETE FROM platform.mfa_recovery_code WHERE user_id = p_user_id;
  INSERT INTO platform.mfa_recovery_code (user_id, code_hash)
  SELECT p_user_id, h FROM unnest(p_hashes) AS h;
END
$fn$;

CREATE FUNCTION platform.auth_recovery_code_use(p_user_id uuid, p_hash bytea) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    UPDATE platform.mfa_recovery_code SET used_at = now()
     WHERE user_id = p_user_id AND code_hash = p_hash AND used_at IS NULL
    RETURNING true
  $fn$;

CREATE FUNCTION platform.auth_mfa_reset(p_user_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
BEGIN
  DELETE FROM platform.mfa_recovery_code WHERE user_id = p_user_id;
  DELETE FROM platform.mfa_totp_factor WHERE user_id = p_user_id;
END
$fn$;

-- 4.6 Throttling (ADR-026): keys are SHA-256 digests computed by the API.
CREATE FUNCTION platform.auth_throttle_blocked_until(p_keys bytea[]) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT max(blocked_until) FROM platform.auth_throttle
     WHERE throttle_key = ANY (p_keys) AND blocked_until > now()
  $fn$;

-- mode 'backoff': from p_threshold failures on, block for p_base_seconds doubling per further
--                 failure, capped at p_max_seconds; the count restarts after p_window_seconds idle.
-- mode 'window':  at most p_threshold failures per p_window_seconds window.
CREATE FUNCTION platform.auth_throttle_fail(p_key bytea, p_mode text, p_threshold integer,
                                            p_window_seconds integer, p_base_seconds integer,
                                            p_max_seconds integer)
  RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  t platform.auth_throttle%ROWTYPE;
BEGIN
  IF p_mode NOT IN ('backoff', 'window') OR p_threshold < 1 THEN
    RAISE EXCEPTION 'invalid throttle policy';
  END IF;
  INSERT INTO platform.auth_throttle (throttle_key) VALUES (p_key) ON CONFLICT (throttle_key) DO NOTHING;
  SELECT * INTO t FROM platform.auth_throttle WHERE throttle_key = p_key FOR UPDATE;
  IF t.window_started_at < now() - make_interval(secs => p_window_seconds) THEN
    t.failures := 0;
    t.window_started_at := now();
    t.blocked_until := NULL;
  END IF;
  t.failures := t.failures + 1;
  IF t.failures >= p_threshold THEN
    IF p_mode = 'backoff' THEN
      t.blocked_until := now() + make_interval(secs => least(
        p_base_seconds::double precision * power(2, least(t.failures - p_threshold, 20)),
        p_max_seconds::double precision));
      t.window_started_at := now();
    ELSE
      t.blocked_until := t.window_started_at + make_interval(secs => p_window_seconds);
    END IF;
  END IF;
  UPDATE platform.auth_throttle
     SET failures = t.failures, window_started_at = t.window_started_at, blocked_until = t.blocked_until
   WHERE throttle_key = p_key;
  RETURN t.blocked_until;
END
$fn$;

CREATE FUNCTION platform.auth_throttle_clear(p_key bytea) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$ UPDATE platform.auth_throttle SET failures = 0, blocked_until = NULL WHERE throttle_key = p_key $fn$;

-- 5. Function privileges: new functions are executable by PUBLIC by default; restrict them.
REVOKE ALL ON FUNCTION
  platform.auth_user_create(text, text),
  platform.auth_user_id_by_email(text),
  platform.auth_user_set_mfa_required(uuid, boolean),
  platform.auth_user_get(uuid),
  platform.auth_login_lookup(text),
  platform.auth_credential_get(uuid),
  platform.auth_credential_set(uuid, text),
  platform.auth_session_create(uuid, bytea, text, integer, integer),
  platform.auth_session_resolve(bytea, integer),
  platform.auth_session_end(bytea, text),
  platform.auth_session_end_all(uuid, text, uuid),
  platform.auth_totp_get(uuid),
  platform.auth_totp_begin(uuid, bytea, text),
  platform.auth_totp_confirm(uuid, bigint),
  platform.auth_totp_use_step(uuid, bigint),
  platform.auth_recovery_codes_replace(uuid, bytea[]),
  platform.auth_recovery_code_use(uuid, bytea),
  platform.auth_mfa_reset(uuid),
  platform.auth_throttle_blocked_until(bytea[]),
  platform.auth_throttle_fail(bytea, text, integer, integer, integer, integer),
  platform.auth_throttle_clear(bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  platform.auth_user_create(text, text),
  platform.auth_user_id_by_email(text),
  platform.auth_user_set_mfa_required(uuid, boolean),
  platform.auth_user_get(uuid),
  platform.auth_login_lookup(text),
  platform.auth_credential_get(uuid),
  platform.auth_credential_set(uuid, text),
  platform.auth_session_create(uuid, bytea, text, integer, integer),
  platform.auth_session_resolve(bytea, integer),
  platform.auth_session_end(bytea, text),
  platform.auth_session_end_all(uuid, text, uuid),
  platform.auth_totp_get(uuid),
  platform.auth_totp_begin(uuid, bytea, text),
  platform.auth_totp_confirm(uuid, bigint),
  platform.auth_totp_use_step(uuid, bigint),
  platform.auth_recovery_codes_replace(uuid, bytea[]),
  platform.auth_recovery_code_use(uuid, bytea),
  platform.auth_mfa_reset(uuid),
  platform.auth_throttle_blocked_until(bytea[]),
  platform.auth_throttle_fail(bytea, text, integer, integer, integer, integer),
  platform.auth_throttle_clear(bytea)
TO pbe_app;
