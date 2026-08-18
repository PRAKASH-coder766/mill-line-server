-- Kayal Agro Foods — Mill Line schema v2
-- Batch-centric model: every unit of material (raw, in-process, or finished) is a
-- "batch" row. Batches link to each other through batch_lineage, which is what
-- makes end-to-end trace (and trace-back) possible. Adding a new product category
-- (Pulses, Flours, Papad, Spices, Pickles) never requires a schema change —
-- just insert rows into categories / products / quality_parameters.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer','qc')),
  pin_hash      TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id   TEXT UNIQUE NOT NULL,
  public_key      TEXT NOT NULL,
  counter         BIGINT NOT NULL DEFAULT 0,
  device_name     TEXT,
  transports      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Catalog: categories, products, quality parameters ----------

CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  code          TEXT UNIQUE NOT NULL,   -- short code used in batch numbers, e.g. 'OIL'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  name          TEXT NOT NULL,
  code          TEXT UNIQUE NOT NULL,   -- short code used in batch numbers, e.g. 'SESOIL'
  kind          TEXT NOT NULL CHECK (kind IN ('raw_material','finished_good')),
  unit          TEXT NOT NULL DEFAULT 'kg',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A quality parameter belongs to a product and a stage. Same product can have
-- different parameters checked at raw-material stage vs finished-good stage.
CREATE TABLE IF NOT EXISTS quality_parameters (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL CHECK (stage IN ('raw_material','finished_good')),
  name          TEXT NOT NULL,          -- e.g. 'Moisture %', 'FFA %', 'Peroxide Value'
  unit          TEXT,
  min_value     NUMERIC,
  max_value     NUMERIC,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true
);

-- ---------- Batches: the single source of truth for "a physical lot of material" ----------

