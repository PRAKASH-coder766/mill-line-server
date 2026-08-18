const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function seedCatalog() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
  if (rows[0].n > 0) return; // already seeded

  console.log('Seeding starter catalog (Edible Oils)...');

  // Categories — the other five (Pulses, Flours, Papad, Spices, Pickles) can be
  // added later from the Catalog tab with no code changes.
  const categorySeed = [
    ['Edible Oils', 'OIL'],
    ['Pulses', 'PUL'],
    ['Flours', 'FLR'],
    ['Papad', 'PAP'],
    ['Spices', 'SPC'],
    ['Pickles', 'PKL'],
  ];
  const catIds = {};
  for (const [name, code] of categorySeed) {
    const { rows } = await pool.query(
      'INSERT INTO categories (name, code) VALUES ($1,$2) RETURNING id', [name, code]
    );
    catIds[code] = rows[0].id;
  }

  // Products for Edible Oils, built out end-to-end as requested.
  const productSeed = [
    // [category_code, name, code, kind, unit]
    ['OIL', 'Sesame Seed', 'SESSEED', 'raw_material', 'kg'],
    ['OIL', 'Groundnut', 'GNSEED', 'raw_material', 'kg'],
    ['OIL', 'Copra', 'COPRA', 'raw_material', 'kg'],
    ['OIL', 'Sesame Oil', 'SESOIL', 'finished_good', 'kg'],
    ['OIL', 'Sesame Oil Cake', 'SESCAKE', 'finished_good', 'kg'],
    ['OIL', 'Groundnut Oil', 'GNOIL', 'finished_good', 'kg'],
    ['OIL', 'Groundnut Oil Cake', 'GNCAKE', 'finished_good', 'kg'],
    ['OIL', 'Coconut Oil', 'COCOIL', 'finished_good', 'kg'],
    ['OIL', 'Coconut Oil Cake', 'COCCAKE', 'finished_good', 'kg'],
  ];
  const prodIds = {};
  for (const [catCode, name, code, kind, unit] of productSeed) {
    const { rows } = await pool.query(
      'INSERT INTO products (category_id, name, code, kind, unit) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [catIds[catCode], name, code, kind, unit]
    );
    prodIds[code] = rows[0].id;
  }

  // Quality parameters — starter benchmarks; admins can add/edit more from the Catalog tab.
  const paramSeed = [
    // [product_code, stage, name, unit, min, max]
    ['SESSEED', 'raw_material', 'Moisture %', '%', null, 7.5],
    ['SESSEED', 'raw_material', 'Foreign Matter %', '%', null, 2],
    ['SESSEED', 'raw_material', 'Oil Content %', '%', 48, null],
    ['GNSEED', 'raw_material', 'Moisture %', '%', null, 8],
    ['GNSEED', 'raw_material', 'Foreign Matter %', '%', null, 2],
    ['GNSEED', 'raw_material', 'Damaged/Shrivelled %', '%', null, 5],
    ['COPRA', 'raw_material', 'Moisture %', '%', null, 6],
    ['COPRA', 'raw_material', 'Free Fatty Acid %', '%', null, 5],
    ['SESOIL', 'finished_good', 'FFA %', '%', null, 2.0],
    ['SESOIL', 'finished_good', 'Moisture & Impurities %', '%', null, 0.2],
    ['SESOIL', 'finished_good', 'Peroxide Value', 'meq/kg', null, 10],
    ['GNOIL', 'finished_good', 'FFA %', '%', null, 2.0],
    ['GNOIL', 'finished_good', 'Moisture & Impurities %', '%', null, 0.2],
    ['GNOIL', 'finished_good', 'Peroxide Value', 'meq/kg', null, 10],
    ['COCOIL', 'finished_good', 'FFA %', '%', null, 5.0],
    ['COCOIL', 'finished_good', 'Moisture & Impurities %', '%', null, 0.2],
    ['COCOIL', 'finished_good', 'Saponification Value', 'mg KOH/g', 250, 260],
  ];
  for (const [code, stage, name, unit, min, max] of paramSeed) {
    await pool.query(
      'INSERT INTO quality_parameters (product_id, stage, name, unit, min_value, max_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [prodIds[code], stage, name, unit, min, max]
    );
  }
}

