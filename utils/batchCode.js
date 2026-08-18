const { pool } = require('../db');

// Creates a batch row and assigns it a readable code like KAF-SESOIL-20260810-000042,
// using the batch's own id as the sequence so codes are always unique.
async function createBatch({ productCode, productId, stage, quantity, unit, originType, createdBy }) {
  const insert = await pool.query(
    `INSERT INTO batches (batch_code, product_id, stage, quantity, remaining_qty, unit, origin_type, created_by)
     VALUES ('PENDING', $1, $2, $3, $3, $4, $5, $6) RETURNING id`,
    [productId, stage, quantity, unit, originType, createdBy]
  );
  const id = insert.rows[0].id;
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const code = `KAF-${productCode}-${dateStr}-${String(id).padStart(6,'0')}`;
  const { rows } = await pool.query('UPDATE batches SET batch_code=$1 WHERE id=$2 RETURNING *', [code, id]);
  return rows[0];
}

module.exports = { createBatch };
