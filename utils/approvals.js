const { pool } = require('../db');

const TERMINAL_DECISIONS = ['approve', 'reject', 'return_for_correction', 'cancel'];

// Condition evaluators are deliberately generic — they read from the
// `context` snapshot stored on the run, never by querying a document table
// directly. This is what keeps one engine reusable across Quotation, Sales
// Order, Purchase Order, etc. without hardcoding any one document's schema.
function stepIsRequired(step, context) {
  if (!step.condition_type) return true; // no condition = always required
  const cfg = step.condition_config || {};
  switch (step.condition_type) {
    case 'value_threshold':
      return Number(context.orderValue ?? 0) > Number(cfg.minValue ?? 0);
    case 'margin_below_min':
      return Number(context.marginPct ?? Infinity) < Number(cfg.minMarginPct ?? -Infinity);
    case 'credit_exceeded':
      return !!context.creditExceeded;
    case 'price_below_min':
      return !!context.priceBelowMinimum;
    case 'po_difference':
      return !!context.poDifference;
    case 'new_customer':
      return !!context.isNewCustomer;
    case 'new_product':
      return !!context.isNewProduct;
    case 'special_packing':
      return !!context.specialPacking;
    case 'shipment_without_advance':
      return !!context.shipmentWithoutAdvance;
    case 'invoice_revision':
      return !!context.invoiceRevision;
    case 'commercial_amendment':
      return !!context.hasCommercialChange;
    case 'mass_balance_variance':
      return !!context.massBalanceExceeded;
    case 'waste_exceeded':
      return !!context.wasteExceeded;
    case 'yield_below_threshold':
      return !!context.yieldBelowThreshold;
    case 'quantity_manually_adjusted':
      return !!context.quantityAdjusted;
    case 'batch_reopened':
      return !!context.isReopened;
    default:
      return true; // unknown condition type — fail safe by requiring it
  }
}

async function getWorkflowWithSteps(workflowId, client = pool) {
  const workflow = (await client.query('SELECT * FROM approval_workflows WHERE id=$1', [workflowId])).rows[0];
  if (!workflow) return null;
  const groups = (await client.query(
    'SELECT * FROM approval_workflow_step_groups WHERE workflow_id=$1 ORDER BY group_order', [workflowId]
  )).rows;
  for (const group of groups) {
    group.steps = (await client.query(
      'SELECT * FROM approval_workflow_steps WHERE step_group_id=$1', [group.id]
    )).rows;
  }
  workflow.groups = groups;
  return workflow;
}

// Required (condition-satisfied) steps for one group, given a context.
function requiredStepsInGroup(group, context) {
  return group.steps.filter(s => stepIsRequired(s, context));
}

// Advances run.current_group_order forward, skipping any group that has no
// required steps for this context, until it finds one with at least one
// required step, or runs out of groups (in which case the run is fully
// approved with nothing left to do).
async function advanceToNextApplicableGroup(client, run, workflow) {
  let groupOrder = run.current_group_order;
  while (true) {
    const group = workflow.groups.find(g => g.group_order === groupOrder);
    if (!group) {
      // no more groups — fully approved
      await client.query(`UPDATE approval_runs SET status='approved', current_group_order=$1 WHERE id=$2`, [groupOrder, run.id]);
      return { ...run, status: 'approved', current_group_order: groupOrder };
    }
    const required = requiredStepsInGroup(group, run.context);
    if (required.length > 0) {
      await client.query(`UPDATE approval_runs SET current_group_order=$1 WHERE id=$2`, [groupOrder, run.id]);
      return { ...run, current_group_order: groupOrder };
    }
    groupOrder += 1; // this group has nothing required — skip it
  }
}