async function seedProcessDefinitions() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM process_definitions');
  if (rows[0].n > 0) return; // already seeded

  const oilCat = (await pool.query(`SELECT id FROM categories WHERE code='OIL'`)).rows[0];
  if (!oilCat) return; // Edible Oils category not present yet — nothing to seed against

  const productId = async (code) => {
    const r = await pool.query('SELECT id FROM products WHERE code=$1', [code]);
    return r.rows[0]?.id || null;
  };

  // process name -> [output product codes], [input product codes]. Selecting
  // this process name in the Processing tab auto-fills expected outputs, and
  // restricts the input batch picker to the correct raw material(s) —
  // Coconut Oil should only ever consume Copra, not any raw material on hand.
  const defs = [
    ['Groundnut Oil', ['GNOIL', 'GNCAKE'], ['GNSEED']],
    ['Sesame Oil', ['SESOIL', 'SESCAKE'], ['SESSEED']],
    ['Coconut Oil', ['COCOIL', 'COCCAKE'], ['COPRA']],
  ];

  for (const [name, outputCodes, inputCodes] of defs) {
    const { rows } = await pool.query(
      'INSERT INTO process_definitions (name, category_id) VALUES ($1,$2) RETURNING id',
      [name, oilCat.id]
    );
    const defId = rows[0].id;
    for (const code of outputCodes) {
      const pid = await productId(code);
      if (pid) {
        await pool.query(
          'INSERT INTO process_definition_outputs (process_definition_id, product_id) VALUES ($1,$2)',
          [defId, pid]
        );
      }
    }
    for (const code of inputCodes) {
      const pid = await productId(code);
      if (pid) {
        await pool.query(
          'INSERT INTO process_definition_inputs (process_definition_id, product_id) VALUES ($1,$2)',
          [defId, pid]
        );
      }
    }
  }
  console.log('Seeded process definitions (Groundnut Oil, Sesame Oil, Coconut Oil) with their raw material inputs.');
}

// Existing installs already have Groundnut/Sesame/Coconut Oil process
// definitions seeded from before process_definition_inputs existed — the
// main seedProcessDefinitions() above only runs once (skips if any process
// definitions already exist), so it would never backfill inputs for an
// already-seeded database. This runs every boot and is a no-op once done.
async function backfillProcessDefinitionInputs() {
  const mapping = [
    ['Groundnut Oil', 'GNSEED'],
    ['Sesame Oil', 'SESSEED'],
    ['Coconut Oil', 'COPRA'],
  ];
  for (const [processName, inputCode] of mapping) {
    const def = (await pool.query('SELECT id FROM process_definitions WHERE name=$1', [processName])).rows[0];
    if (!def) continue;
    const existing = (await pool.query('SELECT 1 FROM process_definition_inputs WHERE process_definition_id=$1', [def.id])).rows[0];
    if (existing) continue; // already has an input mapping — don't duplicate
    const product = (await pool.query('SELECT id FROM products WHERE code=$1', [inputCode])).rows[0];
    if (!product) continue;
    await pool.query('INSERT INTO process_definition_inputs (process_definition_id, product_id) VALUES ($1,$2)', [def.id, product.id]);
    console.log(`Backfilled input mapping: ${processName} -> ${inputCode}`);
  }
}

// ---------- Export Module 1: RBAC ----------
// Full role vocabulary for the new multi-role system. Note this is a superset
// of the legacy users.role values (admin/operator/viewer/qc) — those four
// still drive every existing Mill Line permission check unchanged; the new
// roles below only matter to the new Export module's authorization code.
const ALL_ROLE_CODES = [
  ['admin', 'Admin'],
  ['management', 'Management'],
  ['operator', 'Operator'],
  ['supervisor', 'Supervisor'],
  ['viewer', 'Viewer'],
  ['qc', 'Quality Control'],
  ['export_sales', 'Export Sales'],
  ['export_docs', 'Export Documentation'],
  ['purchase', 'Purchase'],
  ['accounts', 'Accounts'],
  ['logistics', 'Logistics'],
];

