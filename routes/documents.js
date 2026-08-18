const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { fireEvent } = require('../utils/notifications');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB cap

// Approving a document is a review gate; releasing it to the customer is
// deliberately narrower — Owner Decision 9: Export Documentation and
// Management only, not Admin. This is a real security control, not an
// oversight — Admin can do almost everything else in this system, but not this.
const canApprove = requireAnyRole('admin', 'export_docs', 'management');
const canRelease = requireAnyRole('export_docs', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// ---------- List (for a related record, or everything) ----------
router.get('/export/documents', requireLogin, async (req, res) => {
  const { relatedType, relatedId } = req.query;
  const clauses = [];
  const values = [];
  let i = 1;
  if (relatedType) { clauses.push(`related_type=$${i++}`); values.push(relatedType); }
  if (relatedId) { clauses.push(`related_id=$${i++}`); values.push(relatedId); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT d.id, d.related_type, d.related_id, d.category, d.doc_type, d.version_no, d.original_filename,
            d.file_mime_type, d.file_size, d.status, d.internal_only, d.customer_visible,
            d.superseded_by_document_id, d.uploaded_at, d.approved_at, d.released_to_customer_at,
            u1.name AS uploaded_by_name, u2.name AS approved_by_name, u3.name AS released_by_name
     FROM export_documents d
     LEFT JOIN users u1 ON u1.id = d.uploaded_by
     LEFT JOIN users u2 ON u2.id = d.approved_by
     LEFT JOIN users u3 ON u3.id = d.released_by
     ${where} ORDER BY d.related_type, d.related_id, d.doc_type, d.version_no DESC`,
    values
  );
  res.json(rows);
});

// ---------- Upload (creates a new version if one already exists for this related record + doc type) ----------
router.post('/export/documents', requireLogin, upload.single('file'), async (req, res) => {
  const { relatedType, relatedId, category, docType } = req.body || {};
  if (!relatedType || !relatedId || !category || !docType) {
    return res.status(400).json({ error: 'relatedType, relatedId, category, and docType are all required.' });
  }
  if (!req.file) return res.status(400).json({ error: 'A file is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      `SELECT * FROM export_documents WHERE related_type=$1 AND related_id=$2 AND doc_type=$3 ORDER BY version_no DESC LIMIT 1`,
      [relatedType, relatedId, docType]
    )).rows[0];
    const nextVersion = existing ? existing.version_no + 1 : 1;

    const { rows } = await client.query(
      `INSERT INTO export_documents
        (related_type, related_id, category, doc_type, version_no, original_filename, file_mime_type, file_size, file_data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, related_type, related_id, category, doc_type, version_no,
         original_filename, file_mime_type, file_size, status, internal_only, customer_visible, uploaded_at`,
      [relatedType, relatedId, category, docType, nextVersion, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.session.userId]
    );

    if (existing) {
      await client.query(`UPDATE export_documents SET status='superseded', superseded_by_document_id=$1 WHERE id=$2`, [rows[0].id, existing.id]);
    }

    await client.query('COMMIT');
    await logAction(req.session.userId, 'document_uploaded', { relatedType, relatedId, docType, version: nextVersion });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------- Download the actual file ----------
router.get('/export/documents/:id/file', requireLogin, validateIdParams('id'), async (req, res) => {
  const doc = (await pool.query('SELECT * FROM export_documents WHERE id=$1', [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.set('Content-Type', doc.file_mime_type || 'application/octet-stream');
  const disposition = req.query.inline ? 'inline' : 'attachment';
  res.set('Content-Disposition', `${disposition}; filename="${(doc.original_filename || 'document').replace(/"/g, '')}"`);
  res.send(doc.file_data);
});

// ---------- Lifecycle actions ----------
router.patch('/export/documents/:id/approve', canApprove, validateIdParams('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE export_documents SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2 AND status IN ('draft','under_review') RETURNING *`,
    [req.session.userId, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Document not found, or not in a state that can be approved.' });
  await logAction(req.session.userId, 'document_approved', { documentId: Number(req.params.id) });
  res.json(rows[0]);
});

router.patch('/export/documents/:id/release', canRelease, validateIdParams('id'), async (req, res) => {
  const doc = (await pool.query('SELECT * FROM export_documents WHERE id=$1', [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (doc.status !== 'approved') return res.status(400).json({ error: 'Only an approved document can be released to the customer.' });

  const { rows } = await pool.query(
    `UPDATE export_documents SET status='released_to_customer', released_by=$1, released_to_customer_at=now(), customer_visible=true, internal_only=false
     WHERE id=$2 RETURNING *`,
    [req.session.userId, req.params.id]
  );
  await logAction(req.session.userId, 'document_released_to_customer', { documentId: Number(req.params.id) });
  await fireEvent('DOCUMENT_RELEASED', { documentId: Number(req.params.id), docType: doc.doc_type });
  res.json(rows[0]);
});

router.patch('/export/documents/:id/cancel', requireAnyRole('admin', 'export_docs', 'management'), validateIdParams('id'), async (req, res) => {
  const { rows } = await pool.query(`UPDATE export_documents SET status='cancelled' WHERE id=$1 RETURNING *`, [req.params.id]);
  await logAction(req.session.userId, 'document_cancelled', { documentId: Number(req.params.id) });
  res.json(rows[0]);
});

module.exports = router;
