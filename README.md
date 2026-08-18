# Kayal Agro Foods — Production Traceability & QC System

A multi-user Node.js + PostgreSQL application covering **raw material sourcing →
processing → quality inspection → dispatch**, with full batch-level trace-back,
built out end-to-end for **Edible Oils** (Sesame, Groundnut, Coconut). The other
five categories — Pulses, Flours, Papad, Spices, Pickles — are pre-created and
ready to fill in: adding a product, or a whole new category, is a form submission
in the Catalog tab, not a code change.

## Login & security

Unchanged from the earlier version: **passkey login** (fingerprint / Face ID /
Windows Hello via WebAuthn) with a PIN fallback for first login and new devices.
Roles are now: `admin`, `operator`, `qc`, `viewer`.

- **admin** — manages users, catalog (categories/products/quality parameters),
  and can do everything operators and QC can do.
- **operator** — logs sourcing, processing runs, and dispatch.
- **qc** — records quality inspections (readings + pass/fail/hold decision).
- **viewer** — read-only, including Trace.

## How traceability actually works: batches

Every physical lot of material — a delivery of sesame seed, a run of oil pressed
from it, the cake byproduct, a drum ready for dispatch — is a **batch** row with
its own unique code (e.g. `KAF-SESOIL-20260810-000042`). Batches connect to each
other through a `batch_lineage` table: when a processing run consumes input
batches and produces output batches, a lineage edge is recorded for every
input→output pair. The **Trace** tab walks this graph in both directions from
any batch code, so you can answer both:

- *"Where did the sesame in this bottle of oil come from?"* (upstream)
- *"Which customers received oil made from this batch of seed?"* (downstream)

## Quality gates, not just quality records

A batch is created with status `pending_qc`. It cannot be used as a processing
input, or dispatched, until a QC/admin user records an inspection:

- **Numeric parameters** are checked against min/max limits you define per
  product per stage (e.g. Sesame Seed, raw material: Moisture % ≤ 7.5). Each
  reading is automatically flagged within/outside limits.
- A final **decision** — Pass / Fail / Hold — sets the batch to Approved,
  Rejected, or On Hold. Only Approved batches move forward in the process.

Starter parameters are seeded for the Edible Oils raw materials and finished
goods (moisture, FFA, peroxide value, etc.) — add, remove, or adjust limits from
Catalog → Quality parameters as your actual QC standards are finalized.

## Setup

Same as before — see the earlier instructions for local dev, Railway (fastest
path to a live HTTPS URL, required for passkeys), and self-hosting with Docker.
Quick version:

```bash
npm install
cp .env.example .env   # set DATABASE_URL, ORIGIN, RP_ID
npm start
```

First boot seeds the Edible Oils catalog automatically and prints a bootstrap
admin PIN in the terminal. Sign in, add your passkey, then create real user
logins (Users tab) and fill in any additional quality parameters (Catalog tab).

**Note:** this is schema v2 (batch-based) and is not backward compatible with
data from the earlier flat sourcing/crushing/dispatch version. Start from an
empty database.

## Day-to-day flow

1. **Sourcing** — log an incoming raw material delivery (supplier, origin,
   bags, gross/gunny/net weight, rate). Creates a `pending_qc` batch.
2. **Quality** — QC/admin records readings + a pass/fail/hold decision. Passed
   batches become `approved` and are available as processing inputs.
3. **Processing** — select one or more approved input batches, record labour/
   shift, and specify the output batches produced (e.g. Sesame Oil + Sesame Oil
   Cake from one run). Inputs are decremented; outputs are created as new
   `pending_qc` batches, linked by lineage.
4. **Quality** again — inspect the finished-good batches before they can ship.
5. **Dispatch** — select an approved finished-good batch, record the customer
   and quantity. Remaining quantity decrements; batch is marked `dispatched`
   once fully shipped.
6. **Trace** — look up any batch code at any time to see its full history.

## Adding your remaining categories (Pulses, Flours, Papad, Spices, Pickles)

As an admin, go to **Catalog**:
1. The six categories already exist. For a new product (e.g. "Regular Papad
   3.5 Inch"), pick its category, give it a code, and mark it `raw_material` or
   `finished_good`.
2. Add its quality parameters (stage + name + unit + min/max) — e.g. for Papad:
   moisture %, diameter tolerance, oil absorption; for Pickles: pH, salt %,
   oil content.
3. That product now appears automatically in Sourcing, Processing, Quality, and
   Dispatch dropdowns — no further setup needed.

## Recent updates (v3)

These are additive changes on top of the live Edible Oils system — safe to deploy over your existing Railway database, no data loss:

1. **Adding a product** — any admin can add a new product any time from Catalog → Products.
2. **15-day backdating rule** — Sourcing dates older than 15 days can only be entered by an admin; operators are restricted to recent, real-time entries. Enforced server-side, not just in the UI.
3. **Supplier master data** — Suppliers are now a proper catalog entity (Catalog → Suppliers) with company name, GST number, FSSAI number, address, phone, and email — instead of free-text on each purchase.
4. **Origin auto-fill** — selecting a supplier in Sourcing auto-fills the Origin field from that supplier's saved address.
5. **Supplier batch/lot auto-suggestion** — selecting a supplier auto-suggests the next batch/lot number based on their last one (still editable).
6. **Gunny sack weight is now computed**, not entered — it's always `bags × sack weight per bag`, shown live as you type.
7. **Process name is now a dropdown** (Catalog → Process definitions) instead of free text — e.g. "Groundnut Oil", "Sesame Oil", "Coconut Oil".
8. **Output batches auto-fill from the process** — selecting "Groundnut Oil" as the process automatically proposes Groundnut Oil + Groundnut Oil Cake as the outputs; quantities are still yours to fill in.
9. **Mass balance check** — total output quantity across a processing (or packing) run can never exceed total input quantity; enforced both as a live on-screen hint and as a hard server-side rule.
10. **New Packing step before Dispatch** — bulk, QC-approved finished goods (e.g. bulk oil) must now go through a Packing run (pack type, pack size, units per pack) before they're eligible for Dispatch. Dispatch only lists packed, QC-approved batches.

### Adding your own process definitions
As an admin, go to Catalog → Process definitions to add more (e.g. once Papad or Pickles are built out) — pick the process name, category, and which products it's expected to output. No code changes needed.

## Extending further


- Multi-stage processing chains (e.g. Papad: knead → roll & dry → pack) work
  automatically — just log each stage as its own processing run; the output of
  one run becomes the input of the next, and lineage still connects end to end.
- Batch rejection currently blocks reuse entirely; if you want a workflow for
  reworking a rejected/on-hold batch, that's a moderate addition to
  `routes/quality.js` and `routes/processing.js` — ask when you're ready.