async function seedRoles() {
  for (const [code, name] of ALL_ROLE_CODES) {
    await pool.query(
      'INSERT INTO roles (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',
      [code, name]
    );
  }
}

// Mirrors every user's legacy users.role into the new user_roles table.
// Safe to run on every boot — ON CONFLICT DO NOTHING means it only ever adds
// a missing mapping, never touches an existing (possibly since-expanded)
// role assignment for a user.
async function backfillUserRoles() {
  await pool.query(`
    INSERT INTO user_roles (user_id, role_id, assigned_by)
    SELECT u.id, r.id, u.id
    FROM users u
    JOIN roles r ON r.code = u.role
    ON CONFLICT (user_id, role_id) DO NOTHING
  `);
}

// ---------- Export Module 2: Master Data ----------
// A small, sensible starting set — not an attempt to guess your actual
// export markets or business terms. Admins extend every one of these lists
// from the Export Setup tab; nothing here is hard-coded into application logic.
async function seedExportMasterData() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM export_currencies');
  if (rows[0].n > 0) return; // already seeded

  console.log('Seeding starter export master data...');

  const currencies = [
    ['USD', 'US Dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'British Pound', '£'],
    ['INR', 'Indian Rupee', '₹'], ['AED', 'UAE Dirham', 'د.إ'],
  ];
  for (const [code, name, symbol] of currencies) {
    await pool.query('INSERT INTO export_currencies (code, name, symbol) VALUES ($1,$2,$3)', [code, name, symbol]);
  }

  const incoterms = [
    ['FOB', 'Free On Board'], ['CFR', 'Cost and Freight'], ['CIF', 'Cost, Insurance and Freight'],
    ['EXW', 'Ex Works'], ['DAP', 'Delivered At Place'],
  ];
  for (const [code, name] of incoterms) {
    await pool.query('INSERT INTO export_incoterms (code, name) VALUES ($1,$2)', [code, name]);
  }

  const containerTypes = [
    ['20FT', 33, 21770], ['40FT', 67, 26500], ['40HC', 76, 26500], ['LCL', null, null],
  ];
  for (const [name, maxCbm, maxWeight] of containerTypes) {
    await pool.query('INSERT INTO export_container_types (name, max_cbm, max_weight_kg) VALUES ($1,$2,$3)', [name, maxCbm, maxWeight]);
  }

  const docTypes = [
    ['quotation', 'QTN'], ['sales_order', 'SO'], ['factory_order', 'FO'],
    ['purchase_requisition', 'PR'], ['purchase_order', 'PO'], ['proforma_invoice', 'PI'],
    ['commercial_invoice', 'INV'], ['packing_list', 'PL'], ['shipment', 'SHP'],
  ];
  for (const [documentType, code] of docTypes) {
    await pool.query(
      'INSERT INTO export_document_number_settings (document_type, prefix, code) VALUES ($1,$2,$3)',
      [documentType, 'KAF', code]
    );
  }

  const supplierCategories = ['Raw Material', 'Packing Material', 'Finished Goods', 'Service Provider'];
  for (const name of supplierCategories) {
    await pool.query('INSERT INTO export_supplier_categories (name) VALUES ($1)', [name]);
  }

  console.log('Export master data seeded (currencies, incoterms, container types, document numbering, supplier categories). Add countries, ports, and payment terms from the Export Setup tab.');
}