// Starts a new approval run for a document. Throws if no active workflow
// exists for that document_type (Addendum Section 9 — deterministic
// selection means "none configured" is a real, surfaced error, not a silent
// skip).
async function startApprovalRun({ documentType, documentId, context = {}, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workflowRow = (await client.query(
      'SELECT * FROM approval_workflows WHERE document_type=$1 AND active=true', [documentType]
    )).rows[0];
    if (!workflowRow) throw new Error(`No active approval workflow configured for "${documentType}". Set one up under Approvals first.`);

    const workflow = await getWorkflowWithSteps(workflowRow.id, client);
    if (!workflow.groups.length) throw new Error(`Workflow "${workflow.name}" has no approval steps configured.`);

    const insert = await client.query(
      `INSERT INTO approval_runs (workflow_id, document_type, document_id, context, current_group_order, status, created_by)
       VALUES ($1,$2,$3,$4,1,'pending',$5) RETURNING *`,
      [workflow.id, documentType, documentId, JSON.stringify(context), createdBy]
    );
    let run = insert.rows[0];
    run.context = context;
    run = await advanceToNextApplicableGroup(client, run, workflow);

    await client.query('COMMIT');
    return run;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Records one approver's decision against one exact workflow step.
async function recordAction({ runId, workflowStepId, approverId, approverRoles, decision, comment }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const run = (await client.query('SELECT * FROM approval_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    if (!run) throw new Error('Approval run not found.');
    if (run.status !== 'pending') throw new Error(`This approval is already ${run.status} — no further action can be recorded on it.`);

    const step = (await client.query('SELECT * FROM approval_workflow_steps WHERE id=$1', [workflowStepId])).rows[0];
    if (!step) throw new Error('Approval step not found.');

    const group = (await client.query('SELECT * FROM approval_workflow_step_groups WHERE id=$1', [step.step_group_id])).rows[0];
    if (!group || group.workflow_id !== run.workflow_id) throw new Error('That step does not belong to this approval run.');
    if (group.group_order !== run.current_group_order) throw new Error('That step is not part of the current pending group.');
    // group.steps is NOT populated by the raw query above (only
    // getWorkflowWithSteps attaches it) — requiredStepsInGroup() needs it,
    // so fetch it explicitly here.
    group.steps = (await client.query('SELECT * FROM approval_workflow_steps WHERE step_group_id=$1', [group.id])).rows;

    if (!approverRoles.includes(step.role_required)) {
      throw new Error(`Only a "${step.role_required}" can act on this step.`);
    }

    await client.query(
      'INSERT INTO approval_actions (approval_run_id, workflow_step_id, approver_id, decision, comment) VALUES ($1,$2,$3,$4,$5)',
      [runId, workflowStepId, approverId, decision, comment || null]
    );

    let updatedRun = run;
    if (decision === 'reject') {
      updatedRun = (await client.query(`UPDATE approval_runs SET status='rejected' WHERE id=$1 RETURNING *`, [runId])).rows[0];
    } else if (decision === 'return_for_correction') {
      updatedRun = (await client.query(`UPDATE approval_runs SET status='returned' WHERE id=$1 RETURNING *`, [runId])).rows[0];
    } else if (decision === 'cancel') {
      updatedRun = (await client.query(`UPDATE approval_runs SET status='cancelled' WHERE id=$1 RETURNING *`, [runId])).rows[0];
    } else if (decision === 'clarification_requested') {
      // Run stays 'pending' at the same group — nothing to update here.
      // The clarification_requested action itself was already recorded above.
    } else if (decision === 'approve') {
      const workflow = await getWorkflowWithSteps(run.workflow_id, client);
      const required = requiredStepsInGroup(group, run.context);
      const actionsForRun = (await client.query(
        `SELECT workflow_step_id FROM approval_actions WHERE approval_run_id=$1 AND decision='approve'`, [runId]
      )).rows.map(r => r.workflow_step_id);
      const requiredIds = required.map(s => s.id);
      const approvedRequiredIds = requiredIds.filter(id => actionsForRun.includes(id) || id === workflowStepId);

      const groupSatisfied = group.group_rule === 'ALL'
        ? requiredIds.every(id => approvedRequiredIds.includes(id))
        : approvedRequiredIds.length > 0;

      if (groupSatisfied) {
        updatedRun = await advanceToNextApplicableGroup(client, { ...run, current_group_order: run.current_group_order + 1 }, workflow);
      }
    }

    await client.query('COMMIT');
    return updatedRun;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Creates a fresh run linked to a closed one, preserving the full history
// chain (Addendum Section 1 — "resubmission must retain previous history").
async function resubmitApprovalRun({ previousRunId, context, createdBy }) {
  const prev = (await pool.query('SELECT * FROM approval_runs WHERE id=$1', [previousRunId])).rows[0];
  if (!prev) throw new Error('Original approval run not found.');
  if (prev.status === 'pending' || prev.status === 'approved') {
    throw new Error('Only a rejected, returned, or cancelled run can be resubmitted.');
  }
  const newRun = await startApprovalRun({
    documentType: prev.document_type, documentId: prev.document_id,
    context: context || prev.context, createdBy,
  });
  await pool.query('UPDATE approval_runs SET previous_run_id=$1 WHERE id=$2', [previousRunId, newRun.id]);
  return { ...newRun, previous_run_id: previousRunId };
}

// Pending steps for a user, across every document type — this is the "My
// Approvals" inbox. Returns one row per (run, step) the user can currently
// act on — i.e. required by the run's context, in the run's current group,
// matching one of the user's roles, and not already terminally decided.
async function getPendingStepsForUser(userRoles) {
  const pendingRuns = (await pool.query(
    `SELECT r.*, w.name AS workflow_name FROM approval_runs r
     JOIN approval_workflows w ON w.id = r.workflow_id
     WHERE r.status = 'pending' ORDER BY r.created_at`
  )).rows;

  const results = [];
  for (const run of pendingRuns) {
    const group = (await pool.query(
      'SELECT * FROM approval_workflow_step_groups WHERE workflow_id=$1 AND group_order=$2',
      [run.workflow_id, run.current_group_order]
    )).rows[0];
    if (!group) continue;
    const steps = (await pool.query('SELECT * FROM approval_workflow_steps WHERE step_group_id=$1', [group.id])).rows;
    const required = steps.filter(s => stepIsRequired(s, run.context) && userRoles.includes(s.role_required));
    if (!required.length) continue;

    const alreadyActioned = (await pool.query(
      `SELECT workflow_step_id FROM approval_actions WHERE approval_run_id=$1 AND decision IN ('approve','reject','return_for_correction','cancel')`,
      [run.id]
    )).rows.map(r => r.workflow_step_id);

    for (const step of required) {
      if (alreadyActioned.includes(step.id)) continue;
      results.push({
        approvalRunId: run.id, workflowStepId: step.id, roleRequired: step.role_required,
        groupOrder: group.group_order, groupRule: group.group_rule,
        documentType: run.document_type, documentId: run.document_id,
        workflowName: run.workflow_name, context: run.context, createdAt: run.created_at,
      });
    }
  }
  return results;
}

module.exports = {
  TERMINAL_DECISIONS, stepIsRequired, getWorkflowWithSteps,
  startApprovalRun, recordAction, resubmitApprovalRun, getPendingStepsForUser,
};
