const { pool } = require('../db');

// Indian financial year: April 1 – March 31 (Owner Decision 4).
function getCurrentFY(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// Atomic upsert — safe under concurrent requests, never MAX(id)+1 (Section K
// of the frozen architecture). Returns the full formatted number, e.g.
// "KAF/QTN/2026-27/0001".
async function getNextDocumentNumber(documentType) {
  const settings = (await pool.query(
    'SELECT * FROM export_document_number_settings WHERE document_type=$1 AND active=true', [documentType]
  )).rows[0];
  if (!settings) throw new Error(`No numbering configured for "${documentType}" — set it up under Export Setup first.`);

  const fy = getCurrentFY();
  const seq = await pool.query(
    `INSERT INTO export_number_sequences (document_type, financial_year, last_number)
     VALUES ($1,$2,1)
     ON CONFLICT (document_type, financial_year)
     DO UPDATE SET last_number = export_number_sequences.last_number + 1, updated_at = now()
     RETURNING last_number`,
    [documentType, fy]
  );
  const num = seq.rows[0].last_number;
  return `${settings.prefix}/${settings.code}/${fy}/${String(num).padStart(4, '0')}`;
}

module.exports = { getCurrentFY, getNextDocumentNumber };