// ---------- Export Module 12: Notification rules ----------
// Sensible starting defaults, mapped to the event names from the frozen
// spec. Admins can retarget the recipient role or deactivate any rule from
// the Notifications tab — nothing here is hard-coded into application logic,
// this is just the seed.
async function seedNotificationRules() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM export_notification_rules');
  if (rows[0].n > 0) return;

  const rules = [
    ['QUOTATION_SUBMITTED_FOR_APPROVAL', 'management'],
    ['QUOTATION_APPROVED', 'export_sales'],
    ['QUOTATION_REJECTED', 'export_sales'],
    ['QUOTATION_SENT_TO_CUSTOMER', 'export_sales'],
    ['CUSTOMER_PO_UPLOADED', 'export_sales'],
    ['PO_DIFFERENCE_DETECTED', 'management'],
    ['SALES_ORDER_SUBMITTED_FOR_APPROVAL', 'management'],
    ['SALES_ORDER_APPROVED', 'export_sales'],
    ['SALES_ORDER_REJECTED', 'export_sales'],
    ['CREDIT_LIMIT_EXCEEDED', 'management'],
    ['AMENDMENT_REQUESTED', 'management'],
    ['AMENDMENT_APPROVED', 'export_sales'],
    ['DOCUMENT_RELEASED', 'export_sales'],
  ];
  for (const [eventType, role] of rules) {
    await pool.query(
      'INSERT INTO export_notification_rules (event_type, channel, recipient_role) VALUES ($1,$2,$3)',
      [eventType, 'in_app', role]
    );
  }
  console.log('Seeded default export notification rules.');
}

// ---------- Staff-reported fixes round 2: pack types/sizes ----------
async function seedPackMaster() {
  const typeCount = (await pool.query('SELECT COUNT(*)::int AS n FROM pack_types')).rows[0].n;
  if (typeCount === 0) {
    for (const name of ['Bottle', 'Pouch', 'Tin', 'Case', 'Drum']) {
      await pool.query('INSERT INTO pack_types (name) VALUES ($1)', [name]);
    }
  }
  const sizeCount = (await pool.query('SELECT COUNT(*)::int AS n FROM pack_sizes')).rows[0].n;
  if (sizeCount === 0) {
    // weight_kg values are approximate starting points (oil density ~0.91-0.92
    // kg/L) — admin can correct these from Catalog if a specific product's
    // actual fill weight differs; they only seed the Packing form's
    // auto-calculate default, never enforced.
    const sizes = [
      ['200ml', 0.18], ['500ml', 0.46], ['1L', 0.91], ['5L', 4.55], ['15L', 13.65],
      ['1kg', 1], ['5kg', 5], ['15kg', 15], ['25kg', 25], ['50kg', 50],
    ];
    for (const [label, weight] of sizes) {
      await pool.query('INSERT INTO pack_sizes (label, weight_kg) VALUES ($1,$2)', [label, weight]);
    }
  }
}

