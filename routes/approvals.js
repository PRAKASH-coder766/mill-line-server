const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');
const {
  startApprovalRun, recordAction, resubmitApprovalRun, getPendingStepsForUser, getWorkflowWithSteps,
} = require('../utils/approvals');

const router = express.Router();

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// ---------- Workflow configuration (admin — this is system configuration, per Owner Decision 2) ----------
router.get('/export/approval-workflows', requireRole('admin'), async (req, res) => {
  const workflows = (await pool.query('SELECT * FROM approval_workflows ORDER BY document_type, name')).rows;
  for (const wf of workflows) {
    const full = await getWorkflowWithSteps(wf.id);
    wf.groups = full.groups;
  }
  res.json(workflows);
});

// body: { name, documentType, stepGroups: [{ groupOrder, groupRule, steps: [{ roleRequired, conditionType, conditionConfig }] }] }
router.post('/export/approval-workflows', requireRole('admin'), async (req, res) => {
  const { name, documentType, stepGroups } = req.body || {};
  if (!name || !documentType || !Array.isArray(stepGroups) || !stepGroups.length) {
    return res.status(400).json({ error: 'Name, document type, and at least one step group are required.' });
  }
  const validDocTypes = ['quotation', 'customer_po', 'sales_order', 'sales_order_amendment', 'purchase_order', 'commercial_invoice', 'payment_adjustment', 'urid_preprocessing', 'urid_dhall_processing'];
  if (!validDocTypes.includes(documentType)) {
    return res.status(400).json({ error: `Document type must be one of: ${validDocTypes.join(', ')}.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wf = (await client.query(
      'INSERT INTO approval_workflows (name, document_type, created_by) VALUES ($1,$2,$3) RETURNING *',
      [name, documentType, req.session.userId]
    )).rows[0];

    for (const group of stepGroups) {
      const groupRow = (await client.query(
        'INSERT INTO approval_workflow_step_groups (workflow_id, group_order, group_rule) VALUES ($1,$2,$3) RETURNING *',
        [wf.id, group.groupOrder, group.groupRule || 'ALL']
      )).rows[0];
      for (const step of (group.steps || [])) {
        if (!step.roleRequired) throw new Error('Every step needs a role.');
        await client.query(
          'INSERT INTO approval_workflow_steps (step_group_id, role_required, condition_type, condition_config) VALUES ($1,$2,$3,$4)',
          [groupRow.id, step.roleRequired, step.conditionType || null, step.conditionConfig ? JSON.stringify(step.conditionConfig) : null]
        );
      }
    }
    await client.query('COMMIT');
    await logAction(req.session.userId, 'approval_workflow_created', { name, documentType });
    res.json(wf);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'An active workflow already exists for this document type — deactivate it first, or that workflow name is already taken.' });
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/export/approval-workflows/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  try {
    const { rows } = await pool.query('UPDATE approval_workflows SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another workflow is already active for this document type — deactivate it first.' });
    throw err;
  }
});

// ---------- My Approvals (cross-document inbox) ----------
router.get('/export/approvals/pending', requireLogin, async (req, res) => {
  const pending = await getPendingStepsForUser(req.session.roles || []);
  res.json(pending);
});

// Full history for one run (used by "view" on an inbox item, and by document
// detail screens once Quotation/SO exist).
router.get('/export/approvals/:runId', requireLogin, validateIdParams('runId'), async (req, res) => {
  const run = (await pool.query(
    `SELECT r.*, w.name AS workflow_name FROM approval_runs r JOIN approval_workflows w ON w.id=r.workflow_id WHERE r.id=$1`,
    [req.params.runId]
  )).rows[0];
  if (!run) return res.status(404).json({ error: 'Approval run not found.' });

  run.actions = (await pool.query(
    `SELECT a.*, u.name AS approver_name, s.role_required FROM approval_actions a
     JOIN users u ON u.id = a.approver_id JOIN approval_workflow_steps s ON s.id = a.workflow_step_id
     WHERE a.approval_run_id=$1 ORDER BY a.decided_at`,
    [req.params.runId]
  )).rows;
  res.json(run);
});

// body: { decision, comment }
router.post('/export/approvals/:runId/steps/:stepId/action', requireLogin, validateIdParams('runId', 'stepId'), async (req, res) => {
  const { decision, comment } = req.body || {};
  if (!decision) return res.status(400).json({ error: 'Decision is required.' });
  try {
    const run = await recordAction({
      runId: Number(req.params.runId), workflowStepId: Number(req.params.stepId),
      approverId: req.session.userId, approverRoles: req.session.roles || [], decision, comment,
    });
    await logAction(req.session.userId, 'approval_action_recorded', { runId: req.params.runId, stepId: req.params.stepId, decision });
    res.json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/export/approvals/:runId/resubmit', requireLogin, validateIdParams('runId'), async (req, res) => {
  try {
    const newRun = await resubmitApprovalRun({
      previousRunId: Number(req.params.runId), context: req.body?.context, createdBy: req.session.userId,
    });
    await logAction(req.session.userId, 'approval_resubmitted', { previousRunId: req.params.runId, newRunId: newRun.id });
    res.json(newRun);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Standalone test harness ----------
// Quotation/Sales Order don't exist yet (Modules 7/9), so this lets the
// engine be exercised end-to-end now, per the build plan's "tested standalone
// against a dummy document type" note. Admin only, clearly logged as a test.
router.post('/export/approvals/test-run', requireRole('admin'), async (req, res) => {
  const { documentType, context } = req.body || {};
  if (!documentType) return res.status(400).json({ error: 'documentType is required.' });
  try {
    const run = await startApprovalRun({
      documentType, documentId: 999999999, context: context || {}, createdBy: req.session.userId,
    });
    await logAction(req.session.userId, 'approval_test_run_started', { documentType, context });
    res.json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
