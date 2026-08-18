const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

async function enrichBatch(batchId) {
  const batch = (await pool.query(
    `SELECT b.*, p.name AS product_name, p.code AS product_code, c.name AS category_name
     FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id
     WHERE b.id=$1`, [batchId]
  )).rows[0];
  if (!batch) return null;

  batch.sourcing = (await pool.query('SELECT * FROM sourcing_records WHERE batch_id=$1', [batchId])).rows[0] || null;

  const inspections = (await pool.query(
    `SELECT qi.*, u.name AS inspector_name FROM quality_inspections qi
     LEFT JOIN users u ON u.id=qi.inspector_id WHERE qi.batch_id=$1 ORDER BY qi.created_at DESC`,
    [batchId]
  )).rows;
  batch.inspections = inspections;

  batch.dispatches = (await pool.query('SELECT * FROM dispatch WHERE batch_id=$1', [batchId])).rows;

  const producedBy = (await pool.query(
    `SELECT pr.* FROM processing_outputs po JOIN processing_runs pr ON pr.id = po.processing_run_id WHERE po.batch_id=$1`,
    [batchId]
  )).rows[0] || null;
  batch.producedByRun = producedBy;

  return batch;
}

router.get('/trace/:code', requireLogin, async (req, res) => {
  const root = (await pool.query('SELECT * FROM batches WHERE batch_code=$1', [req.params.code])).rows[0];
  if (!root) return res.status(404).json({ error: 'No batch found with that code.' });

  const lineage = (await pool.query('SELECT * FROM batch_lineage')).rows;
  const parentsOf = {}, childrenOf = {};
  for (const l of lineage) {
    (childrenOf[l.parent_batch_id] ||= []).push(l.child_batch_id);
    (parentsOf[l.child_batch_id] ||= []).push(l.parent_batch_id);
  }

  function walk(startId, map) {
    const visited = new Set([startId]);
    const queue = [startId];
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      for (const next of (map[id] || [])) {
        if (!visited.has(next)) {
          visited.add(next);
          order.push(next);
          queue.push(next);
        }
      }
    }
    return order;
  }

  const upstreamIds = walk(root.id, parentsOf);   // raw materials this batch traces back to
  const downstreamIds = walk(root.id, childrenOf); // what this batch became / where it went

  const [rootFull, upstream, downstream] = await Promise.all([
    enrichBatch(root.id),
    Promise.all(upstreamIds.map(enrichBatch)),
    Promise.all(downstreamIds.map(enrichBatch)),
  ]);

  res.json({ batch: rootFull, upstream, downstream, edges: lineage });
});

module.exports = router;