// ---------- Urid Dhall Processing: config + output categories ----------
async function seedUridConfig() {
  const defaults = [
    ['mass_balance_tolerance_pct', 0.10],   // Section 7: ±0.10%
    ['min_preprocessing_yield_pct', 90],
    ['max_waste_pct', 5],
    ['max_stage2_loss_pct', 3],
  ];
  for (const [key, value] of defaults) {
    await pool.query('INSERT INTO urid_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }

  const count = (await pool.query('SELECT COUNT(*)::int AS n FROM urid_output_categories')).rows[0].n;
  if (count === 0) {
    // is_recoverable=true means it needs a disposition decision (Section 4)
    // rather than being automatically treated as waste.
    const categories = [
      ['Sand', false], ['Stick / Foreign Matter', false], ['Stone', false],
      ['Karambai / Other Impurity', false], ['Waste', false],
      ['Urid Split Recovered', true], ['Urid Dust', true],
    ];
    for (let i = 0; i < categories.length; i++) {
      const [name, recoverable] = categories[i];
      await pool.query(
        'INSERT INTO urid_output_categories (name, is_recoverable, sort_order) VALUES ($1,$2,$3)',
        [name, recoverable, i]
      );
    }
  }

  // Products this module needs — Raw Urid (sourced), Good Material (Stage 1
  // output / Stage 2 input), and the two recoverable by-products that can be
  // transferred to stock. Whole/Split Urid Dhall (Stage 2 finished outputs)
  // are seeded when Phase 3 (Dhall Processing) is built.
  const uridCat = (await pool.query(
    `INSERT INTO categories (name, code) VALUES ('Urid Dhall Processing','URID') ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`
  )).rows[0];
  const uridProducts = [
    ['Raw Urid', 'URID-RAW', 'raw_material'],
    ['Urid Good Material', 'URID-GOODMAT', 'raw_material'],
    ['Urid Split', 'URID-SPLIT', 'finished_good'],
    ['Urid Dust', 'URID-DUST', 'finished_good'],
    ['Whole Urid Dhall', 'URID-WHOLEDHALL', 'finished_good'],
    ['Split Urid Dhall', 'URID-SPLITDHALL', 'finished_good'],
  ];
  for (const [name, code, kind] of uridProducts) {
    await pool.query(
      `INSERT INTO products (category_id, name, code, kind, unit) VALUES ($1,$2,$3,$4,'kg') ON CONFLICT (code) DO NOTHING`,
      [uridCat.id, name, code, kind]
    );
  }

  const lossReasonCount = (await pool.query('SELECT COUNT(*)::int AS n FROM urid_loss_reasons')).rows[0].n;
  if (lossReasonCount === 0) {
    for (const name of ['Moisture Loss', 'Machine Loss', 'Handling Loss', 'Spillage', 'Sampling', 'Other']) {
      await pool.query('INSERT INTO urid_loss_reasons (name) VALUES ($1)', [name]);
    }
  }

  // Section 17 QC parameters for the finished Urid Dhall products — uses the
  // existing generic quality_parameters system (Catalog tab), same as every
  // other product in this system. Seeded once per product; admin can add
  // more (e.g. Microbiology) or adjust min/max from Catalog anytime.
  const qcParamDefs = {
    'URID-RAW': [
      ['Moisture %', 6, 10], ['Impurities %', 2, 5],
    ],
    'URID-WHOLEDHALL': [
      ['Moisture %', 0, 12], ['Foreign Matter %', 0, 1], ['Broken %', 0, 5],
    ],
    'URID-SPLITDHALL': [
      ['Moisture %', 0, 12], ['Foreign Matter %', 0, 1], ['Broken %', 0, 8], ['Whole/Split Ratio %', 0, 10],
    ],
    'URID-DUST': [
      ['Moisture %', 0, 13], ['Foreign Matter %', 0, 2],
    ],
  };
  for (const [code, params] of Object.entries(qcParamDefs)) {
    const product = (await pool.query('SELECT id FROM products WHERE code=$1', [code])).rows[0];
    if (!product) continue;
    const existing = (await pool.query('SELECT 1 FROM quality_parameters WHERE product_id=$1 LIMIT 1', [product.id])).rows[0];
    if (existing) continue; // already seeded (or admin already configured their own) — don't duplicate
    const stage = code === 'URID-RAW' ? 'raw_material' : 'finished_good';
    for (let i = 0; i < params.length; i++) {
      const [name, minVal, maxVal] = params[i];
      await pool.query(
        'INSERT INTO quality_parameters (product_id, stage, name, unit, min_value, max_value, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [product.id, stage, name, '%', minVal, maxVal, i]
      );
    }
  }
}

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  await seedCatalog();
  await seedProcessDefinitions();
  await backfillProcessDefinitionInputs();
  await seedRoles();
  await seedExportMasterData();
  await seedNotificationRules();
  await seedPackMaster();
  await seedUridConfig();

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Admin';
    const username = (process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin').toLowerCase();
    const pin = process.env.BOOTSTRAP_ADMIN_PIN || '000000';
    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query(
      `INSERT INTO users (name, username, role, pin_hash) VALUES ($1, $2, 'admin', $3)`,
      [name, username, pinHash]
    );
    console.log(`\nBootstrap admin created:\n  username: ${username}\n  PIN: ${pin}\n  -> Log in once with this PIN, then set up a passkey and change the PIN.\n`);
  }

  // Runs every boot: cheap, fully idempotent, catches any user created
  // through a path that doesn't yet know about the new roles system.
  await backfillUserRoles();
}

module.exports = { pool, initSchema };
