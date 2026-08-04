-- Lead Report App — PostgreSQL schema
-- Designed to hold 2 lakh+ (200,000+) lead rows and aggregate them fast.

-- ---------------------------------------------------------------------------
-- settings: single-row JSON config, the equivalent of the sheet's "Setup" tab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id      integer PRIMARY KEY DEFAULT 1,
  config  jsonb   NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Normalization lookups (the "Course_Mapping" / "Lead Code_Mapping" tabs).
-- Keys are matched case-insensitively via the lower() unique index.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS course_mapping (
  id     bigserial PRIMARY KEY,
  course text NOT NULL,
  kapp   text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS course_mapping_key ON course_mapping (lower(btrim(course)));

CREATE TABLE IF NOT EXISTS lead_code_mapping (
  id     bigserial PRIMARY KEY,
  medium text NOT NULL,
  code   text NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_code_mapping_key ON lead_code_mapping (lower(btrim(medium)));

-- ---------------------------------------------------------------------------
-- datasets: one row per uploaded export (a weekly "Dump").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS datasets (
  id           bigserial PRIMARY KEY,
  name         text,
  source_filename text,
  row_count    integer NOT NULL DEFAULT 0,
  columns      text[],            -- original header names, in file order
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  is_active    boolean NOT NULL DEFAULT true
);
-- For databases created before `columns` existed:
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS columns text[];

-- ---------------------------------------------------------------------------
-- leads: raw row kept in `data` (jsonb, keyed by original header) plus the
-- derived fields the reports aggregate on (the "Rank" tab flags).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id          bigserial PRIMARY KEY,
  dataset_id  bigint NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  -- derived (computed by src/derive.js on import / recompute):
  record_key  text,
  lead_code   text,
  kapp_course text,
  city        text,
  origin      text,
  month       text,        -- 'YYYY-MM'
  lead_stage  text,
  fi_flag     smallint NOT NULL DEFAULT 0,
  app_flag    smallint NOT NULL DEFAULT 0,
  adm_flag    smallint NOT NULL DEFAULT 0,
  prim_flag   smallint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS leads_dataset       ON leads (dataset_id);
CREATE INDEX IF NOT EXISTS leads_lead_code      ON leads (dataset_id, lead_code);
CREATE INDEX IF NOT EXISTS leads_kapp_course    ON leads (dataset_id, kapp_course);
CREATE INDEX IF NOT EXISTS leads_city           ON leads (dataset_id, city);
CREATE INDEX IF NOT EXISTS leads_origin_month   ON leads (dataset_id, origin, month);
CREATE INDEX IF NOT EXISTS leads_flags          ON leads (dataset_id, prim_flag, app_flag, adm_flag);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS dup_flag smallint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS leads_dup_flag ON leads (dataset_id) WHERE dup_flag = 1;

-- ---------------------------------------------------------------------------
-- Duplicate uploads: per-Medium duplicate exports, one set per category
-- (leads / fi / apps / adm). Duplicate count = secondary + tertiary; medium is
-- normalized to kapp_medium via the lead-code mapping. Feeds the report's
-- duplicate columns, matched by kapp_medium.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duplicate_uploads (
  category        text PRIMARY KEY,   -- leads | fi | apps | adm
  source_filename text,
  row_count       integer NOT NULL DEFAULT 0,
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS duplicate_rows (
  id              bigserial PRIMARY KEY,
  category        text NOT NULL,       -- leads | fi | apps | adm
  source          text,
  medium          text,
  campaign        text,
  primary_leads   integer NOT NULL DEFAULT 0,
  secondary_leads integer NOT NULL DEFAULT 0,
  tertiary_leads  integer NOT NULL DEFAULT 0,
  total_instances integer NOT NULL DEFAULT 0,
  verified        integer NOT NULL DEFAULT 0,
  unverified      integer NOT NULL DEFAULT 0,
  form_initiated  integer NOT NULL DEFAULT 0,
  payment_approved integer NOT NULL DEFAULT 0,
  dup_count       integer NOT NULL DEFAULT 0,   -- secondary + tertiary
  kapp_medium     text
);
CREATE INDEX IF NOT EXISTS duplicate_rows_key ON duplicate_rows (category, lower(btrim(kapp_medium)));

-- ---------------------------------------------------------------------------
-- Annotations: free-text Insights / Challenges the user types into the report,
-- keyed by table scope (e.g. 'lead_codes') and row key (e.g. a lead code).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS annotations (
  scope      text NOT NULL,
  key        text NOT NULL,
  insights   text,
  challenges text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------------------
-- Multi-client: each client owns its own datasets, duplicate uploads, settings
-- and annotations. Exactly one client is active at a time. Course/lead-code
-- mappings stay global (shared across clients).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_settings (
  client_id  bigint PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  config     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE datasets          ADD COLUMN IF NOT EXISTS client_id bigint;
ALTER TABLE duplicate_uploads ADD COLUMN IF NOT EXISTS client_id bigint;
ALTER TABLE duplicate_rows    ADD COLUMN IF NOT EXISTS client_id bigint;
ALTER TABLE annotations       ADD COLUMN IF NOT EXISTS client_id bigint;

-- One-time migration: create a default client and assign all existing data
-- (datasets, duplicates, annotations, settings) to it.
DO $$
DECLARE cid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM clients) THEN
    INSERT INTO clients (name, is_active) VALUES ('Default Client', true) RETURNING id INTO cid;
    IF EXISTS (SELECT 1 FROM settings WHERE id = 1) THEN
      INSERT INTO client_settings (client_id, config)
        SELECT cid, config FROM settings WHERE id = 1
        ON CONFLICT (client_id) DO NOTHING;
    END IF;
  ELSE
    SELECT id INTO cid FROM clients WHERE is_active ORDER BY id LIMIT 1;
    IF cid IS NULL THEN
      SELECT id INTO cid FROM clients ORDER BY id LIMIT 1;
      UPDATE clients SET is_active = true WHERE id = cid;
    END IF;
  END IF;
  UPDATE datasets          SET client_id = cid WHERE client_id IS NULL;
  UPDATE duplicate_uploads SET client_id = cid WHERE client_id IS NULL;
  UPDATE duplicate_rows    SET client_id = cid WHERE client_id IS NULL;
  UPDATE annotations       SET client_id = cid WHERE client_id IS NULL;
END $$;

-- Per-client uniqueness (replacing the old global keys).
ALTER TABLE duplicate_uploads DROP CONSTRAINT IF EXISTS duplicate_uploads_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS duplicate_uploads_client_cat ON duplicate_uploads (client_id, category);
ALTER TABLE annotations DROP CONSTRAINT IF EXISTS annotations_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS annotations_client_key ON annotations (client_id, scope, key);
CREATE INDEX IF NOT EXISTS datasets_client        ON datasets (client_id);
CREATE INDEX IF NOT EXISTS duplicate_rows_client  ON duplicate_rows (client_id, category);

-- ---------------------------------------------------------------------------
-- Weekly Dump: distinguish campaign uploads from weekly dump uploads.
-- ---------------------------------------------------------------------------
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'campaign';
CREATE INDEX IF NOT EXISTS datasets_source_type ON datasets (client_id, source_type);

-- Per-client Weekly Dump column-mapping settings (CRM type + column names).
CREATE TABLE IF NOT EXISTS wd_client_settings (
  client_id  bigint PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  config     jsonb  NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Client sections: separate Campaign Analysis clients from Weekly Dump clients.
-- Existing clients default to 'campaign'.
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'campaign';
CREATE INDEX IF NOT EXISTS clients_section ON clients (section);

-- Session stores a separate active client per section.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_client_id bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_wd_client_id bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';

-- ---------------------------------------------------------------------------
-- Application-wide settings (singleton row).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  id         integer PRIMARY KEY DEFAULT 1,
  config     jsonb   NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT app_settings_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Bifurcation: master mapping of client name → tracking ID + CRM type.
-- Singleton config row stores uploaded file headers and raw rows;
-- bifurcation_data stores the parsed mappings after the user applies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bifurcation_config (
  id           integer PRIMARY KEY DEFAULT 1,
  client_col   text,
  tracking_col text,
  crm_col      text,
  headers      text[],
  raw_rows     jsonb,
  updated_at   timestamptz DEFAULT now(),
  CONSTRAINT bifurcation_config_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS bifurcation_data (
  id          bigserial PRIMARY KEY,
  client_name text NOT NULL,
  tracking_id text,
  crm_type    text
);

-- ---------------------------------------------------------------------------
-- Feature additions: client config, dataset lifecycle, audit log.
-- ---------------------------------------------------------------------------

-- Source-of-truth tracking_id and crm_type on clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tracking_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS crm_type text;

-- Dataset lifecycle (soft delete / archive)
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS uploaded_by text;
CREATE INDEX IF NOT EXISTS datasets_status ON datasets (client_id, status);

-- Session username for audit attribution
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS username text;

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  username     text NOT NULL DEFAULT 'unknown',
  action       text NOT NULL,
  client_name  text,
  dataset_name text,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at DESC);

-- ---------------------------------------------------------------------------
-- Client configuration lifecycle.
--
-- A client is "configured" once ANY of the following happens:
--   - a dataset is uploaded for it
--   - its settings are explicitly saved (Client Configuration / CRM & Tracking ID)
--   - its Weekly Dump setup is saved
--
-- Only configured clients should appear in client pickers / navigation.
-- Rows in bifurcation_data are just a name/tracking/CRM lookup table used to
-- populate the "existing client" dropdown when creating a configuration —
-- they are NEVER a source of truth for which clients are configured.
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_configured boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS clients_configured ON clients (section, is_configured);

-- Backfill: clients that already satisfy the configured definition above,
-- so upgrading this app doesn't hide clients people are already using.
UPDATE clients SET is_configured = true
WHERE is_configured = false AND (
  EXISTS (SELECT 1 FROM datasets d WHERE d.client_id = clients.id)
  OR EXISTS (SELECT 1 FROM client_settings cs WHERE cs.client_id = clients.id)
  OR EXISTS (SELECT 1 FROM wd_client_settings ws WHERE ws.client_id = clients.id)
);