CREATE TABLE IF NOT EXISTS batches (
  id              SERIAL PRIMARY KEY,
  batch_code      TEXT UNIQUE NOT NULL,   -- e.g. KAF-SESOIL-20260810-0007
  product_id      INTEGER NOT NULL REFERENCES products(id),
  stage           TEXT NOT NULL CHECK (stage IN ('raw_material','finished_good')),
  quantity        NUMERIC NOT NULL,       -- original quantity created
  remaining_qty   NUMERIC NOT NULL,       -- decremented as it's consumed/dispatched
  unit            TEXT NOT NULL DEFAULT 'kg',
  status          TEXT NOT NULL DEFAULT 'pending_qc'
                    CHECK (status IN ('pending_qc','approved','on_hold','rejected','consumed','dispatched')),
  origin_type     TEXT NOT NULL CHECK (origin_type IN ('sourcing','processing')),
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Traceability graph: which input batches went into producing which output batch.
CREATE TABLE IF NOT EXISTS batch_lineage (
  id                  SERIAL PRIMARY KEY,
  parent_batch_id     INTEGER NOT NULL REFERENCES batches(id),
  child_batch_id      INTEGER NOT NULL REFERENCES batches(id),
  quantity_used       NUMERIC,
  processing_run_id   INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Sourcing: raw material intake, creates a raw_material batch ----------

CREATE TABLE IF NOT EXISTS sourcing_records (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  date          DATE NOT NULL,
  supplier      TEXT NOT NULL,
  supplier_batch_no TEXT,
  origin        TEXT NOT NULL,
  bags          INTEGER NOT NULL,
  sack_weight   NUMERIC NOT NULL,
  gross_weight  NUMERIC NOT NULL,
  gunny_weight  NUMERIC NOT NULL,
  net_weight    NUMERIC NOT NULL,
  rate          NUMERIC NOT NULL,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Processing: consumes input batches, produces output batches ----------
-- Generic enough to cover oil extraction (seed -> oil + cake), dal milling,
-- flour milling, papad rolling, spice grinding, pickle blending, etc.

CREATE TABLE IF NOT EXISTS processing_runs (
  id            SERIAL PRIMARY KEY,
  process_name  TEXT NOT NULL,           -- e.g. 'Oil Extraction', 'Dal Milling'
  date          DATE NOT NULL,
  shift         TEXT NOT NULL,
  labour        INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processing_inputs (
  id                  SERIAL PRIMARY KEY,
  processing_run_id   INTEGER NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  batch_id            INTEGER NOT NULL REFERENCES batches(id),
  quantity_used       NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_outputs (
  id                  SERIAL PRIMARY KEY,
  processing_run_id   INTEGER NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  batch_id            INTEGER NOT NULL REFERENCES batches(id),
  quantity            NUMERIC NOT NULL
);

-- ---------- Quality inspections ----------

CREATE TABLE IF NOT EXISTS quality_inspections (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  inspector_id  INTEGER REFERENCES users(id),
  decision      TEXT NOT NULL CHECK (decision IN ('pass','fail','hold')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quality_inspection_readings (
  id              SERIAL PRIMARY KEY,
  inspection_id   INTEGER NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  parameter_id    INTEGER NOT NULL REFERENCES quality_parameters(id),
  measured_value  NUMERIC NOT NULL,
  within_limits   BOOLEAN NOT NULL
);

-- ---------- Dispatch: finished-good batches leaving the factory ----------

CREATE TABLE IF NOT EXISTS dispatch (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  date          DATE NOT NULL,
  customer      TEXT NOT NULL,
  quantity      NUMERIC NOT NULL,
  rate          NUMERIC NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid"     varchar NOT NULL COLLATE "default",
  "sess"    json NOT NULL,
  "expire"  timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey') THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_lineage_parent ON batch_lineage(parent_batch_id);
CREATE INDEX IF NOT EXISTS idx_lineage_child ON batch_lineage(child_batch_id);

-- ============================================================
-- Schema v3 additions — safe to run against the live v2 database.
-- Every statement below is additive (ADD COLUMN IF NOT EXISTS /
-- CREATE TABLE IF NOT EXISTS), so existing data is never touched.
-- ============================================================

-- ---------- Suppliers master data ----------
CREATE TABLE IF NOT EXISTS suppliers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  company_name    TEXT,
  gst_number      TEXT,
  fssai_number    TEXT,
  address         TEXT NOT NULL,       -- origin auto-fills from this
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link sourcing to the supplier master record (old free-text 'supplier'
-- column is kept for backward compatibility with existing rows).
ALTER TABLE sourcing_records ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id);

-- ---------- Process definitions: process name -> expected output products ----------
-- e.g. "Groundnut Oil" -> [Groundnut Oil, Groundnut Oil Cake]
CREATE TABLE IF NOT EXISTS process_definitions (
  id            SERIAL PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  category_id   INTEGER REFERENCES categories(id),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS process_definition_outputs (
  id                      SERIAL PRIMARY KEY,
  process_definition_id   INTEGER NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
  product_id              INTEGER NOT NULL REFERENCES products(id)
);

-- Link each processing run back to the process definition used (nullable —
-- older runs made before this feature won't have one).
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS process_definition_id INTEGER REFERENCES process_definitions(id);

-- ---------- Packing: bulk finished-good batches -> packed, dispatch-ready batches ----------
CREATE TABLE IF NOT EXISTS packing_runs (
  id            SERIAL PRIMARY KEY,
  pack_name     TEXT NOT NULL,          -- e.g. 'Groundnut Oil 1L Bottle Pack'
  date          DATE NOT NULL,
  shift         TEXT NOT NULL,
  labour        INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packing_inputs (
  id                SERIAL PRIMARY KEY,
  packing_run_id    INTEGER NOT NULL REFERENCES packing_runs(id) ON DELETE CASCADE,
  batch_id          INTEGER NOT NULL REFERENCES batches(id),
  quantity_used     NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS packing_outputs (
  id                SERIAL PRIMARY KEY,
  packing_run_id    INTEGER NOT NULL REFERENCES packing_runs(id) ON DELETE CASCADE,
  batch_id          INTEGER NOT NULL REFERENCES batches(id),
  quantity          NUMERIC NOT NULL
);

-- Packing info lives directly on the batch row so dispatch can show it
-- without an extra join, and so a batch's "is this ready to ship" state
-- (is_packed) is a single flag to check.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS is_packed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS pack_type TEXT;        -- e.g. 'Bottle', 'Pouch', 'Case'
ALTER TABLE batches ADD COLUMN IF NOT EXISTS pack_size TEXT;        -- e.g. '1L', '500g'
ALTER TABLE batches ADD COLUMN IF NOT EXISTS units_per_pack INTEGER;

CREATE INDEX IF NOT EXISTS idx_sourcing_supplier ON sourcing_records(supplier_id);
CREATE INDEX IF NOT EXISTS idx_batches_is_packed ON batches(is_packed);

-- ============================================================
-- Export System — Module 1: RBAC / Role Migration
-- Additive only. The legacy `users.role` column and its CHECK
-- constraint are left completely untouched — every existing
-- Mill Line requireRole()/requireLogin() check keeps working
-- exactly as before. This introduces a parallel, richer
-- authorization model (roles + user_roles) that the new Export
-- module code reads from, without removing or altering anything
-- Mill Line already depends on. The legacy column is only ever
-- removed in a later, separately-controlled phase, per the
-- approved migration strategy.
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
  id      SERIAL PRIMARY KEY,
  code    TEXT UNIQUE NOT NULL,   -- admin, management, operator, viewer, qc, export_sales, export_docs, purchase, accounts, logistics
  name    TEXT NOT NULL,          -- display name, e.g. "Export Sales"
  active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      INTEGER NOT NULL REFERENCES roles(id),
  assigned_by  INTEGER REFERENCES users(id),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);

-- ============================================================
-- Export System — Module 2: Master Data
-- Small, low-risk lookup tables. Everything downstream (Customer
-- Master, Quotation, Sales Order...) references these, so they're
-- built first per the approved build order.
-- ============================================================

CREATE TABLE IF NOT EXISTS export_countries (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  iso_code TEXT NOT NULL UNIQUE,
  active   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_currencies (
  id     SERIAL PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE,     -- USD, EUR, INR
  name   TEXT NOT NULL,
  symbol TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_ports (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  port_code  TEXT UNIQUE,
  country_id INTEGER REFERENCES export_countries(id),
  port_type  TEXT NOT NULL DEFAULT 'both' CHECK (port_type IN ('loading','discharge','both')),
  active     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_incoterms (
  id     SERIAL PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE,     -- FOB, CIF, CFR, EXW, DAP
  name   TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_payment_terms (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,   -- e.g. "30% Advance / 70% Against BL"
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_container_types (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,  -- 20FT, 40FT, 40HC, LCL
  max_cbm       NUMERIC(18,6),
  max_weight_kg NUMERIC(18,4),
  active        BOOLEAN NOT NULL DEFAULT true
);

-- Numbering prefixes/codes are admin-editable, not hard-coded — Owner
-- Decision 3 (single "KAF" company prefix, per-document-type code).
CREATE TABLE IF NOT EXISTS export_document_number_settings (
  id            SERIAL PRIMARY KEY,
  document_type TEXT NOT NULL UNIQUE, -- quotation, sales_order, factory_order, purchase_requisition,
                                       -- purchase_order, proforma_invoice, commercial_invoice, packing_list, shipment
  prefix        TEXT NOT NULL DEFAULT 'KAF',
  code          TEXT NOT NULL,        -- QTN, SO, FO, PR, PO, PI, INV, PL, SHP
  active        BOOLEAN NOT NULL DEFAULT true
);

-- Concurrency-safe sequence counters, one row per (document_type, financial_year).
-- Fetching the next number is a single atomic upsert (see Module 6+ number
-- generation logic) — never MAX(id)+1, which isn't safe under concurrent writes.
CREATE TABLE IF NOT EXISTS export_number_sequences (
  id              SERIAL PRIMARY KEY,
  document_type   TEXT NOT NULL REFERENCES export_document_number_settings(document_type),
  financial_year  TEXT NOT NULL,       -- '2026-27'
  last_number     INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_type, financial_year)
);

-- Supplier categories reuse the existing Mill Line `suppliers` table (Owner
-- Decision 2 — one shared supplier master, no export-specific duplicate) via
-- a proper many-to-many link, so one supplier can be both e.g. Raw Material
-- and Packing Material.
CREATE TABLE IF NOT EXISTS export_supplier_categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE   -- Raw Material, Packing Material, Finished Goods, Service Provider
);

CREATE TABLE IF NOT EXISTS supplier_category_links (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES export_supplier_categories(id),
  PRIMARY KEY (supplier_id, category_id)
);

-- ============================================================
-- Export System — Module 3: Customer Master
-- ============================================================

CREATE TABLE IF NOT EXISTS export_customers (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  company_name      TEXT NOT NULL,
  category          TEXT,
  currency_id       INTEGER REFERENCES export_currencies(id),
  payment_terms_id  INTEGER REFERENCES export_payment_terms(id),
  credit_limit      NUMERIC(20,4) NOT NULL DEFAULT 0,
  incoterm_pref_id  INTEGER REFERENCES export_incoterms(id),
  is_private_label  BOOLEAN NOT NULL DEFAULT false,
  tax_reg_no        TEXT,
  import_license_no TEXT,
  website           TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS export_customer_contacts (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES export_customers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  designation  TEXT,
  phone        TEXT,
  email        TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS export_customer_addresses (
  id                  SERIAL PRIMARY KEY,
  customer_id         INTEGER NOT NULL REFERENCES export_customers(id) ON DELETE CASCADE,
  address_type        TEXT NOT NULL CHECK (address_type IN ('billing','shipping','consignee','notify_party')),
  address_line        TEXT NOT NULL,
  city                TEXT,
  state               TEXT,
  country_id          INTEGER REFERENCES export_countries(id),
  postal_code         TEXT,
  port_of_discharge_id INTEGER REFERENCES export_ports(id),
  freight_forwarder   TEXT,
  clearing_agent      TEXT,
  is_default          BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON export_customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON export_customer_addresses(customer_id);

-- ============================================================
-- Export System — Module 4: Product Variant Layer
-- ============================================================

-- Mill Line extension: not every export product passes through your own
-- manufacturing line. This classification lets a Sales Order item later
-- follow the right traceability path — a real Mill Line batch for
-- 'manufactured' goods, or a supplier-lot/inward-lot record (built when the
-- Purchase/Packing phase is reached) for 'traded'/'repacked'/'outsourced'.
ALTER TABLE products ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'manufactured'
  CHECK (classification IN ('manufactured','traded','repacked','outsourced'));

-- A product (from the shared Mill Line catalog) can have many export SKUs —
-- different pack sizes, brands, private labels, customer-specific variants.
CREATE TABLE IF NOT EXISTS export_product_variants (
  id                     SERIAL PRIMARY KEY,
  product_id             INTEGER NOT NULL REFERENCES products(id),
  sku_code               TEXT NOT NULL UNIQUE,
  variant_name           TEXT NOT NULL,
  brand                  TEXT,
  is_private_label       BOOLEAN NOT NULL DEFAULT false,
  customer_id            INTEGER REFERENCES export_customers(id),  -- set only if exclusive to one customer
  unit_of_measure        TEXT NOT NULL DEFAULT 'kg',
  standard_export_price  NUMERIC(18,4),
  price_currency_id      INTEGER REFERENCES export_currencies(id),
  shelf_life_days        INTEGER,
  moq                    NUMERIC(18,4),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','discontinued','under_development')),
  created_by             INTEGER REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INTEGER REFERENCES users(id),
  updated_at             TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS export_variant_hs_codes (
  variant_id  INTEGER NOT NULL REFERENCES export_product_variants(id) ON DELETE CASCADE,
  country_id  INTEGER NOT NULL REFERENCES export_countries(id),
  hs_code     TEXT NOT NULL,
  PRIMARY KEY (variant_id, country_id)
);

CREATE TABLE IF NOT EXISTS export_product_packaging (
  id                 SERIAL PRIMARY KEY,
  variant_id         INTEGER NOT NULL REFERENCES export_product_variants(id) ON DELETE CASCADE,
  pack_size          TEXT,
  inner_pack_qty     INTEGER,
  outer_carton_qty   INTEGER,
  net_weight_kg      NUMERIC(18,4),
  gross_weight_kg    NUMERIC(18,4),
  carton_length_cm   NUMERIC(12,3),
  carton_width_cm    NUMERIC(12,3),
  carton_height_cm   NUMERIC(12,3),
  cbm                NUMERIC(18,6),
  barcode            TEXT,
  active             BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_customer_product_configs (
  id                       SERIAL PRIMARY KEY,
  customer_id              INTEGER NOT NULL REFERENCES export_customers(id),
  variant_id               INTEGER NOT NULL REFERENCES export_product_variants(id),
  special_price            NUMERIC(18,4),
  price_currency_id        INTEGER REFERENCES export_currencies(id),
  packaging_requirement    TEXT,
  documentation_requirement TEXT,
  active                   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (customer_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON export_product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_packaging_variant ON export_product_packaging(variant_id);
CREATE INDEX IF NOT EXISTS idx_customer_configs_customer ON export_customer_product_configs(customer_id);

-- ============================================================
-- Export System — Module 5: Pricing Controls
-- Four-scope precedence model (Owner Decision 6 + Addendum Section 7):
--   global < variant / customer < customer_variant
-- Resolution rule: the MOST RESTRICTIVE (highest) applicable threshold wins,
-- UNLESS a customer_variant row is flagged is_explicit_override, in which
-- case that row's thresholds are used alone. See utils/pricing.js.
-- ============================================================

CREATE TABLE IF NOT EXISTS export_pricing_controls (
  id                    SERIAL PRIMARY KEY,
  scope                 TEXT NOT NULL CHECK (scope IN ('global','variant','customer','customer_variant')),
  variant_id            INTEGER REFERENCES export_product_variants(id),
  customer_id           INTEGER REFERENCES export_customers(id),
  min_selling_price     NUMERIC(18,4),
  min_margin_pct        NUMERIC(9,4),
  currency_id           INTEGER REFERENCES export_currencies(id),
  is_explicit_override  BOOLEAN NOT NULL DEFAULT false,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'global') OR
    (scope = 'variant' AND variant_id IS NOT NULL AND customer_id IS NULL) OR
    (scope = 'customer' AND customer_id IS NOT NULL AND variant_id IS NULL) OR
    (scope = 'customer_variant' AND customer_id IS NOT NULL AND variant_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pricing_controls_variant ON export_pricing_controls(variant_id);
CREATE INDEX IF NOT EXISTS idx_pricing_controls_customer ON export_pricing_controls(customer_id);

-- ============================================================
-- Export System — Module 6: Generic Approval Engine
-- Built once, reused by Quotation / Customer PO / Sales Order / Purchase
-- Order / Commercial Invoice. Deliberately decoupled from any one document's
-- schema — condition evaluation reads from a JSONB `context` snapshot stored
-- on the run, not by querying the document's table directly (see
-- utils/approvals.js). This is also what lets the engine be tested standalone
-- (Module 6) before Quotation/Sales Order (Modules 7/9) exist.
-- ============================================================

CREATE TABLE IF NOT EXISTS approval_workflows (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  document_type  TEXT NOT NULL CHECK (document_type IN ('quotation','customer_po','sales_order','purchase_order','commercial_invoice','payment_adjustment')),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deterministic workflow selection (Addendum Section 9): at most one ACTIVE
-- workflow per document type, enforced by the database, not just discipline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_workflow_per_doctype
  ON approval_workflows(document_type) WHERE active = true;

CREATE TABLE IF NOT EXISTS approval_workflow_step_groups (
  id            SERIAL PRIMARY KEY,
  workflow_id   INTEGER NOT NULL REFERENCES approval_workflows(id) ON DELETE CASCADE,
  group_order   INTEGER NOT NULL,
  group_rule    TEXT NOT NULL DEFAULT 'ALL' CHECK (group_rule IN ('ALL','ANY')),
  UNIQUE (workflow_id, group_order)
);

CREATE TABLE IF NOT EXISTS approval_workflow_steps (
  id                SERIAL PRIMARY KEY,
  step_group_id     INTEGER NOT NULL REFERENCES approval_workflow_step_groups(id) ON DELETE CASCADE,
  role_required     TEXT NOT NULL,
  condition_type    TEXT,     -- null = always required. Otherwise: value_threshold, margin_below_min,
                               -- credit_exceeded, price_below_min, po_difference, new_customer
  condition_config  JSONB
);

CREATE TABLE IF NOT EXISTS approval_runs (
  id                    SERIAL PRIMARY KEY,
  workflow_id           INTEGER NOT NULL REFERENCES approval_workflows(id),
  document_type         TEXT NOT NULL,
  document_id           INTEGER NOT NULL,   -- polymorphic — validated in application code, not FK-enforced
  context               JSONB NOT NULL DEFAULT '{}', -- snapshot of decision-relevant values at submission time
  current_group_order   INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','clarification_requested','cancelled')),
  previous_run_id       INTEGER REFERENCES approval_runs(id),
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_runs_doc ON approval_runs(document_type, document_id);

CREATE TABLE IF NOT EXISTS approval_actions (
  id                 SERIAL PRIMARY KEY,
  approval_run_id    INTEGER NOT NULL REFERENCES approval_runs(id) ON DELETE CASCADE,
  workflow_step_id   INTEGER NOT NULL REFERENCES approval_workflow_steps(id),
  approver_id        INTEGER NOT NULL REFERENCES users(id),
  decision           TEXT NOT NULL CHECK (decision IN ('approve','reject','return_for_correction','clarification_requested','cancel')),
  comment            TEXT,
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one TERMINAL decision per step per run (Addendum Section 1) —
-- clarification_requested is deliberately excluded so it can repeat before
-- a terminal decision is finally recorded at that step.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_actions_terminal_once
  ON approval_actions(approval_run_id, workflow_step_id)
  WHERE decision IN ('approve','reject','return_for_correction','cancel');

-- Approval history is append-only at the database level, not just by
-- application convention (Addendum Section 11).
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approval_actions_append_only ON approval_actions;
CREATE TRIGGER trg_approval_actions_append_only
BEFORE UPDATE OR DELETE ON approval_actions
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ============================================================
-- Export System — Module 7: Quotation + Revisions
-- The quotation number is stable across its whole life; only the revision
-- number changes (REV-00, REV-01, ...). A revision becomes immutable the
-- moment it's sent to the customer — enforced by triggers below, not just
-- application code (Addendum Section 11).
-- ============================================================

CREATE TABLE IF NOT EXISTS export_quotations (
  id                    SERIAL PRIMARY KEY,
  quotation_no          TEXT NOT NULL UNIQUE,
  customer_id           INTEGER NOT NULL REFERENCES export_customers(id),
  current_revision_no   INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending_approval','approved','sent_to_customer','customer_reviewing',
    'customer_accepted','customer_rejected','revision_requested','po_awaited','closed'
  )),
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS export_quotation_revisions (
  id                          SERIAL PRIMARY KEY,
  quotation_id                INTEGER NOT NULL REFERENCES export_quotations(id),
  revision_no                 INTEGER NOT NULL,   -- 0 = REV-00 (original)
  currency_id                 INTEGER REFERENCES export_currencies(id),
  incoterm_id                 INTEGER REFERENCES export_incoterms(id),
  payment_terms_id            INTEGER REFERENCES export_payment_terms(id),
  port_of_loading_id          INTEGER REFERENCES export_ports(id),
  port_of_destination_id      INTEGER REFERENCES export_ports(id),
  validity_date               DATE,
  production_lead_time_days   INTEGER,
  shipment_lead_time_days     INTEGER,
  special_conditions          TEXT,
  remarks                     TEXT,
  is_immutable                BOOLEAN NOT NULL DEFAULT false,
  sent_to_customer_at         TIMESTAMPTZ,
  -- Commercial party snapshot (Addendum Section 4) — captured at creation,
  -- never re-derived from a possibly-since-edited Customer Master record.
  snapshot_customer_name      TEXT,
  snapshot_billing_address    TEXT,
  snapshot_consignee_address  TEXT,
  snapshot_notify_party_address TEXT,
  snapshot_country            TEXT,
  snapshot_tax_reg_no          TEXT,
  snapshot_contact_name        TEXT,
  snapshot_contact_email       TEXT,
  created_by                  INTEGER REFERENCES users(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quotation_id, revision_no)
);

CREATE TABLE IF NOT EXISTS export_quotation_revision_items (
  id                       SERIAL PRIMARY KEY,
  revision_id              INTEGER NOT NULL REFERENCES export_quotation_revisions(id) ON DELETE CASCADE,
  variant_id               INTEGER NOT NULL REFERENCES export_product_variants(id),
  quantity                 NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price               NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  cartons                  INTEGER,
  net_weight_kg            NUMERIC(18,4),
  gross_weight_kg          NUMERIC(18,4),
  cbm                      NUMERIC(18,6),
  fob_price                NUMERIC(18,4),
  freight                  NUMERIC(18,4),
  insurance                NUMERIC(18,4),
  cif_price                NUMERIC(18,4),
  -- Internal-only cost/margin fields — never selected in any customer-facing
  -- query (there is no customer portal yet, but the flag is the contract).
  product_cost             NUMERIC(18,4),
  packing_cost             NUMERIC(18,4),
  freight_allocation       NUMERIC(18,4),
  insurance_allocation     NUMERIC(18,4),
  cha_doc_cost             NUMERIC(18,4),
  commission               NUMERIC(18,4),
  other_cost               NUMERIC(18,4),
  expected_margin_amount   NUMERIC(18,4),
  expected_margin_pct      NUMERIC(9,4),
  internal_only            BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_quotations_customer ON export_quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotation_revisions_quotation ON export_quotation_revisions(quotation_id);
CREATE INDEX IF NOT EXISTS idx_quotation_revision_items_revision ON export_quotation_revision_items(revision_id);

-- Immutability enforcement at the database level (Addendum Section 11).
-- The ONE permitted transition — flipping is_immutable false→true at
-- send-to-customer time — still passes, since OLD.is_immutable is false then.
CREATE OR REPLACE FUNCTION enforce_quotation_revision_immutability() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_immutable THEN RAISE EXCEPTION 'Quotation revision % is immutable and cannot be deleted', OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_immutable THEN
    RAISE EXCEPTION 'Quotation revision % is immutable; create a new revision instead', OLD.id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotation_revision_immutable ON export_quotation_revisions;
CREATE TRIGGER trg_quotation_revision_immutable
BEFORE UPDATE OR DELETE ON export_quotation_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_quotation_revision_immutability();

CREATE OR REPLACE FUNCTION enforce_quotation_revision_item_immutability() RETURNS TRIGGER AS $$
DECLARE locked BOOLEAN;
BEGIN
  SELECT is_immutable INTO locked FROM export_quotation_revisions WHERE id = COALESCE(NEW.revision_id, OLD.revision_id);
  IF locked THEN RAISE EXCEPTION 'Cannot modify items of an immutable quotation revision'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotation_revision_items_immutable ON export_quotation_revision_items;
CREATE TRIGGER trg_quotation_revision_items_immutable
BEFORE INSERT OR UPDATE OR DELETE ON export_quotation_revision_items
FOR EACH ROW EXECUTE FUNCTION enforce_quotation_revision_item_immutability();

-- ============================================================
-- Export System — Module 8: Customer PO Intake + Comparison
-- ============================================================

CREATE TABLE IF NOT EXISTS export_customer_pos (
  id                              SERIAL PRIMARY KEY,
  po_no                           TEXT NOT NULL,
  po_date                         DATE NOT NULL,
  customer_id                     INTEGER NOT NULL REFERENCES export_customers(id),
  quotation_revision_id           INTEGER NOT NULL REFERENCES export_quotation_revisions(id),
  currency_id                     INTEGER REFERENCES export_currencies(id),
  incoterm_id                     INTEGER REFERENCES export_incoterms(id),
  payment_terms_id                INTEGER REFERENCES export_payment_terms(id),
  requested_shipment_date         DATE,
  port_of_destination_id          INTEGER REFERENCES export_ports(id),
  shipping_instructions           TEXT,
  special_packing_instructions    TEXT,
  special_documentation_requirements TEXT,
  status                          TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','under_comparison','differences_pending_approval','confirmed','superseded')),
  created_by                      INTEGER REFERENCES users(id),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                      INTEGER REFERENCES users(id),
  updated_at                      TIMESTAMPTZ,
  UNIQUE (customer_id, po_no)
);

CREATE TABLE IF NOT EXISTS export_customer_po_items (
  id                          SERIAL PRIMARY KEY,
  po_id                       INTEGER NOT NULL REFERENCES export_customer_pos(id) ON DELETE CASCADE,
  quotation_revision_item_id  INTEGER REFERENCES export_quotation_revision_items(id),
  variant_id                  INTEGER NOT NULL REFERENCES export_product_variants(id),
  quantity                    NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  price                       NUMERIC(18,4) NOT NULL CHECK (price >= 0),
  requested_shipment_date     DATE,
  special_instructions        TEXT
);

CREATE TABLE IF NOT EXISTS export_po_comparison (
  id                SERIAL PRIMARY KEY,
  po_id             INTEGER NOT NULL REFERENCES export_customer_pos(id) ON DELETE CASCADE,
  po_item_id        INTEGER REFERENCES export_customer_po_items(id),
  field_name        TEXT NOT NULL,
  quotation_value   TEXT,
  po_value          TEXT,
  is_difference     BOOLEAN NOT NULL,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  resolved          BOOLEAN NOT NULL DEFAULT false,
  resolved_by       INTEGER REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,
  resolution_notes  TEXT
);

CREATE INDEX IF NOT EXISTS idx_po_customer ON export_customer_pos(customer_id);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON export_customer_po_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_comparison_po ON export_po_comparison(po_id);

-- ============================================================
-- Export System — Module 9: Sales Order + PO Allocation
-- The allocation table (not a plain FK on the item) is what makes real
-- partial-order handling possible: one Customer PO item's quantity can be
-- split across multiple Sales Orders, and the sum of active allocations
-- against any one PO item is enforced transactionally at creation time
-- (see routes/salesOrders.js), never exceeding the PO item's quantity.
-- ============================================================

-- ============================================================
-- Export System — Module 9: Sales Order + PO Allocation
-- One Customer PO can feed multiple Sales Orders (partial quantities), and
-- one Sales Order can draw from multiple Customer POs. The allocation table
-- is the single source of truth for "how much of which PO line went to which
-- SO" — never inferred from a simple 1:1 foreign key.
-- ============================================================

CREATE TABLE IF NOT EXISTS export_sales_orders (
  id                    SERIAL PRIMARY KEY,
  so_no                 TEXT NOT NULL UNIQUE,
  customer_id           INTEGER NOT NULL REFERENCES export_customers(id),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending_approval','approved','rejected','factory_released','in_production',
    'production_complete','packing','partially_shipped','fully_shipped','delivered',
    'payment_pending','payment_partial','payment_complete','closed','cancelled'
  )),
  currency_id           INTEGER REFERENCES export_currencies(id),
  incoterm_id           INTEGER REFERENCES export_incoterms(id),
  payment_terms_id      INTEGER REFERENCES export_payment_terms(id),
  total_value           NUMERIC(20,4) NOT NULL DEFAULT 0,
  etd_planned           DATE,
  eta_planned           DATE,
  -- Commercial party snapshot, copied forward from the source quotation
  -- revision's own snapshot at SO creation time (Addendum Section 4) — never
  -- re-derived from Customer Master, which may since have changed.
  snapshot_customer_name       TEXT,
  snapshot_billing_address     TEXT,
  snapshot_consignee_address   TEXT,
  snapshot_notify_party_address TEXT,
  snapshot_country             TEXT,
  snapshot_tax_reg_no           TEXT,
  snapshot_contact_name         TEXT,
  snapshot_contact_email        TEXT,
  cancelled_by          INTEGER REFERENCES users(id),
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            INTEGER REFERENCES users(id),
  updated_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS export_sales_order_source_pos (
  sales_order_id  INTEGER NOT NULL REFERENCES export_sales_orders(id) ON DELETE CASCADE,
  customer_po_id  INTEGER NOT NULL REFERENCES export_customer_pos(id),
  PRIMARY KEY (sales_order_id, customer_po_id)
);

CREATE TABLE IF NOT EXISTS export_sales_order_items (
  id                       SERIAL PRIMARY KEY,
  sales_order_id           INTEGER NOT NULL REFERENCES export_sales_orders(id) ON DELETE CASCADE,
  customer_po_item_id      INTEGER REFERENCES export_customer_po_items(id),  -- primary/first PO-item reference for display
  variant_id               INTEGER NOT NULL REFERENCES export_product_variants(id),
  ordered_qty              NUMERIC(18,4) NOT NULL CHECK (ordered_qty > 0),
  unit_price                NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  requires_manufacturing    BOOLEAN NOT NULL,  -- snapshot of product.classification='manufactured' at order time
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','locked','amended'))
);

-- The real allocation ledger — supports partial PO quantities split across
-- multiple Sales Orders (Owner-mandated: "SO-1=600, SO-2=600" must never both
-- succeed against a 1,000-carton PO item).
CREATE TABLE IF NOT EXISTS export_sales_order_po_item_allocations (
  id                    SERIAL PRIMARY KEY,
  sales_order_id        INTEGER NOT NULL REFERENCES export_sales_orders(id),
  sales_order_item_id   INTEGER NOT NULL REFERENCES export_sales_order_items(id),
  customer_po_id        INTEGER NOT NULL REFERENCES export_customer_pos(id),
  customer_po_item_id   INTEGER NOT NULL REFERENCES export_customer_po_items(id),
  allocated_qty         NUMERIC(18,4) NOT NULL CHECK (allocated_qty > 0),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','cancelled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allocations_po_item ON export_sales_order_po_item_allocations(customer_po_item_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS export_customer_credit_snapshots (
  id                    SERIAL PRIMARY KEY,
  customer_id           INTEGER NOT NULL REFERENCES export_customers(id),
  sales_order_id        INTEGER REFERENCES export_sales_orders(id),
  outstanding_amount    NUMERIC(20,4),
  open_orders_value     NUMERIC(20,4),
  new_order_value       NUMERIC(20,4),
  projected_exposure    NUMERIC(20,4),
  credit_limit          NUMERIC(20,4),
  exceeded              BOOLEAN,
  override_by           INTEGER REFERENCES users(id),
  override_reason       TEXT,
  override_at           TIMESTAMPTZ,
  snapshot_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_orders_customer ON export_sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_so_items_so ON export_sales_order_items(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_credit_snapshots_customer ON export_customer_credit_snapshots(customer_id);










-- ============================================================
-- Export System — Module 10: Sales Order Amendment
-- Redesigned as header + items (Addendum Section 3): one amendment can
-- change several fields (price, ETD, payment terms...) as a single approval
-- package, applied atomically only when the header reaches Approved.
-- ============================================================

-- Widen the approval engine to cover amendments as their own document type —
-- this keeps the amendment approval chain separate from the original Sales
-- Order creation chain (they can have different steps/roles), while still
-- using the same generic engine (Owner Decision 3: "use the generic approval
-- engine so approval authority can be configured by amendment type").
ALTER TABLE approval_workflows DROP CONSTRAINT IF EXISTS approval_workflows_document_type_check;
ALTER TABLE approval_workflows ADD CONSTRAINT approval_workflows_document_type_check CHECK (
  document_type IN ('quotation','customer_po','sales_order','sales_order_amendment','purchase_order','commercial_invoice','payment_adjustment')
);

CREATE TABLE IF NOT EXISTS export_sales_order_amendments (
  id                SERIAL PRIMARY KEY,
  sales_order_id    INTEGER NOT NULL REFERENCES export_sales_orders(id),
  amendment_no      INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  requested_by      INTEGER NOT NULL REFERENCES users(id),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by       INTEGER REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  rejected_by       INTEGER REFERENCES users(id),
  rejected_at       TIMESTAMPTZ,
  decision_comment  TEXT,
  UNIQUE (sales_order_id, amendment_no)
);

CREATE TABLE IF NOT EXISTS export_sales_order_amendment_items (
  id                     SERIAL PRIMARY KEY,
  amendment_id           INTEGER NOT NULL REFERENCES export_sales_order_amendments(id) ON DELETE CASCADE,
  sales_order_item_id    INTEGER REFERENCES export_sales_order_items(id),
  entity_level           TEXT NOT NULL CHECK (entity_level IN ('header','item')),
  field_name             TEXT NOT NULL,
  old_value              TEXT,
  new_value              TEXT,
  CHECK (
    (entity_level = 'item' AND sales_order_item_id IS NOT NULL) OR
    (entity_level = 'header' AND sales_order_item_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_so_amendments_so ON export_sales_order_amendments(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_so_amendment_items_amendment ON export_sales_order_amendment_items(amendment_id);

-- ============================================================
-- Export System — Module 11: Documents
-- Version-controlled document records with a release gate. IMPORTANT: no
-- cloud object storage (S3-compatible) is provisioned for this deployment
-- yet — file content is stored directly in Postgres (file_data BYTEA) as a
-- pragmatic Phase 1 approach. This works fine at reasonable document volumes
-- but should migrate to real object storage before this becomes a
-- high-volume, many-GB document archive. The document *model* below doesn't
-- need to change for that migration — only where file_data actually lives.
-- ============================================================

CREATE TABLE IF NOT EXISTS export_documents (
  id                          SERIAL PRIMARY KEY,
  related_type                TEXT NOT NULL CHECK (related_type IN ('quotation','customer_po','sales_order','factory_order','shipment','invoice','packing_list','other')),
  related_id                  INTEGER NOT NULL,
  category                    TEXT NOT NULL CHECK (category IN ('customer','sales','factory','purchase','qc','shipping','bank','government')),
  doc_type                    TEXT NOT NULL,
  version_no                  INTEGER NOT NULL DEFAULT 1,
  original_filename           TEXT,
  file_mime_type              TEXT,
  file_size                   INTEGER,
  file_data                   BYTEA,
  status                      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','under_review','approved','released_to_customer','superseded','cancelled')),
  internal_only               BOOLEAN NOT NULL DEFAULT true,
  customer_visible            BOOLEAN NOT NULL DEFAULT false,
  superseded_by_document_id   INTEGER REFERENCES export_documents(id),
  uploaded_by                 INTEGER REFERENCES users(id),
  uploaded_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by                 INTEGER REFERENCES users(id),
  approved_at                 TIMESTAMPTZ,
  released_by                 INTEGER REFERENCES users(id),
  released_to_customer_at     TIMESTAMPTZ,
  customer_downloaded_at      TIMESTAMPTZ,
  UNIQUE (related_type, related_id, doc_type, version_no)
);

CREATE INDEX IF NOT EXISTS idx_documents_related ON export_documents(related_type, related_id);

-- ============================================================
-- Export System — Module 12: Audit / Timeline / Notifications
-- Three distinct concepts, kept separate per Section L of the frozen
-- architecture:
--   1. export_audit_log      — technical, field-level ("what exactly changed")
--   2. export_order_timeline — curated business narrative ("what happened,
--      in plain language, at meaningful moments") — not auto-generated from
--      every field change, written deliberately at real milestones
--   3. export_notifications  — event-driven alerts, channel-agnostic (only
--      in-app is actually wired up in Phase 1; email/WhatsApp/SMS slot into
--      the same event names later without changing business logic)
-- ============================================================

CREATE TABLE IF NOT EXISTS export_audit_log (
  id          SERIAL PRIMARY KEY,
  table_name  TEXT NOT NULL,
  row_id      INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  field_name  TEXT,
  old_value   TEXT,
  new_value   TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_export_audit_table_row ON export_audit_log(table_name, row_id);

CREATE TABLE IF NOT EXISTS export_order_timeline (
  id                    SERIAL PRIMARY KEY,
  sales_order_id        INTEGER REFERENCES export_sales_orders(id),
  quotation_id          INTEGER REFERENCES export_quotations(id),
  event_label           TEXT NOT NULL,
  event_type            TEXT,
  event_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_customer_visible    BOOLEAN NOT NULL DEFAULT true,
  created_by            INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_timeline_so ON export_order_timeline(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_timeline_quotation ON export_order_timeline(quotation_id);

CREATE TABLE IF NOT EXISTS export_notification_rules (
  event_type      TEXT PRIMARY KEY,
  channel         TEXT NOT NULL DEFAULT 'in_app',
  recipient_role  TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS export_notifications (
  id                 SERIAL PRIMARY KEY,
  recipient_user_id  INTEGER REFERENCES users(id),
  channel            TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  payload            JSONB,
  status             TEXT NOT NULL DEFAULT 'pending',
  sent_at            TIMESTAMPTZ,
  read_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON export_notifications(recipient_user_id, status);

-- ============================================================
-- Quick wins pass: login rate limiting support
-- ============================================================
CREATE TABLE IF NOT EXISTS login_attempts (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  success       BOOLEAN NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time ON login_attempts(username, attempted_at);

-- ============================================================
-- Staff-reported usability fixes (Mill Line factory screens)
-- ============================================================

-- 1. Processing: input batches should be restricted to the raw material(s)
--    a given process actually consumes (e.g. Coconut Oil consumes only
--    Copra) — mirrors the existing process_definition_outputs table.
CREATE TABLE IF NOT EXISTS process_definition_inputs (
  id                      SERIAL PRIMARY KEY,
  process_definition_id   INTEGER NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
  product_id              INTEGER NOT NULL REFERENCES products(id)
);

-- 2. Quality: inspectors need to record when the inspection actually
--    happened, not just rely on the record's creation timestamp (which may
--    lag behind if entered later).
ALTER TABLE quality_inspections ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMPTZ;

-- ============================================================
-- Staff-reported: Sourcing — let each supplier be linked to the specific
-- raw materials they supply, so the product dropdown can filter to what
-- that supplier actually offers instead of showing the entire catalog.
-- ============================================================
CREATE TABLE IF NOT EXISTS supplier_products (
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (supplier_id, product_id)
);

-- ============================================================
-- Staff-reported fixes, round 2
-- ============================================================

-- Item 2: Process wastage — informational reference figures only, shown
-- alongside the process in the Processing tab. Never used to auto-adjust or
-- validate output quantities — purely a number staff can see and account for
-- mentally, per Owner Decision.
ALTER TABLE process_definitions ADD COLUMN IF NOT EXISTS rm_wastage_pct NUMERIC(5,2);
ALTER TABLE process_definitions ADD COLUMN IF NOT EXISTS pm_wastage_pct NUMERIC(5,2);

-- Item 4: Pack type/size as a shared master list (same options for every
-- product, per Owner Decision), with an approximate weight per pack so the
-- Packing form can auto-calculate total quantity from a pack count.
CREATE TABLE IF NOT EXISTS pack_types (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  active  BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS pack_sizes (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,       -- e.g. "1L", "500ml", "25kg"
  weight_kg   NUMERIC(10,4),              -- approximate net weight per pack — admin-editable, used only as an auto-calc starting point
  active      BOOLEAN NOT NULL DEFAULT true
);

-- Item 5: a separate, simple local/domestic customer list for Dispatch —
-- deliberately NOT the export_customers table, since Dispatch's customers
-- (local buyers of oil/cake) are a different population from export trading
-- partners. The legacy free-text `customer` column on dispatch is kept for
-- backward compatibility with existing records.
CREATE TABLE IF NOT EXISTS dispatch_customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT UNIQUE,
  address     TEXT,
  phone       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dispatch ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES dispatch_customers(id);

-- ============================================================
-- Urid Dhall Processing — Phase 1: config + Pre-Processing
-- Additive extension. Good Material (and later, Stage 2 outputs) become
-- real rows in the existing `batches` table so QC/Packing/Dispatch/Trace
-- need zero Urid-specific code — only this module's own detail tables are new.
-- ============================================================

CREATE TABLE IF NOT EXISTS urid_config (
  key    TEXT PRIMARY KEY,
  value  NUMERIC(10,4) NOT NULL
);

CREATE TABLE IF NOT EXISTS urid_output_categories (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,   -- Sand, Stick/Foreign Matter, Stone, Karambai/Other Impurity, Waste, Urid Split Recovered, Urid Dust, ...
  is_recoverable BOOLEAN NOT NULL DEFAULT false,
  active         BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS urid_preprocessing_batches (
  id                    SERIAL PRIMARY KEY,
  batch_no              TEXT NOT NULL UNIQUE,     -- PP-YYYYMMDD-001
  processing_date       DATE NOT NULL,
  supplier_id           INTEGER REFERENCES suppliers(id),
  supplier_lot_no       TEXT,
  po_reference          TEXT,
  grn_reference         TEXT,
  raw_material_batch_id INTEGER REFERENCES batches(id),  -- the sourced raw urid lot this draws from
  warehouse_location    TEXT,
  machine_line          TEXT,
  operator_id           INTEGER REFERENCES users(id),
  supervisor_id         INTEGER REFERENCES users(id),
  shift                 TEXT,
  start_time            TIME,
  end_time              TIME,
  gross_quantity        NUMERIC(15,3),
  bag_count             INTEGER,
  standard_bag_weight   NUMERIC(15,3),
  actual_bag_weight     NUMERIC(15,3),
  net_input_qty         NUMERIC(15,3) NOT NULL CHECK (net_input_qty > 0),
  good_material_qty     NUMERIC(15,3),   -- computed, never hand-typed (Section 6)
  good_material_batch_id INTEGER REFERENCES batches(id),  -- the real stock lot created on approval
  mass_balance_diff_pct NUMERIC(7,4),
  mass_balance_ok       BOOLEAN,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','in_process','awaiting_review','approved','transferred_to_dhall','on_hold','cancelled'
  )),
  variance_reason       TEXT,
  remarks               TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            INTEGER REFERENCES users(id),
  updated_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS urid_preprocessing_outputs (
  id                SERIAL PRIMARY KEY,
  preprocessing_id  INTEGER NOT NULL REFERENCES urid_preprocessing_batches(id) ON DELETE CASCADE,
  category_id       INTEGER NOT NULL REFERENCES urid_output_categories(id),
  quantity          NUMERIC(15,3) NOT NULL CHECK (quantity >= 0),
  percentage        NUMERIC(7,4),
  is_recoverable    BOOLEAN NOT NULL DEFAULT false,
  disposition       TEXT CHECK (disposition IN ('transfer_to_stock','transfer_to_dhall','reprocess','hold','reject_dispose')),
  is_stockable      BOOLEAN NOT NULL DEFAULT false,
  stock_batch_id    INTEGER REFERENCES batches(id),  -- set if disposition created a real stock lot
  remarks           TEXT
);

CREATE TABLE IF NOT EXISTS urid_waste_disposals (
  id                SERIAL PRIMARY KEY,
  preprocessing_id  INTEGER REFERENCES urid_preprocessing_batches(id),
  output_id         INTEGER REFERENCES urid_preprocessing_outputs(id),
  quantity          NUMERIC(15,3) NOT NULL,
  disposal_method   TEXT,
  disposal_date     DATE,
  approved_by       INTEGER REFERENCES users(id),
  remarks           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_urid_pp_status ON urid_preprocessing_batches(status);
CREATE INDEX IF NOT EXISTS idx_urid_pp_outputs_batch ON urid_preprocessing_outputs(preprocessing_id);

-- Widen the approval engine again to cover Urid Pre-Processing.
ALTER TABLE approval_workflows DROP CONSTRAINT IF EXISTS approval_workflows_document_type_check;
ALTER TABLE approval_workflows ADD CONSTRAINT approval_workflows_document_type_check CHECK (
  document_type IN ('quotation','customer_po','sales_order','sales_order_amendment','purchase_order','commercial_invoice','payment_adjustment','urid_preprocessing','urid_dhall_processing')
);

-- ============================================================
-- Urid Dhall Processing — Phase 3: Stage 2 (Dhall Processing)
-- Consumes Good Material (possibly from several Pre-Processing batches at
-- once) and produces Whole/Split/Dust. Every output is still a real row in
-- the existing `batches` table, same architecture as Phase 1.
-- ============================================================

CREATE TABLE IF NOT EXISTS urid_loss_reasons (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS urid_dhall_batches (
  id                      SERIAL PRIMARY KEY,
  batch_no                TEXT NOT NULL UNIQUE,     -- DP-YYYYMMDD-001
  processing_date         DATE NOT NULL,
  machine_line            TEXT,
  operator_id             INTEGER REFERENCES users(id),
  supervisor_id           INTEGER REFERENCES users(id),
  shift                   TEXT,
  start_time              TIME,
  end_time                TIME,
  total_input_qty         NUMERIC(15,3) NOT NULL CHECK (total_input_qty > 0),
  whole_dhall_qty         NUMERIC(15,3) NOT NULL DEFAULT 0,
  split_dhall_qty         NUMERIC(15,3) NOT NULL DEFAULT 0,
  dust_qty                NUMERIC(15,3) NOT NULL DEFAULT 0,
  other_byproduct_qty     NUMERIC(15,3) NOT NULL DEFAULT 0,
  process_loss_qty        NUMERIC(15,3) NOT NULL DEFAULT 0,
  process_loss_reason_id  INTEGER REFERENCES urid_loss_reasons(id),
  mass_balance_diff_pct   NUMERIC(7,4),
  mass_balance_ok         BOOLEAN,
  -- Yield against THIS batch's own input:
  whole_yield_pct         NUMERIC(7,4),
  split_yield_pct         NUMERIC(7,4),
  dust_yield_pct          NUMERIC(7,4),
  loss_pct                NUMERIC(7,4),
  -- Yield against the ORIGINAL raw urid (traced back through Stage 1,
  -- proportionally, since one Dhall run can blend Good Material from
  -- several Pre-Processing batches with different yields):
  overall_yield_whole_pct NUMERIC(7,4),
  overall_yield_split_pct NUMERIC(7,4),
  overall_yield_dust_pct  NUMERIC(7,4),
  equivalent_raw_input_qty NUMERIC(15,3),
  whole_batch_id          INTEGER REFERENCES batches(id),
  split_batch_id          INTEGER REFERENCES batches(id),
  dust_batch_id           INTEGER REFERENCES batches(id),
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','in_process','awaiting_review','approved','on_hold','cancelled'
  )),
  variance_reason         TEXT,
  remarks                 TEXT,
  created_by              INTEGER REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              INTEGER REFERENCES users(id),
  updated_at              TIMESTAMPTZ
);

-- Which Stage 1 batches (and how much of each) fed this Dhall run — supports
-- multi-source input and is what makes partial-consumption tracking work.
CREATE TABLE IF NOT EXISTS urid_dhall_inputs (
  id                     SERIAL PRIMARY KEY,
  dhall_batch_id         INTEGER NOT NULL REFERENCES urid_dhall_batches(id) ON DELETE CASCADE,
  preprocessing_batch_id INTEGER NOT NULL REFERENCES urid_preprocessing_batches(id),
  good_material_batch_id INTEGER NOT NULL REFERENCES batches(id),
  quantity_consumed      NUMERIC(15,3) NOT NULL CHECK (quantity_consumed > 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS urid_dhall_outputs (
  id                SERIAL PRIMARY KEY,
  dhall_batch_id    INTEGER NOT NULL REFERENCES urid_dhall_batches(id) ON DELETE CASCADE,
  output_type       TEXT NOT NULL CHECK (output_type IN ('whole','split','dust','other')),
  quantity          NUMERIC(15,3) NOT NULL CHECK (quantity >= 0),
  yield_pct         NUMERIC(7,4),
  bag_count         INTEGER,
  bag_size          TEXT,
  storage_location  TEXT,
  classification    TEXT CHECK (classification IN ('saleable','by_product','reprocess','waste','hold')),  -- mainly used for dust
  qc_status         TEXT,
  stock_batch_id    INTEGER REFERENCES batches(id),
  remarks           TEXT
);

CREATE INDEX IF NOT EXISTS idx_urid_dhall_status ON urid_dhall_batches(status);
CREATE INDEX IF NOT EXISTS idx_urid_dhall_inputs_batch ON urid_dhall_inputs(dhall_batch_id);
CREATE INDEX IF NOT EXISTS idx_urid_dhall_inputs_pp ON urid_dhall_inputs(preprocessing_batch_id);
CREATE INDEX IF NOT EXISTS idx_urid_dhall_outputs_batch ON urid_dhall_outputs(dhall_batch_id);

-- Fix: start_time/end_time on Urid batches were incorrectly typed as
-- TIMESTAMPTZ, but the UI only ever collects a time-of-day (e.g. "10:50"),
-- which Postgres cannot cast to a full timestamp — every submission with a
-- time filled in was failing with "invalid input syntax for type timestamp".
-- Safe on already-deployed databases: if any TIMESTAMPTZ value happens to
-- exist, ::time extracts its time-of-day part rather than discarding it.
ALTER TABLE urid_preprocessing_batches ALTER COLUMN start_time TYPE TIME USING start_time::time;
ALTER TABLE urid_preprocessing_batches ALTER COLUMN end_time TYPE TIME USING end_time::time;
ALTER TABLE urid_dhall_batches ALTER COLUMN start_time TYPE TIME USING start_time::time;
ALTER TABLE urid_dhall_batches ALTER COLUMN end_time TYPE TIME USING end_time::time;
