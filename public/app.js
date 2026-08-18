let me = null;
let activeTab = "mytasks";
let categories = [], products = [], stock = [], pendingQC = [], sourcingRows = [], processingRows = [], dispatchRows = [];
let suppliers = [], processDefs = [], packingRows = [];

function fmt(n){ return (Math.round((Number(n)||0)*100)/100).toLocaleString(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function nowTimeStr(){ const d=new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

async function api(path, opts={}) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  const body = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

// ---------------- AUTH (unchanged pattern) ----------------
async function checkSession(){
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(r=>r.json());
  if (res.loggedIn) { me = res; await enterApp(); }
  else { document.getElementById('loginScreen').style.display = 'flex'; document.getElementById('appRoot').style.display = 'none'; }
}
let pendingMfaUsername = null;
let mfaSetupNagPending = false;
async function loginWithPin(){
  const username = document.getElementById('login-username').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  const errEl = document.getElementById('loginError'); errEl.textContent = '';
  try {
    const r = await api('/auth/login-pin', { method:'POST', body: JSON.stringify({ username, pin }) });
    if (r.mfaRequired) {
      pendingMfaUsername = username;
      errEl.style.color = '';
      errEl.textContent = 'PIN correct — verify your passkey to finish signing in.';
      await completeMfaWithPasskey();
      return;
    }
    mfaSetupNagPending = !!r.mfaSetupRequired;
    me = { name:r.name, role:r.role, roles:r.roles||[], username };
    await enterApp();
  }
  catch(e){ errEl.textContent = e.message; }
}
async function completeMfaWithPasskey(){
  const errEl = document.getElementById('loginError');
  try {
    const options = await api('/auth/login-options', { method:'POST', body: JSON.stringify({ username: pendingMfaUsername }) });
    const cred = await navigator.credentials.get({ publicKey: prepareAuthenticationOptions(options) });
    const payload = serializeAuthenticationCredential(cred);
    const r = await api('/auth/login-verify', { method:'POST', body: JSON.stringify({ response: payload }) });
    me = { name:r.name, role:r.role, roles:r.roles||[], username: pendingMfaUsername };
    pendingMfaUsername = null;
    await enterApp();
  } catch(e){ errEl.textContent = (e.name==='NotAllowedError') ? 'Biometric check was cancelled or did not match — sign-in was not completed.' : e.message; }
}
async function loginWithPasskey(){
  const username = document.getElementById('login-username').value.trim();
  const errEl = document.getElementById('loginError'); errEl.textContent = '';
  if (!username) { errEl.textContent = 'Enter your username first.'; return; }
  try {
    const options = await api('/auth/login-options', { method:'POST', body: JSON.stringify({ username }) });
    const cred = await navigator.credentials.get({ publicKey: prepareAuthenticationOptions(options) });
    const payload = serializeAuthenticationCredential(cred);
    const r = await api('/auth/login-verify', { method:'POST', body: JSON.stringify({ response: payload }) });
    me = { name:r.name, role:r.role, roles:r.roles||[], username }; await enterApp();
  } catch(e){ errEl.textContent = (e.name==='NotAllowedError') ? 'Biometric check was cancelled or did not match.' : e.message; }
}
async function logout(){ await api('/auth/logout', { method:'POST' }); location.reload(); }
function showAddPasskey(){ document.getElementById('passkeyModal').style.display='flex'; document.getElementById('passkeyError').textContent=''; }
function closeModal(){ document.getElementById('passkeyModal').style.display='none'; }
async function registerPasskey(){
  const errEl = document.getElementById('passkeyError'); errEl.textContent='';
  const deviceName = document.getElementById('deviceName').value.trim() || 'Unnamed device';
  try {
    const options = await api('/auth/register-options', { method:'POST' });
    const cred = await navigator.credentials.create({ publicKey: prepareRegistrationOptions(options) });
    const payload = serializeRegistrationCredential(cred);
    await api('/auth/register-verify', { method:'POST', body: JSON.stringify({ response: payload, deviceName }) });
    closeModal(); alert('Passkey registered. Next time, sign in with fingerprint / Face ID instead of your PIN.');
  } catch(e){ errEl.textContent = e.message; }
}

function canWrite(){ return ['admin','operator'].includes(me.role); }
function canQC(){ return ['admin','qc'].includes(me.role); }
function isAdmin(){ return me.role === 'admin'; }
// New multi-role check for Export module screens — checks the roles ARRAY
// (management/export_sales/export_docs/purchase/accounts/logistics/etc.),
// completely separate from the legacy single `me.role` used above.
function hasAnyRole(...codes){ return (me.roles||[]).some(c => codes.includes(c)); }

// ---------------- APP SHELL ----------------
async function enterApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = 'block';
  document.getElementById('whoName').textContent = me.name;
  document.getElementById('whoRole').textContent = me.role;
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  const nagBanner = document.getElementById('mfaNagBanner');
  if (nagBanner) nagBanner.style.display = mfaSetupNagPending ? 'block' : 'none';
  await loadCatalog();
  await render();
  startNotificationPolling();
}

async function loadCatalog(){
  [categories, products, suppliers, processDefs] = await Promise.all([
    api('/categories'), api('/products'), api('/suppliers'), api('/process-definitions'),
  ]);
}

// ---------------- GLOBAL SEARCH ----------------
let globalSearchTimeout = null;
function onGlobalSearchInput(value){
  clearTimeout(globalSearchTimeout);
  const box = document.getElementById('globalSearchResults');
  if (!value || value.trim().length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
  globalSearchTimeout = setTimeout(async () => {
    try {
      const results = await api(`/export/search?q=${encodeURIComponent(value.trim())}`);
      box.innerHTML = results.length === 0
        ? `<div style="padding:10px;color:#888;">No matches</div>`
        : results.map(r => `<div style="padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;" onclick="goToSearchResult('${r.type}',${r.id})">
             <strong>${r.label}</strong><div class="sub">${r.sub || ''} · ${r.type.replace('_',' ')}</div></div>`).join('');
      box.style.display = 'block';
    } catch (e) { /* ignore transient search errors */ }
  }, 250);
}
async function goToSearchResult(type, id){
  document.getElementById('globalSearchResults').style.display = 'none';
  document.getElementById('globalSearchInput').value = '';
  if (type === 'quotation') { activeTab = 'quotations'; await render(); await openQuotationDetail(id); }
  else if (type === 'customer_po') { activeTab = 'customerpos'; await render(); await openPODetail(id); }
  else if (type === 'sales_order') { activeTab = 'salesorders'; await render(); await openSODetail(id); }
  else if (type === 'customer') { activeTab = 'customers'; await render(); await openCustomerDetail(id); }
  else if (type === 'product_variant') { activeTab = 'variants'; await render(); await openVariantDetail(id); }
}
document.addEventListener('click', (e) => {
  const searchWrap = document.querySelector('.global-search-wrap');
  if (searchWrap && !searchWrap.contains(e.target)) {
    const box = document.getElementById('globalSearchResults');
    if (box) box.style.display = 'none';
  }
  const notifWrap = document.querySelector('.notif-bell-wrap');
  if (notifWrap && !notifWrap.contains(e.target)) {
    const box = document.getElementById('notifDropdown');
    if (box) box.style.display = 'none';
  }
});

// ---------------- NOTIFICATION BELL ----------------
let notifPollInterval = null;
let notifCache = [];
function startNotificationPolling(){
  refreshNotifBadge();
  if (notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(refreshNotifBadge, 30000);
}
async function refreshNotifBadge(){
  try {
    notifCache = await api('/export/notifications/mine');
    const unread = notifCache.filter(n => !n.read_at).length;
    const badge = document.getElementById('notifBadge');
    if (badge) { badge.style.display = unread > 0 ? 'inline' : 'none'; badge.textContent = unread; }
  } catch (e) { /* not logged in yet, or transient error — ignore */ }
}
function toggleNotificationDropdown(){
  const box = document.getElementById('notifDropdown');
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  renderNotifDropdown();
  box.style.display = 'block';
}
function renderNotifDropdown(){
  const box = document.getElementById('notifDropdown');
  const recent = notifCache.slice(0, 8);
  box.innerHTML = (recent.length === 0 ? `<div style="padding:8px;color:#888;">Nothing yet.</div>` : recent.map(n => `
    <div style="padding:8px 0;border-bottom:1px solid var(--line);${n.read_at ? 'opacity:0.5;' : ''}">
      <strong>${n.event_type.replace(/_/g,' ')}</strong><div class="sub">${JSON.stringify(n.payload)}</div>
      ${n.read_at ? '' : `<span class="del" onclick="markNotifFromBell(${n.id})">mark read</span>`}
    </div>`).join(''))
    + `<div style="padding-top:8px;"><span class="del" onclick="document.getElementById('notifDropdown').style.display='none'; activeTab='notifications'; render();">View all →</span></div>`;
}
async function markNotifFromBell(id){
  try { await api(`/export/notifications/${id}/read`, { method:'PATCH' }); await refreshNotifBadge(); renderNotifDropdown(); }
  catch (e) { /* ignore */ }
}

function rawMaterials(){ return products.filter(p=>p.kind==='raw_material'); }
function finishedGoods(){ return products.filter(p=>p.kind==='finished_good'); }
function productName(id){ const p = products.find(p=>p.id===Number(id)); return p ? p.name : '—'; }

function note(text, isError){
  const el = document.getElementById('statusNote');
  el.textContent = text; el.className = 'status-note ' + (isError ? 'error-flash' : 'save-flash');
}

const STATUS_LABEL = { pending_qc:'Pending QC', approved:'Approved', on_hold:'On Hold', rejected:'Rejected', consumed:'Consumed', dispatched:'Dispatched' };
const STATUS_CLASS = { pending_qc:'high', approved:'ok', on_hold:'high', rejected:'high', consumed:'raw', dispatched:'oil' };
function statusPill(status){ return `<span class="tag-pill ${STATUS_CLASS[status]||'raw'}">${STATUS_LABEL[status]||status}</span>`; }

// ---------------- MY TASKS (dashboard landing page) ----------------
async function myTasksHTML(){
  const [pendingApprovals, quotationsList, poList, soList] = await Promise.all([
    api('/export/approvals/pending'), api('/export/quotations'), api('/export/customer-pos'), api('/export/sales-orders'),
  ]);
  const myDrafts = quotationsList.filter(q => q.status === 'draft');
  const posUncompared = poList.filter(p => p.status === 'uploaded');
  const posNeedingApproval = poList.filter(p => p.status === 'differences_pending_approval');
  const soNeedingAction = soList.filter(s => ['draft', 'pending_approval'].includes(s.status));
  const actionCount = pendingApprovals.length + posUncompared.length + posNeedingApproval.length;

  return `
    <div class="panel">
      <h2>⚠️ Action Required <span class="sub">${actionCount} item${actionCount===1?'':'s'}</span></h2>
      ${actionCount === 0 ? `<div class="empty">Nothing needs your attention right now.</div>` : `
      <div class="table-scroll"><table><thead><tr><th>What</th><th>Detail</th><th></th></tr></thead><tbody>
        ${pendingApprovals.map(p=>`<tr>
          <td><span class="tag-pill high">Approval pending</span></td>
          <td>${(DOC_TYPE_LABELS[p.documentType]||p.documentType)} #${p.documentId} — your role: ${p.roleRequired}</td>
          <td><span class="del" onclick="activeTab='approvals'; render();">review</span></td>
        </tr>`).join('')}
        ${posUncompared.map(p=>`<tr>
          <td><span class="tag-pill high">PO not yet compared</span></td>
          <td>${p.po_no} — ${p.customer_name}</td>
          <td><span class="del" onclick="activeTab='customerpos'; render();">open</span></td>
        </tr>`).join('')}
        ${posNeedingApproval.map(p=>`<tr>
          <td><span class="tag-pill high">PO differences pending approval</span></td>
          <td>${p.po_no} — ${p.customer_name}</td>
          <td><span class="del" onclick="activeTab='customerpos'; render();">open</span></td>
        </tr>`).join('')}
      </tbody></table></div>`}
    </div>
    <div class="panel">
      <h2>My quotation drafts <span class="sub">${myDrafts.length}</span></h2>
      ${myDrafts.length===0 ? `<div class="empty">None in draft.</div>` : `
      <div class="hint">${myDrafts.map(q=>`${q.quotation_no} — ${q.customer_name}`).join('<br>')}</div>`}
    </div>
    <div class="panel">
      <h2>Sales Orders needing attention <span class="sub">${soNeedingAction.length}</span></h2>
      ${soNeedingAction.length===0 ? `<div class="empty">None.</div>` : `
      <div class="hint">${soNeedingAction.map(s=>`${s.so_no} — ${s.customer_name} (${SO_STATUS_LABEL[s.status]||s.status})`).join('<br>')}</div>`}
    </div>
  `;
}

// ---------------- OVERVIEW ----------------
async function overviewHTML(){
  stock = await api('/stock');
  pendingQC = await api('/quality/pending');

  const raw = stock.filter(s=>s.kind==='raw_material');
  const fg = stock.filter(s=>s.kind==='finished_good');

  return `
    ${pendingQC.length ? `<div class="panel" style="border-left:4px solid var(--alert);">
      <strong style="color:var(--alert);">${pendingQC.length} batch${pendingQC.length>1?'es':''} waiting on QC</strong> —
      <a href="#" onclick="event.preventDefault(); activeTab='quality'; render();">go to Quality</a>
    </div>` : ''}
    <div class="panel">
      <h2>Raw material stock <span class="sub">approved batches on hand</span></h2>
      <div class="kpi-grid">
        ${raw.map(s=>`<div class="kpi raw"><div class="k-label">${s.product_name}</div><div class="k-value">${fmt(s.stock_on_hand)}<span class="k-unit">${s.unit}</span></div>
          ${s.pending_qc_batches?`<div class="hint">${s.pending_qc_batches} pending QC</div>`:''}</div>`).join('') || '<div class="empty">No raw material batches yet.</div>'}
      </div>
    </div>
    <div class="panel">
      <h2>Finished goods stock <span class="sub">approved batches on hand</span></h2>
      <div class="kpi-grid">
        ${fg.map(s=>`<div class="kpi oil"><div class="k-label">${s.product_name}</div><div class="k-value">${fmt(s.stock_on_hand)}<span class="k-unit">${s.unit}</span></div>
          ${s.pending_qc_batches?`<div class="hint">${s.pending_qc_batches} pending QC</div>`:''}</div>`).join('') || '<div class="empty">No finished-good batches yet.</div>'}
      </div>
    </div>
  `;
}

// ---------------- SOURCING ----------------
function minSourcingDate(){
  if (isAdmin()) return ''; // admins can backdate freely
  const d = new Date(); d.setDate(d.getDate() - 15);
  return d.toISOString().slice(0,10);
}

async function sourcingHTML(){
  sourcingRows = await api('/sourcing');
  const currentSupplier = suppliers.find(s=>s.id===Number(selectedSourcingSupplierId));
  const rms = (currentSupplier?.productIds?.length) ? rawMaterials().filter(p=>currentSupplier.productIds.includes(p.id)) : rawMaterials();
  const minDate = minSourcingDate();
  const formHTML = canWrite() ? `
    <div class="panel">
      <h2>Log a purchase <span class="sub">raw material coming in · <span class="req-star">*</span> required</span></h2>
      <div class="form-grid">
        <div class="field"><label>Product <span class="req-star">*</span> ${currentSupplier?.productIds?.length ? `<span class="sub">only what this supplier provides</span>` : ''}</label><select id="src-product">${rms.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
        <div class="field"><label>Date <span class="req-star">*</span></label><input type="date" id="src-date" value="${todayStr()}" ${minDate?`min="${minDate}"`:''}>
          ${!isAdmin() ? `<div class="hint">Dates older than 15 days need an admin.</div>` : ''}
        </div>
        <div class="field"><label>Supplier <span class="req-star">*</span></label>
          <select id="src-supplier" onchange="onSupplierChange(this.value)">
            <option value="">Select supplier…</option>
            ${suppliers.map(s=>`<option value="${s.id}" ${selectedSourcingSupplierId==s.id?'selected':''}>${s.name}${s.company_name?` (${s.company_name})`:''}</option>`).join('')}
          </select>
          ${isAdmin() ? `<div class="hint">New supplier? Add it under Catalog.</div>` : ''}
        </div>
        <div class="field"><label>Supplier batch/lot no.</label><input type="text" id="src-supbatch" placeholder="auto-suggested on supplier select"></div>
        <div class="field"><label>Origin <span class="req-star">*</span></label><input type="text" id="src-origin" placeholder="auto-fills from supplier address"></div>
        <div class="field"><label>Number of bags <span class="req-star">*</span></label><input type="number" id="src-bags" min="0" step="1" oninput="updateGunnyPreview()"></div>
        <div class="field"><label>Sack weight / bag (kg) <span class="req-star">*</span></label><input type="number" id="src-sackweight" min="0" step="0.01" oninput="updateGunnyPreview()"></div>
        <div class="field"><label>Gross weight (kg) <span class="req-star">*</span></label><input type="number" id="src-gross" min="0" step="0.01"></div>
        <div class="field"><label>Gunny sack weight (kg)</label><input type="text" id="src-gunny-preview" value="0" disabled>
          <div class="hint">auto = bags × sack weight</div>
        </div>
        <div class="field"><label>Rate (₹/kg net) <span class="req-star">*</span></label><input type="number" id="src-rate" min="0" step="0.01"></div>
        <div class="field"><label>Notes</label><input type="text" id="src-notes" placeholder="optional"></div>
        <button class="btn" onclick="addSourcing()">Add purchase</button>
      </div>
      <div class="hint">This creates a new batch (pending QC) — record the incoming inspection from the Quality tab.</div>
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>Purchase log <span class="sub">${sourcingRows.length} batches</span></h2>
      ${sourcingRows.length===0 ? `<div class="empty">No purchases logged yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Batch code</th><th>Date</th><th>Product</th><th>Supplier</th><th>Origin</th><th>Net Wt</th><th>Rate</th><th>Status</th></tr></thead>
        <tbody>${sourcingRows.map(r=>`<tr>
          <td>${r.batch_code}</td><td>${r.date.slice(0,10)}</td><td>${r.product_name}</td><td>${r.supplier_name||r.supplier}</td><td>${r.origin}</td>
          <td>${fmt(r.net_weight)} kg</td><td>₹${fmt(r.rate)}</td><td>${statusPill(r.status)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>`;
}

function updateGunnyPreview(){
  const bags = Number(document.getElementById('src-bags')?.value || 0);
  const sackWeight = Number(document.getElementById('src-sackweight')?.value || 0);
  const el = document.getElementById('src-gunny-preview');
  if (el) el.value = fmt(bags * sackWeight);
}

let selectedSourcingSupplierId = '';
async function onSupplierChange(supplierId){
  selectedSourcingSupplierId = supplierId;
  if (!supplierId) { await render(); return; }
  const supplier = suppliers.find(s=>s.id===Number(supplierId));
  await render();
  if (supplier) document.getElementById('src-origin').value = supplier.address || '';
  try {
    const { suggestion } = await api(`/suppliers/${supplierId}/next-batch-no`);
    document.getElementById('src-supbatch').value = suggestion || '';
  } catch(e){ /* non-fatal */ }
}

async function addSourcing(){
  const v = id => document.getElementById(id).value;
  const body = {
    productId: Number(v('src-product')), date: v('src-date')||todayStr(), supplierId: Number(v('src-supplier')),
    supplierBatchNo: v('src-supbatch').trim(), origin: v('src-origin').trim(), bags: Number(v('src-bags')),
    sackWeight: Number(v('src-sackweight')), grossWeight: Number(v('src-gross')),
    rate: Number(v('src-rate')), notes: v('src-notes').trim(),
  };
  if (!body.supplierId) { alert('Select a supplier.'); return; }
  try { const r = await api('/sourcing', { method:'POST', body: JSON.stringify(body) }); note(`Saved as batch ${r.batch_code}`); await render(); }
  catch(e){ alert(e.message); }
}


// ---------------- PROCESSING ----------------
let processingInputRows = [];
let processingOutputRows = [];
let selectedProcessDefId = '';

async function processingHTML(){
  processingRows = await api('/processing');
  const approvedRawAll = await api('/batches?stage=raw_material&status=approved');
  const currentDef = processDefs.find(d=>d.id===Number(selectedProcessDefId));
  // If the selected process defines specific raw material inputs (e.g.
  // Coconut Oil -> Copra only), restrict the picker to those — otherwise
  // fall back to showing every approved raw batch (processes with no input
  // mapping configured yet aren't blocked).
  const allowedInputProductIds = currentDef?.inputs?.length ? new Set(currentDef.inputs.map(p=>p.id)) : null;
  const approvedRaw = allowedInputProductIds ? approvedRawAll.filter(b=>allowedInputProductIds.has(b.product_id)) : approvedRawAll;

  if (canWrite() && processingInputRows.length===0) processingInputRows = [{ batchId:'', qty:'' }];

  const totalIn = processingInputRows.reduce((s,r)=>s+Number(r.qty||0),0);
  const totalOut = processingOutputRows.reduce((s,r)=>s+Number(r.qty||0),0);
  const overBudget = totalOut > totalIn + 0.0001;

  const formHTML = canWrite() ? `
    <div class="panel">
      <h2>Log a processing run <span class="sub">consumes approved input batches, produces new batches</span></h2>
      <div class="form-grid">
        <div class="field"><label>Process name</label>
          <select id="pr-defid" onchange="onProcessDefChange(this.value)">
            <option value="">Select process…</option>
            ${processDefs.map(d=>`<option value="${d.id}" ${selectedProcessDefId==d.id?'selected':''}>${d.name}</option>`).join('')}
          </select>
          ${isAdmin() ? `<div class="hint">New process type? Add it under Catalog.</div>` : ''}
          ${currentDef && (currentDef.rm_wastage_pct || currentDef.pm_wastage_pct) ? `<div class="hint">Expected wastage (reference only): RM ${currentDef.rm_wastage_pct??'—'}% · PM ${currentDef.pm_wastage_pct??'—'}%</div>` : ''}
        </div>
        <div class="field"><label>Date</label><input type="date" id="pr-date" value="${todayStr()}"></div>
        <div class="field"><label>Shift</label><select id="pr-shift"><option>Morning</option><option>Evening</option><option>Night</option></select></div>
        <div class="field"><label>Labour count</label><input type="number" id="pr-labour" min="0" step="1"></div>
      </div>

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Input batches (must be QC-approved)<span class="sub">${allowedInputProductIds ? ` — only ${currentDef.inputs.map(p=>p.name).join('/')} shown for this process` : ''}</span></h3>
      <div id="prInputs">
        ${processingInputRows.map((row,i)=>`
          <div class="form-grid" style="margin-bottom:6px;">
            <div class="field"><label>Batch</label>
              <select onchange="processingInputRows[${i}].batchId=this.value; render();">
                <option value="">Select approved batch…</option>
                ${approvedRaw.map(b=>`<option value="${b.id}" ${processingInputRows[i].batchId==b.id?'selected':''}>${b.batch_code} — ${b.product_name} (${fmt(b.remaining_qty)} ${b.unit} left)</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Quantity used (kg)</label><input type="number" min="0" step="0.01" value="${processingInputRows[i].qty}" oninput="processingInputRows[${i}].qty=this.value; refreshBalanceHint();"></div>
          </div>`).join('')}
      </div>
      <button class="btn secondary-btn small" onclick="processingInputRows.push({batchId:'',qty:''}); render();">+ Add input batch</button>

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Output batches produced <span class="sub">${selectedProcessDefId ? `only ${currentDef?.outputs?.map(p=>p.name).join('/')||''} — auto-filled from process` : 'pick a process above to auto-fill'}</span></h3>
      <div id="prOutputs">
        ${processingOutputRows.map((row,i)=>{
          const availableProducts = currentDef?.outputs?.length ? currentDef.outputs : finishedGoods();
          const chosenElsewhere = new Set(processingOutputRows.filter((r,j)=>j!==i && r.productId).map(r=>String(r.productId)));
          const optionsForThisRow = availableProducts.filter(p => !chosenElsewhere.has(String(p.id)) || String(p.id)===String(row.productId));
          return `
          <div class="form-grid" style="margin-bottom:6px;">
            <div class="field"><label>Product</label>
              <select onchange="processingOutputRows[${i}].productId=this.value; render();">
                <option value="">Select product…</option>
                ${optionsForThisRow.map(p=>`<option value="${p.id}" ${row.productId==p.id?'selected':''}>${p.name}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Quantity (kg)</label><input type="number" min="0" step="0.01" value="${row.qty}" oninput="processingOutputRows[${i}].qty=this.value; refreshBalanceHint();"></div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn secondary-btn small" onclick="processingOutputRows.push({productId:'',qty:''}); render();">+ Add output</button>

      <div class="hint" id="balanceHint" style="margin-top:10px;${overBudget?'color:var(--alert);':''}">
        Total input: ${fmt(totalIn)} kg &nbsp;|&nbsp; Total output: ${fmt(totalOut)} kg
        ${overBudget ? ' — output cannot exceed input' : ''}
      </div>
      <div style="margin-top:10px;"><button class="btn" onclick="addProcessing()" ${overBudget?'disabled':''}>Save processing run</button></div>
      <div class="hint">Output batches start as Pending QC — approve them from the Quality tab before they can be packed and dispatched.</div>
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>Processing log <span class="sub">${processingRows.length} runs</span></h2>
      ${processingRows.length===0 ? `<div class="empty">No processing runs logged yet.</div>` : processingRows.map(run=>`
        <div style="border-bottom:1px solid var(--line);padding:12px 0;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">${run.date.slice(0,10)} · ${run.shift} · ${run.labour||0} labour</div>
          <div style="font-family:'Oswald',sans-serif;font-size:15px;text-transform:uppercase;margin:4px 0;">${run.process_name}</div>
          <div style="font-size:13px;">
            <strong>In:</strong> ${run.inputs.map(i=>`${i.batch_code} (${fmt(i.quantity_used)} ${i.unit||'kg'})`).join(', ')||'—'}<br>
            <strong>Out:</strong> ${run.outputs.map(o=>`${o.batch_code} — ${o.product_name} (${fmt(o.quantity)}) ${statusPill(o.status)}`).join(' · ')||'—'}
          </div>
        </div>`).join('')}
    </div>`;
}

function onProcessDefChange(defId){
  selectedProcessDefId = defId;
  const def = processDefs.find(d=>d.id===Number(defId));
  processingOutputRows = def ? def.outputs.map(p=>({ productId: p.id, qty: '' })) : [];
  // Switching process changes which raw materials are valid inputs — clear
  // any batch already picked under the old process so nobody accidentally
  // submits a run with the wrong raw material still selected.
  processingInputRows = [{ batchId:'', qty:'' }];
  render();
}

function refreshBalanceHint(){
  const totalIn = processingInputRows.reduce((s,r)=>s+Number(r.qty||0),0);
  const totalOut = processingOutputRows.reduce((s,r)=>s+Number(r.qty||0),0);
  const el = document.getElementById('balanceHint');
  if (!el) return;
  const overBudget = totalOut > totalIn + 0.0001;
  el.style.color = overBudget ? 'var(--alert)' : '';
  el.textContent = `Total input: ${fmt(totalIn)} kg  |  Total output: ${fmt(totalOut)} kg` + (overBudget ? ' — output cannot exceed input' : '');
}

async function addProcessing(){
  const v = id => document.getElementById(id).value;
  const body = {
    processDefinitionId: Number(v('pr-defid')), date: v('pr-date')||todayStr(), shift: v('pr-shift'), labour: Number(v('pr-labour')),
    inputs: processingInputRows.filter(r=>r.batchId && r.qty).map(r=>({ batchId:Number(r.batchId), quantityUsed:Number(r.qty) })),
    outputs: processingOutputRows.filter(r=>r.productId && r.qty).map(r=>({ productId:Number(r.productId), quantity:Number(r.qty) })),
  };
  if (!body.processDefinitionId) { alert('Select a process.'); return; }
  try {
    await api('/processing', { method:'POST', body: JSON.stringify(body) });
    note('Processing run saved');
    processingInputRows = []; processingOutputRows = []; selectedProcessDefId = '';
    await render();
  } catch(e){ alert(e.message); }
}

// ---------------- URID PRE-PROCESSING ----------------
let uridPPRows = [];
let uridOutputCategoriesCache = [];
let uridOutputRows = [];
let uridUsersCache = [];
let uridSourcingCache = [];
let uridApprovedRawBatchesCache = [];
let selectedUridPPId = null;
let selectedUridPPDetail = null;
const URID_PP_STATUS_LABEL = { draft:'Draft', in_process:'In Process', awaiting_review:'Awaiting Review', approved:'Approved', transferred_to_dhall:'Transferred to Dhall', on_hold:'On Hold', cancelled:'Cancelled' };
const URID_PP_STATUS_CLASS = { draft:'raw', in_process:'high', awaiting_review:'high', approved:'ok', transferred_to_dhall:'ok', on_hold:'high', cancelled:'high' };
function canApproveUridPP(){ return isAdmin() || hasAnyRole('supervisor','management'); }

async function uridPreProcHTML(){
  uridPPRows = await api('/urid/preprocessing-batches');
  uridOutputCategoriesCache = await api('/urid/output-categories');
  uridUsersCache = await api('/users/basic');
  const approvedRawUrid = (await api('/batches?stage=raw_material&status=approved')).filter(b => b.product_code === 'URID-RAW');
  uridApprovedRawBatchesCache = approvedRawUrid;
  uridSourcingCache = await api('/sourcing');

  if (canWrite() && uridOutputRows.length === 0) {
    uridOutputRows = uridOutputCategoriesCache.map(c => ({ categoryId: c.id, quantity: '', disposition: '', remarks: '' }));
  }

  const formHTML = canWrite() ? `
    <div class="panel">
      <h2>Urid Pre-Processing <span class="sub">receive raw urid → record impurities/recoveries → Good Material</span></h2>
      <div class="form-grid">
        <div class="field"><label>Raw urid batch (approved)</label><select id="pp-rawbatch" onchange="onUridRawBatchChange(this.value)">
          <option value="">Select…</option>${approvedRawUrid.map(b=>`<option value="${b.id}">${b.batch_code} (${fmt(b.remaining_qty)} kg left)</option>`).join('')}
        </select>
        <div class="hint">Selecting a batch fills in the supplier, lot number, and input quantity from its Sourcing record.</div>
        </div>
        <div class="field"><label>Processing date</label><input type="date" id="pp-date" value="${todayStr()}"></div>
        <div class="field"><label>Supplier</label><select id="pp-supplier"><option value="">—</option>${suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></div>
        <div class="field"><label>Supplier lot no.</label><input type="text" id="pp-suplot" placeholder="auto-filled from sourcing"></div>
        <div class="field"><label>PO reference</label><input type="text" id="pp-po" placeholder="optional"></div>
        <div class="field"><label>GRN reference</label><input type="text" id="pp-grn" placeholder="optional"></div>
        <div class="field"><label>Warehouse/Location</label><input type="text" id="pp-warehouse" placeholder="optional"></div>
        <div class="field"><label>Machine/Line</label><input type="text" id="pp-machine" placeholder="optional"></div>
        <div class="field"><label>Operator</label><select id="pp-operator"><option value="">—</option>${uridUsersCache.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
        <div class="field"><label>Supervisor</label><select id="pp-supervisor"><option value="">—</option>${uridUsersCache.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
        <div class="field"><label>Shift</label><select id="pp-shift"><option>Morning</option><option>Evening</option><option>Night</option></select></div>
        <div class="field"><label>Start time</label><input type="time" id="pp-start"></div>
        <div class="field"><label>End time</label><input type="time" id="pp-end"></div>
      </div>

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Input quantity</h3>
      <div class="form-grid">
        <div class="field"><label>Gross quantity (kg)</label><input type="number" step="0.001" id="pp-gross" oninput="refreshUridMassBalancePreview()"></div>
        <div class="field"><label>Bag count</label><input type="number" step="1" id="pp-bagcount"></div>
        <div class="field"><label>Standard bag weight (kg)</label><input type="number" step="0.001" id="pp-stdbag"></div>
        <div class="field"><label>Actual bag/tare weight (kg)</label><input type="number" step="0.001" id="pp-actbag"></div>
        <div class="field"><label>Net raw urid input (kg) <span class="req-star">*</span></label><input type="number" step="0.001" id="pp-netinput" oninput="refreshUridMassBalancePreview()"></div>
      </div>

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Impurities, waste &amp; recoveries</h3>
      ${uridOutputRows.map((row,i)=>{
        const cat = uridOutputCategoriesCache.find(c=>c.id===row.categoryId);
        return `
        <div class="form-grid" style="margin-bottom:6px;">
          <div class="field"><label>${cat?.name||''} ${cat?.is_recoverable?'<span class="tag-pill ok">recoverable</span>':''}</label>
            <input type="number" step="0.001" min="0" value="${row.quantity}" placeholder="kg" oninput="uridOutputRows[${i}].quantity=this.value; refreshUridMassBalancePreview();">
          </div>
          <div class="field"><label>% of input</label><input type="text" id="pp-out-pct-${i}" value="0.00%" disabled></div>
          ${cat?.is_recoverable ? `
          <div class="field"><label>Disposition</label><select onchange="uridOutputRows[${i}].disposition=this.value">
            <option value="">Select…</option>
            <option value="transfer_to_stock">Transfer to Stock</option>
            <option value="transfer_to_dhall">Transfer to Dhall Processing</option>
            <option value="reprocess">Reprocess</option>
            <option value="hold">Hold</option>
            <option value="reject_dispose">Reject / Dispose</option>
          </select></div>` : `<div class="field"></div>`}
          <div class="field"><label>Remarks</label><input type="text" value="${row.remarks}" onchange="uridOutputRows[${i}].remarks=this.value" placeholder="optional"></div>
        </div>`;
      }).join('')}

      <div class="panel" style="background:var(--white);margin-top:10px;">
        <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:0 0 8px;">Good material &amp; mass balance</h3>
        <div class="form-grid">
          <div class="field"><label>Weighed good material (kg) <span class="req-star">*</span></label><input type="number" step="0.001" id="pp-goodmat" oninput="refreshUridMassBalancePreview()"></div>
          <div class="field"><label>Expected (computed)</label><input type="text" id="pp-expected-goodmat" disabled></div>
          <div class="field"><label>Yield %</label><input type="text" id="pp-yield" disabled></div>
          <div class="field"><label>Mass balance</label><input type="text" id="pp-mb-status" disabled></div>
        </div>
        <div id="pp-variance-field" style="display:none;" class="field"><label>Variance reason <span class="req-star">*</span></label><input type="text" id="pp-variance-reason" placeholder="required when mass balance exceeds tolerance"></div>
      </div>

      <div class="field" style="margin-top:10px;"><label>Remarks</label><input type="text" id="pp-remarks" placeholder="optional"></div>
      <div style="margin-top:14px;"><button class="btn" onclick="createUridPPBatch()">Save as Draft</button></div>
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>Pre-Processing batches <span class="sub">${uridPPRows.length}</span></h2>
      ${uridPPRows.length===0 ? `<div class="empty">None yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Batch No.</th><th>Date</th><th>Supplier</th><th>Net Input</th><th>Good Material</th><th>Yield %</th><th>Mass Balance</th><th>Status</th><th></th></tr></thead>
        <tbody>${uridPPRows.map(b=>{
          const yieldPct = b.net_input_qty > 0 ? (Number(b.good_material_qty||0)/Number(b.net_input_qty)*100).toFixed(2) : '—';
          return `<tr>
          <td>${b.batch_no}</td><td>${b.processing_date.slice(0,10)}</td><td>${b.supplier_name||'—'}</td>
          <td>${fmt(b.net_input_qty)} kg</td><td>${fmt(b.good_material_qty)} kg</td><td>${yieldPct}%</td>
          <td>${b.mass_balance_ok ? '<span class="tag-pill ok">Matched</span>' : '<span class="tag-pill high">Variance</span>'}</td>
          <td><span class="tag-pill ${URID_PP_STATUS_CLASS[b.status]||'raw'}">${URID_PP_STATUS_LABEL[b.status]||b.status}</span></td>
          <td><span class="del" onclick="openUridPPDetail(${b.id})">view</span></td>
        </tr>`;}).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="uridPPDetailPanel" style="${selectedUridPPId?'':'display:none;'}"></div>
  `;
}

function onUridRawBatchChange(rawBatchId){
  if (!rawBatchId) return;
  const sourcingRecord = uridSourcingCache.find(s => String(s.batch_id) === String(rawBatchId));
  const batch = uridApprovedRawBatchesCache.find(b => String(b.id) === String(rawBatchId));

  if (sourcingRecord) {
    const supplierSelect = document.getElementById('pp-supplier');
    if (supplierSelect && sourcingRecord.supplier_id) supplierSelect.value = sourcingRecord.supplier_id;
    const lotInput = document.getElementById('pp-suplot');
    if (lotInput) lotInput.value = sourcingRecord.supplier_batch_no || '';
  }
  // Net input defaults to whatever remains in the batch (usually the full
  // sourced quantity, unless part of it was already used) — still editable,
  // since the operator may be processing less than the full available amount.
  if (batch) {
    const netInput = document.getElementById('pp-netinput');
    if (netInput) { netInput.value = batch.remaining_qty; refreshUridMassBalancePreview(); }
  }
}

function refreshUridMassBalancePreview(){
  const netInput = Number(document.getElementById('pp-netinput')?.value || 0);
  let nonRecoverableSum = 0, recoverableKeptSum = 0;
  uridOutputRows.forEach((row, i) => {
    const cat = uridOutputCategoriesCache.find(c=>c.id===row.categoryId);
    const qty = Number(row.quantity || 0);
    const pctEl = document.getElementById(`pp-out-pct-${i}`);
    if (pctEl) pctEl.value = netInput > 0 ? `${(qty/netInput*100).toFixed(2)}%` : '0.00%';
    if (!cat) return;
    if (!cat.is_recoverable) nonRecoverableSum += qty;
    else if (row.disposition !== 'transfer_to_dhall') recoverableKeptSum += qty;
  });
  const expected = netInput - nonRecoverableSum - recoverableKeptSum;
  const weighed = Number(document.getElementById('pp-goodmat')?.value || 0);
  const diffPct = netInput > 0 ? ((weighed - expected) / netInput * 100) : 0;
  const tolerance = 0.10; // matches server default; server is authoritative

  const expectedEl = document.getElementById('pp-expected-goodmat');
  const yieldEl = document.getElementById('pp-yield');
  const mbEl = document.getElementById('pp-mb-status');
  const varianceField = document.getElementById('pp-variance-field');
  if (expectedEl) expectedEl.value = `${fmt(expected)} kg`;
  if (yieldEl) yieldEl.value = netInput > 0 ? `${(weighed/netInput*100).toFixed(2)}%` : '—';
  if (mbEl) mbEl.value = Math.abs(diffPct) <= tolerance ? `Matched (${diffPct.toFixed(4)}%)` : `Variance (${diffPct.toFixed(4)}%) — needs approval`;
  if (varianceField) varianceField.style.display = Math.abs(diffPct) <= tolerance ? 'none' : 'block';
}

async function createUridPPBatch(){
  const v = id => document.getElementById(id).value;
  const outputs = uridOutputRows.filter(r=>r.quantity && Number(r.quantity) > 0).map(r=>({
    categoryId: r.categoryId, quantity: Number(r.quantity), disposition: r.disposition || undefined, remarks: r.remarks || undefined,
  }));
  const body = {
    processingDate: v('pp-date')||todayStr(), supplierId: Number(v('pp-supplier'))||null, supplierLotNo: v('pp-suplot').trim(),
    poReference: v('pp-po').trim(), grnReference: v('pp-grn').trim(), rawMaterialBatchId: Number(v('pp-rawbatch'))||null,
    warehouseLocation: v('pp-warehouse').trim(), machineLine: v('pp-machine').trim(), operatorId: Number(v('pp-operator'))||null,
    supervisorId: Number(v('pp-supervisor'))||null, shift: v('pp-shift'), startTime: v('pp-start')||null, endTime: v('pp-end')||null,
    grossQuantity: v('pp-gross')||null, bagCount: v('pp-bagcount')||null, standardBagWeight: v('pp-stdbag')||null, actualBagWeight: v('pp-actbag')||null,
    netInputQty: Number(v('pp-netinput')), goodMaterialQty: Number(v('pp-goodmat')), outputs,
    varianceReason: v('pp-variance-reason').trim() || undefined, remarks: v('pp-remarks').trim(),
  };
  try {
    await api('/urid/preprocessing-batches', { method:'POST', body: JSON.stringify(body) });
    note('Pre-Processing batch saved as draft');
    uridOutputRows = [];
    await render();
  } catch(e){ alert(e.message); }
}

async function openUridPPDetail(id){
  selectedUridPPId = id;
  selectedUridPPDetail = await api(`/urid/preprocessing-batches/${id}`);
  renderUridPPDetail();
}
function closeUridPPDetail(){
  selectedUridPPId = null;
  const panel = document.getElementById('uridPPDetailPanel');
  if (panel) panel.style.display = 'none';
}
function renderUridPPDetail(){
  const panel = document.getElementById('uridPPDetailPanel');
  if (!panel) return;
  const b = selectedUridPPDetail;
  panel.style.display = '';
  const yieldPct = b.net_input_qty > 0 ? (Number(b.good_material_qty||0)/Number(b.net_input_qty)*100).toFixed(2) : '—';

  panel.innerHTML = `
    <h2>${b.batch_no} <span class="sub">${URID_PP_STATUS_LABEL[b.status]||b.status}</span></h2>
    <div class="form-grid">
      <div class="field"><label>Supplier</label><div>${b.supplier_name||'—'}</div></div>
      <div class="field"><label>Operator</label><div>${b.operator_name||'—'}</div></div>
      <div class="field"><label>Supervisor</label><div>${b.supervisor_name||'—'}</div></div>
      <div class="field"><label>Date</label><div>${b.processing_date.slice(0,10)}</div></div>
    </div>
    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Mass balance</h3>
    <table><thead><tr><th>Net Input</th><th>Good Material</th><th>Yield %</th><th>Variance %</th><th>Result</th></tr></thead>
    <tbody><tr><td>${fmt(b.net_input_qty)} kg</td><td>${fmt(b.good_material_qty)} kg</td><td>${yieldPct}%</td><td>${fmt(b.mass_balance_diff_pct)}%</td>
      <td>${b.mass_balance_ok ? '<span class="tag-pill ok">MATCHED</span>' : '<span class="tag-pill high">VARIANCE</span>'}</td></tr></tbody></table>
    ${b.variance_reason ? `<div class="hint">Variance reason: ${b.variance_reason}</div>` : ''}

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Outputs</h3>
    <table><thead><tr><th>Category</th><th>Qty</th><th>%</th><th>Disposition</th></tr></thead>
    <tbody>${b.outputs.map(o=>`<tr><td>${o.category_name}</td><td>${fmt(o.quantity)} kg</td><td>${fmt(o.percentage)}%</td><td>${o.disposition||'—'}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">None recorded</td></tr>'}</tbody></table>

    ${b.good_material_batch_id ? `<div class="hint" style="margin-top:10px;">Good Material stock batch created — check Trace for full lineage.</div>` : ''}
    ${b.latestApprovalRun ? `<div class="hint">Latest approval run: #${b.latestApprovalRun.id} — ${b.latestApprovalRun.status} (group ${b.latestApprovalRun.current_group_order}). Check the Approvals tab to act on it.</div>` : ''}

    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
      ${canWrite() && b.status==='draft' ? `<button class="btn" onclick="submitUridPPBatch(${b.id})">Submit for Review</button>` : ''}
      ${canApproveUridPP() && ['draft','in_process','awaiting_review'].includes(b.status) ? `<button class="btn secondary-btn small" onclick="holdUridPPBatch(${b.id})">Put on Hold</button>` : ''}
      ${canApproveUridPP() && b.status==='on_hold' ? `<button class="btn secondary-btn small" onclick="releaseUridPPHold(${b.id})">Release Hold</button>` : ''}
      <button class="btn secondary-btn" onclick="closeUridPPDetail()">Close</button>
    </div>
  `;
}
async function submitUridPPBatch(id){
  try {
    await api(`/urid/preprocessing-batches/${id}/submit`, { method:'POST' });
    note('Submitted for review — check My Approvals in the Approvals tab');
    selectedUridPPDetail = await api(`/urid/preprocessing-batches/${id}`); renderUridPPDetail(); await render();
  } catch(e){ alert(e.message); }
}
async function holdUridPPBatch(id){
  const reason = prompt('Reason for putting this batch on hold:');
  if (reason === null) return;
  try { await api(`/urid/preprocessing-batches/${id}/hold`, { method:'POST', body: JSON.stringify({ reason }) }); note('Batch on hold'); selectedUridPPDetail = await api(`/urid/preprocessing-batches/${id}`); renderUridPPDetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function releaseUridPPHold(id){
  try { await api(`/urid/preprocessing-batches/${id}/release-hold`, { method:'POST' }); note('Hold released — back to draft'); selectedUridPPDetail = await api(`/urid/preprocessing-batches/${id}`); renderUridPPDetail(); await render(); }
  catch(e){ alert(e.message); }
}

// ---------------- URID DHALL PROCESSING ----------------
let uridDhallRows = [];
let uridDhallInputRows = [];
let uridAvailableGoodMaterial = [];
let uridLossReasonsCache = [];
let selectedUridDhallId = null;
let selectedUridDhallDetail = null;
const URID_DP_STATUS_LABEL = { draft:'Draft', in_process:'In Process', awaiting_review:'Awaiting Review', approved:'Approved', on_hold:'On Hold', cancelled:'Cancelled' };
const URID_DP_STATUS_CLASS = { draft:'raw', in_process:'high', awaiting_review:'high', approved:'ok', on_hold:'high', cancelled:'high' };

async function uridDhallHTML(){
  uridDhallRows = await api('/urid/dhall-batches');
  uridAvailableGoodMaterial = await api('/urid/available-good-material');
  uridLossReasonsCache = await api('/urid/loss-reasons');
  uridUsersCache = await api('/users/basic');

  if (canWrite() && uridDhallInputRows.length === 0 && uridAvailableGoodMaterial.length > 0) {
    uridDhallInputRows = [{ goodMaterialBatchId: '', quantityConsumed: '' }];
  }

  const formHTML = canWrite() ? `
    <div class="panel">
      <h2>Urid Dhall Processing <span class="sub">Good Material (one or more Stage 1 batches) → Whole / Split / Dust</span></h2>
      <div class="form-grid">
        <div class="field"><label>Processing date</label><input type="date" id="dp-date" value="${todayStr()}"></div>
        <div class="field"><label>Machine/Line</label><input type="text" id="dp-machine" placeholder="optional"></div>
        <div class="field"><label>Operator</label><select id="dp-operator"><option value="">—</option>${uridUsersCache.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
        <div class="field"><label>Supervisor</label><select id="dp-supervisor"><option value="">—</option>${uridUsersCache.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
        <div class="field"><label>Shift</label><select id="dp-shift"><option>Morning</option><option>Evening</option><option>Night</option></select></div>
        <div class="field"><label>Start time</label><input type="time" id="dp-start"></div>
        <div class="field"><label>End time</label><input type="time" id="dp-end"></div>
      </div>

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Input — Stage 1 Good Material <span class="sub">select one or more approved Pre-Processing batches</span></h3>
      ${uridAvailableGoodMaterial.length===0 ? `<div class="empty">No approved Good Material available yet — approve a Pre-Processing batch first.</div>` : `
      <div id="dpInputs">
        ${uridDhallInputRows.map((row,i)=>{
          const selected = uridAvailableGoodMaterial.find(g=>String(g.good_material_batch_id)===String(row.goodMaterialBatchId));
          return `
          <div class="form-grid" style="margin-bottom:6px;">
            <div class="field"><label>Pre-Processing batch</label><select onchange="uridDhallInputRows[${i}].goodMaterialBatchId=this.value; uridDhallInputRows[${i}].preprocessingBatchId=uridAvailableGoodMaterial.find(g=>String(g.good_material_batch_id)===this.value)?.preprocessing_batch_id; render();">
              <option value="">Select…</option>
              ${uridAvailableGoodMaterial.map(g=>`<option value="${g.good_material_batch_id}" ${row.goodMaterialBatchId==g.good_material_batch_id?'selected':''}>${g.batch_no} — Available ${fmt(g.remaining_qty)} kg</option>`).join('')}
            </select></div>
            <div class="field"><label>Quantity to consume (kg)</label><input type="number" step="0.001" min="0" max="${selected?selected.remaining_qty:''}" value="${row.quantityConsumed}" oninput="uridDhallInputRows[${i}].quantityConsumed=this.value; refreshUridDhallTotals();"></div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn secondary-btn small" onclick="uridDhallInputRows.push({goodMaterialBatchId:'',quantityConsumed:''}); render();">+ Add another Stage 1 batch</button>
      <div class="hint" id="dp-total-input">Selected total: 0 kg</div>`}

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Outputs</h3>
      <div class="form-grid">
        <div class="field"><label>Whole Urid Dhall (kg)</label><input type="number" step="0.001" id="dp-whole" oninput="refreshUridDhallTotals()"></div>
        <div class="field"><label>Whole — bag count</label><input type="number" step="1" id="dp-whole-bags"></div>
        <div class="field"><label>Whole — bag size</label><input type="text" id="dp-whole-bagsize" placeholder="e.g. 50kg"></div>
        <div class="field"><label>Split Urid Dhall (kg)</label><input type="number" step="0.001" id="dp-split" oninput="refreshUridDhallTotals()"></div>
        <div class="field"><label>Split — bag count</label><input type="number" step="1" id="dp-split-bags"></div>
        <div class="field"><label>Split — bag size</label><input type="text" id="dp-split-bagsize" placeholder="e.g. 50kg"></div>
        <div class="field"><label>Urid Dust (kg)</label><input type="number" step="0.001" id="dp-dust" oninput="refreshUridDhallTotals()"></div>
        <div class="field"><label>Dust classification</label><select id="dp-dust-class">
          <option value="saleable">Saleable</option><option value="by_product">By-product</option>
          <option value="reprocess">Reprocess</option><option value="waste">Waste</option><option value="hold">Hold</option>
        </select></div>
        <div class="field"><label>Process loss (kg)</label><input type="number" step="0.001" id="dp-loss" oninput="refreshUridDhallTotals()"></div>
        <div class="field"><label>Loss reason</label><select id="dp-loss-reason"><option value="">—</option>${uridLossReasonsCache.map(r=>`<option value="${r.id}">${r.name}</option>`).join('')}</select></div>
      </div>

      <div class="panel" style="background:var(--white);margin-top:10px;">
        <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:0 0 8px;">Mass balance &amp; yield preview</h3>
        <div class="form-grid">
          <div class="field"><label>Total accounted</label><input type="text" id="dp-accounted" disabled></div>
          <div class="field"><label>Mass balance</label><input type="text" id="dp-mb-status" disabled></div>
          <div class="field"><label>Whole yield % (this run)</label><input type="text" id="dp-whole-yield" disabled></div>
          <div class="field"><label>Split yield % (this run)</label><input type="text" id="dp-split-yield" disabled></div>
        </div>
        <div id="dp-variance-field" style="display:none;" class="field"><label>Variance reason <span class="req-star">*</span></label><input type="text" id="dp-variance-reason" placeholder="required when mass balance exceeds tolerance"></div>
      </div>

      <div class="field" style="margin-top:10px;"><label>Remarks</label><input type="text" id="dp-remarks" placeholder="optional"></div>
      <div style="margin-top:14px;"><button class="btn" onclick="createUridDhallBatch()">Save as Draft</button></div>
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>Dhall Processing batches <span class="sub">${uridDhallRows.length}</span></h2>
      ${uridDhallRows.length===0 ? `<div class="empty">None yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Batch No.</th><th>Date</th><th>Input</th><th>Whole</th><th>Split</th><th>Dust</th><th>Overall Yield (Whole)</th><th>Status</th><th></th></tr></thead>
        <tbody>${uridDhallRows.map(b=>`<tr>
          <td>${b.batch_no}</td><td>${b.processing_date.slice(0,10)}</td><td>${fmt(b.total_input_qty)} kg</td>
          <td>${fmt(b.whole_dhall_qty)} kg</td><td>${fmt(b.split_dhall_qty)} kg</td><td>${fmt(b.dust_qty)} kg</td>
          <td>${fmt(b.overall_yield_whole_pct)}%</td>
          <td><span class="tag-pill ${URID_DP_STATUS_CLASS[b.status]||'raw'}">${URID_DP_STATUS_LABEL[b.status]||b.status}</span></td>
          <td><span class="del" onclick="openUridDhallDetail(${b.id})">view</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="uridDhallDetailPanel" style="${selectedUridDhallId?'':'display:none;'}"></div>
  `;
}

function refreshUridDhallTotals(){
  const totalInput = uridDhallInputRows.reduce((s,r)=>s+Number(r.quantityConsumed||0),0);
  const totalEl = document.getElementById('dp-total-input');
  if (totalEl) totalEl.textContent = `Selected total: ${fmt(totalInput)} kg`;

  const whole = Number(document.getElementById('dp-whole')?.value||0);
  const split = Number(document.getElementById('dp-split')?.value||0);
  const dust = Number(document.getElementById('dp-dust')?.value||0);
  const loss = Number(document.getElementById('dp-loss')?.value||0);
  const accounted = whole+split+dust+loss;
  const diffPct = totalInput>0 ? ((totalInput-accounted)/totalInput*100) : 0;
  const tolerance = 0.10;

  const accountedEl = document.getElementById('dp-accounted');
  const mbEl = document.getElementById('dp-mb-status');
  const wholeYieldEl = document.getElementById('dp-whole-yield');
  const splitYieldEl = document.getElementById('dp-split-yield');
  const varianceField = document.getElementById('dp-variance-field');
  if (accountedEl) accountedEl.value = `${fmt(accounted)} kg`;
  if (mbEl) mbEl.value = Math.abs(diffPct)<=tolerance ? `Matched (${diffPct.toFixed(4)}%)` : `Variance (${diffPct.toFixed(4)}%) — needs approval`;
  if (wholeYieldEl) wholeYieldEl.value = totalInput>0 ? `${(whole/totalInput*100).toFixed(2)}%` : '—';
  if (splitYieldEl) splitYieldEl.value = totalInput>0 ? `${(split/totalInput*100).toFixed(2)}%` : '—';
  if (varianceField) varianceField.style.display = Math.abs(diffPct)<=tolerance ? 'none' : 'block';
}

async function createUridDhallBatch(){
  const v = id => document.getElementById(id).value;
  const inputs = uridDhallInputRows.filter(r=>r.goodMaterialBatchId && r.quantityConsumed).map(r=>({
    preprocessingBatchId: Number(r.preprocessingBatchId), goodMaterialBatchId: Number(r.goodMaterialBatchId), quantityConsumed: Number(r.quantityConsumed),
  }));
  if (!inputs.length) { alert('Select at least one Stage 1 Good Material input.'); return; }
  const body = {
    processingDate: v('dp-date')||todayStr(), machineLine: v('dp-machine').trim(), operatorId: Number(v('dp-operator'))||null,
    supervisorId: Number(v('dp-supervisor'))||null, shift: v('dp-shift'), startTime: v('dp-start')||null, endTime: v('dp-end')||null,
    inputs,
    whole: { quantity: Number(v('dp-whole')||0), bagCount: v('dp-whole-bags')||null, bagSize: v('dp-whole-bagsize').trim() },
    split: { quantity: Number(v('dp-split')||0), bagCount: v('dp-split-bags')||null, bagSize: v('dp-split-bagsize').trim() },
    dust: { quantity: Number(v('dp-dust')||0), classification: v('dp-dust-class') },
    processLossQty: Number(v('dp-loss')||0), processLossReasonId: Number(v('dp-loss-reason'))||null,
    varianceReason: v('dp-variance-reason').trim() || undefined, remarks: v('dp-remarks').trim(),
  };
  try {
    await api('/urid/dhall-batches', { method:'POST', body: JSON.stringify(body) });
    note('Dhall Processing batch saved as draft');
    uridDhallInputRows = [];
    await render();
  } catch(e){ alert(e.message); }
}

async function openUridDhallDetail(id){
  selectedUridDhallId = id;
  selectedUridDhallDetail = await api(`/urid/dhall-batches/${id}`);
  renderUridDhallDetail();
}
function closeUridDhallDetail(){
  selectedUridDhallId = null;
  const panel = document.getElementById('uridDhallDetailPanel');
  if (panel) panel.style.display = 'none';
}
function renderUridDhallDetail(){
  const panel = document.getElementById('uridDhallDetailPanel');
  if (!panel) return;
  const b = selectedUridDhallDetail;
  panel.style.display = '';
  panel.innerHTML = `
    <h2>${b.batch_no} <span class="sub">${URID_DP_STATUS_LABEL[b.status]||b.status}</span></h2>
    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Inputs (Stage 1 sources)</h3>
    <table><thead><tr><th>Pre-Processing Batch</th><th>Good Material Batch</th><th>Consumed</th></tr></thead>
    <tbody>${b.inputs.map(i=>`<tr><td>${i.preprocessing_batch_no}</td><td>${i.good_material_batch_code}</td><td>${fmt(i.quantity_consumed)} kg</td></tr>`).join('')}</tbody></table>

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Mass balance &amp; yield</h3>
    <table><thead><tr><th>Total Input</th><th>Whole</th><th>Split</th><th>Dust</th><th>Loss</th><th>Result</th></tr></thead>
    <tbody><tr><td>${fmt(b.total_input_qty)} kg</td><td>${fmt(b.whole_dhall_qty)} kg</td><td>${fmt(b.split_dhall_qty)} kg</td><td>${fmt(b.dust_qty)} kg</td><td>${fmt(b.process_loss_qty)} kg</td>
      <td>${b.mass_balance_ok?'<span class="tag-pill ok">MATCHED</span>':'<span class="tag-pill high">VARIANCE</span>'}</td></tr></tbody></table>
    <div class="hint">This run: Whole ${fmt(b.whole_yield_pct)}% · Split ${fmt(b.split_yield_pct)}% · Dust ${fmt(b.dust_yield_pct)}% · Loss ${fmt(b.loss_pct)}%</div>
    <div class="hint"><strong>Overall yield vs. original raw urid</strong> (equivalent raw input ${fmt(b.equivalent_raw_input_qty)} kg): Whole ${fmt(b.overall_yield_whole_pct)}% · Split ${fmt(b.overall_yield_split_pct)}% · Dust ${fmt(b.overall_yield_dust_pct)}%</div>
    ${b.variance_reason ? `<div class="hint">Variance reason: ${b.variance_reason}</div>` : ''}

    ${b.whole_batch_id ? `<div class="hint" style="margin-top:10px;">Whole/Split/Dust stock batches created — pending QC before Packing.</div>` : ''}
    ${b.latestApprovalRun ? `<div class="hint">Latest approval run: #${b.latestApprovalRun.id} — ${b.latestApprovalRun.status}. Check the Approvals tab to act on it.</div>` : ''}

    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
      ${canWrite() && b.status==='draft' ? `<button class="btn" onclick="submitUridDhallBatch(${b.id})">Submit for Review</button>` : ''}
      ${canApproveUridPP() && ['draft','in_process','awaiting_review'].includes(b.status) ? `<button class="btn secondary-btn small" onclick="holdUridDhallBatch(${b.id})">Put on Hold</button>` : ''}
      ${canApproveUridPP() && b.status==='on_hold' ? `<button class="btn secondary-btn small" onclick="releaseUridDhallHold(${b.id})">Release Hold</button>` : ''}
      <button class="btn secondary-btn" onclick="closeUridDhallDetail()">Close</button>
    </div>
  `;
}
async function submitUridDhallBatch(id){
  try { await api(`/urid/dhall-batches/${id}/submit`, { method:'POST' }); note('Submitted for review — check My Approvals'); selectedUridDhallDetail = await api(`/urid/dhall-batches/${id}`); renderUridDhallDetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function holdUridDhallBatch(id){
  const reason = prompt('Reason for putting this batch on hold:');
  if (reason === null) return;
  try { await api(`/urid/dhall-batches/${id}/hold`, { method:'POST', body: JSON.stringify({ reason }) }); note('Batch on hold'); selectedUridDhallDetail = await api(`/urid/dhall-batches/${id}`); renderUridDhallDetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function releaseUridDhallHold(id){
  try { await api(`/urid/dhall-batches/${id}/release-hold`, { method:'POST' }); note('Hold released'); selectedUridDhallDetail = await api(`/urid/dhall-batches/${id}`); renderUridDhallDetail(); await render(); }
  catch(e){ alert(e.message); }
}

// ---------------- QUALITY ----------------
async function qualityHTML(){
  pendingQC = await api('/quality/pending');
  const recent = await api('/quality/inspections');

  const pendingHTML = pendingQC.map(b=>`
    <div class="panel" id="qc-${b.id}">
      <h2>${b.batch_code} <span class="sub">${b.product_name} · ${b.stage==='raw_material'?'Raw material':'Finished good'} · qty ${fmt(b.quantity)} ${b.unit}</span></h2>
      ${canQC() ? `<div id="qc-params-${b.id}" class="hint">loading parameters…</div>` : `<div class="hint">Only Admin/QC roles can record an inspection decision.</div>`}
    </div>`).join('');

  setTimeout(async ()=>{
    if (!canQC()) return;
    for (const b of pendingQC) {
      const params = await api(`/quality-parameters?productId=${b.product_id}&stage=${b.stage}`).catch(()=>[]);
      const filtered = params.filter(p=>p.stage===b.stage);
      const box = document.getElementById(`qc-params-${b.id}`);
      if (!box) continue;
      box.className = '';
      box.innerHTML = `
        <div class="form-grid">
          ${filtered.map(p=>`
            <div class="field"><label>${p.name} ${p.unit?`(${p.unit})`:''}${p.min_value!=null||p.max_value!=null?` — limit ${p.min_value!=null?'≥'+p.min_value:''}${p.min_value!=null&&p.max_value!=null?' & ':''}${p.max_value!=null?'≤'+p.max_value:''}`:''}</label>
              <input type="number" step="0.01" data-param="${p.id}" id="reading-${b.id}-${p.id}"></div>`).join('')}
        </div>
        <div class="form-grid">
          <div class="field"><label>Inspection date</label><input type="date" id="qcdate-${b.id}" value="${todayStr()}"></div>
          <div class="field"><label>Inspection time</label><input type="time" id="qctime-${b.id}" value="${nowTimeStr()}"></div>
          <div class="field"><label>Decision</label>
            <select id="decision-${b.id}"><option value="pass">Pass — Approve</option><option value="fail">Fail — Reject</option><option value="hold">Hold — Needs review</option></select></div>
          <div class="field"><label>Notes</label><input type="text" id="qcnotes-${b.id}" placeholder="optional"></div>
          <button class="btn" onclick="submitInspection(${b.id}, [${filtered.map(p=>p.id).join(',')}])">Submit inspection</button>
        </div>`;
    }
  }, 0);

  return `
    <div class="panel"><h2>Pending inspections <span class="sub">${pendingQC.length} batches</span></h2></div>
    ${pendingQC.length===0 ? `<div class="panel"><div class="empty">Nothing waiting on QC right now.</div></div>` : pendingHTML}
    <div class="panel">
      <h2>Recent inspections</h2>
      ${recent.length===0 ? `<div class="empty">No inspections recorded yet.</div>` : `
      <table><thead><tr><th>Inspected</th><th>Batch</th><th>Product</th><th>Decision</th><th>Inspector</th><th>Readings</th></tr></thead>
      <tbody>${recent.map(r=>`<tr>
        <td>${new Date(r.inspected_at || r.created_at).toLocaleString()}</td><td>${r.batch_code}</td><td>${r.product_name}</td>
        <td><span class="tag-pill ${r.decision==='pass'?'ok':'high'}">${r.decision}</span></td><td>${r.inspector_name||'—'}</td>
        <td>${r.readings.map(rd=>`${rd.parameter_name}: ${fmt(rd.measured_value)}${rd.unit||''} ${rd.within_limits?'✓':'✗'}`).join(', ')||'—'}</td>
      </tr>`).join('')}</tbody></table>`}
    </div>`;
}
async function submitInspection(batchId, paramIds){
  const decision = document.getElementById(`decision-${batchId}`).value;
  const notes = document.getElementById(`qcnotes-${batchId}`).value.trim();
  const dateVal = document.getElementById(`qcdate-${batchId}`).value || todayStr();
  const timeVal = document.getElementById(`qctime-${batchId}`).value || nowTimeStr();
  const inspectedAt = new Date(`${dateVal}T${timeVal}:00`).toISOString();
  const readings = paramIds.filter(id=>id!=='').map(id=>{
    const el = document.getElementById(`reading-${batchId}-${id}`);
    return { parameterId: id, measuredValue: el.value };
  }).filter(r=>r.measuredValue !== '');
  try {
    await api('/quality/inspections', { method:'POST', body: JSON.stringify({ batchId, decision, notes, inspectedAt, readings }) });
    note('Inspection recorded');
    await render();
  } catch(e){ alert(e.message); }
}

// ---------------- PACKING ----------------
let packingInputRows = [];
let packingOutputRows = [];
let packingSelectedProductId = '';
function onPackingProductChange(productId){
  packingSelectedProductId = productId;
  // Switching product invalidates any bulk batch already picked under the
  // old product, and outputs should all belong to the newly selected one.
  packingInputRows = [{ batchId:'', qty:'' }];
  packingOutputRows = [{ productId, qty:'', packType:'', packSizeId:'', numberOfPacks:'' }];
  render();
}
function onPackingSizeChange(rowIndex, packSizeId){
  packingOutputRows[rowIndex].packSizeId = packSizeId;
  recalcPackingRowTotal(rowIndex);
}
function recalcPackingRowTotal(rowIndex){
  const row = packingOutputRows[rowIndex];
  const size = packSizesCache.find(s=>String(s.id)===String(row.packSizeId));
  if (size?.weight_kg && row.numberOfPacks) {
    row.qty = (Number(size.weight_kg) * Number(row.numberOfPacks)).toFixed(2);
    const qtyInput = document.getElementById(`pk-out-qty-${rowIndex}`);
    if (qtyInput) qtyInput.value = row.qty;
  }
}

async function packingHTML(){
  packingRows = await api('/packing');
  packTypesCache = await api('/pack-types');
  packSizesCache = await api('/pack-sizes');
  const approvedBulkAll = await api('/batches?stage=finished_good&status=approved&isPacked=false');
  // Filtering the bulk batch picker to the product being packed prevents
  // accidentally consuming, say, Sesame Oil bulk while packing Groundnut Oil
  // 1L bottles — the two dropdowns used to be entirely independent.
  const approvedBulk = packingSelectedProductId ? approvedBulkAll.filter(b=>String(b.product_id)===String(packingSelectedProductId)) : approvedBulkAll;

  if (canWrite() && packingInputRows.length===0) packingInputRows = [{ batchId:'', qty:'' }];
  if (canWrite() && packingOutputRows.length===0) packingOutputRows = [{ productId:'', qty:'', packType:'', packSizeId:'', numberOfPacks:'' }];

  const formHTML = canWrite() ? `
    <div class="panel">
      <h2>Log a packing run <span class="sub">bulk approved goods → packed, dispatch-ready batches</span></h2>
      <div class="form-grid">
        <div class="field"><label>Product to pack</label>
          <select id="pk-product" onchange="onPackingProductChange(this.value)">
            <option value="">Select product…</option>
            ${finishedGoods().map(p=>`<option value="${p.id}" ${packingSelectedProductId==p.id?'selected':''}>${p.name}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Date</label><input type="date" id="pk-date" value="${todayStr()}"></div>
        <div class="field"><label>Shift</label><select id="pk-shift"><option>Morning</option><option>Evening</option><option>Night</option></select></div>
        <div class="field"><label>Labour count</label><input type="number" id="pk-labour" min="0" step="1"></div>
      </div>

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Bulk batches to pack (must be QC-approved, not yet packed)${packingSelectedProductId ? ` — showing ${finishedGoods().find(p=>p.id==packingSelectedProductId)?.name||''} only` : ''}</h3>
      <div id="pkInputs">
        ${!packingSelectedProductId ? `<div class="hint">Pick a product above first.</div>` : packingInputRows.map((row,i)=>`
          <div class="form-grid" style="margin-bottom:6px;">
            <div class="field"><label>Batch</label>
              <select onchange="packingInputRows[${i}].batchId=this.value">
                <option value="">Select approved bulk batch…</option>
                ${approvedBulk.map(b=>`<option value="${b.id}" ${packingInputRows[i].batchId==b.id?'selected':''}>${b.batch_code} — ${b.product_name} (${fmt(b.remaining_qty)} ${b.unit} left)</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Quantity used</label><input type="number" min="0" step="0.01" value="${packingInputRows[i].qty}" onchange="packingInputRows[${i}].qty=this.value"></div>
          </div>`).join('')}
      </div>
      ${packingSelectedProductId ? `<button class="btn secondary-btn small" onclick="packingInputRows.push({batchId:'',qty:''}); render();">+ Add input batch</button>` : ''}

      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Packed outputs <span class="sub">${packingSelectedProductId ? 'pack size / type variations of the same product' : ''}</span></h3>
      <div id="pkOutputs">
        ${!packingSelectedProductId ? `<div class="hint">Pick a product above first.</div>` : packingOutputRows.map((row,i)=>`
          <div class="form-grid" style="margin-bottom:6px;">
            <div class="field"><label>Pack type</label><select onchange="packingOutputRows[${i}].packType=this.value">
              <option value="">Select…</option>${packTypesCache.map(t=>`<option value="${t.name}" ${row.packType===t.name?'selected':''}>${t.name}</option>`).join('')}
            </select></div>
            <div class="field"><label>Pack size</label><select onchange="onPackingSizeChange(${i}, this.value)">
              <option value="">Select…</option>${packSizesCache.map(s=>`<option value="${s.id}" ${row.packSizeId==s.id?'selected':''}>${s.label}${s.weight_kg?` (~${s.weight_kg}kg)`:''}</option>`).join('')}
            </select></div>
            <div class="field"><label>Number of packs</label><input type="number" min="0" step="1" value="${row.numberOfPacks}" oninput="packingOutputRows[${i}].numberOfPacks=this.value; recalcPackingRowTotal(${i});"></div>
            <div class="field"><label>Total quantity (kg) <span class="sub">auto-calculated, editable</span></label><input type="number" min="0" step="0.01" id="pk-out-qty-${i}" value="${row.qty}" onchange="packingOutputRows[${i}].qty=this.value"></div>
          </div>`).join('')}
      </div>
      ${packingSelectedProductId ? `<button class="btn secondary-btn small" onclick="packingOutputRows.push({productId:packingSelectedProductId,qty:'',packType:'',packSizeId:'',numberOfPacks:''}); render();">+ Add pack size/type</button>` : ''}

      <div style="margin-top:16px;"><button class="btn" onclick="addPacking()" ${!packingSelectedProductId?'disabled':''}>Save packing run</button></div>
      <div class="hint">Packed batches start as Pending QC — approve them from Quality before they show up in Dispatch.</div>
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>Packing log <span class="sub">${packingRows.length} runs</span></h2>
      ${packingRows.length===0 ? `<div class="empty">No packing runs logged yet.</div>` : packingRows.map(run=>`
        <div style="border-bottom:1px solid var(--line);padding:12px 0;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">${run.date.slice(0,10)} · ${run.shift} · ${run.labour||0} labour</div>
          <div style="font-family:'Oswald',sans-serif;font-size:15px;text-transform:uppercase;margin:4px 0;">${run.pack_name}</div>
          <div style="font-size:13px;">
            <strong>Bulk used:</strong> ${run.inputs.map(i=>`${i.batch_code} (${fmt(i.quantity_used)})`).join(', ')||'—'}<br>
            <strong>Packed:</strong> ${run.outputs.map(o=>`${o.batch_code} — ${o.product_name} ${o.pack_size||''} ${o.pack_type||''} (${fmt(o.quantity)}) ${statusPill(o.status)}`).join(' · ')||'—'}
          </div>
        </div>`).join('')}
    </div>`;
}
async function addPacking(){
  const v = id => document.getElementById(id).value;
  const product = finishedGoods().find(p=>String(p.id)===String(packingSelectedProductId));
  const body = {
    packName: product ? product.name : '', date: v('pk-date')||todayStr(), shift: v('pk-shift'), labour: Number(v('pk-labour')),
    inputs: packingInputRows.filter(r=>r.batchId && r.qty).map(r=>({ batchId:Number(r.batchId), quantityUsed:Number(r.qty) })),
    outputs: packingOutputRows.filter(r=>r.qty).map(r=>({
      productId:Number(packingSelectedProductId), quantity:Number(r.qty), packType:r.packType,
      packSize: packSizesCache.find(s=>String(s.id)===String(r.packSizeId))?.label || null,
      unitsPerPack:r.numberOfPacks?Number(r.numberOfPacks):null,
    })),
  };
  try {
    await api('/packing', { method:'POST', body: JSON.stringify(body) });
    note('Packing run saved');
    packingInputRows = []; packingOutputRows = []; packingSelectedProductId = '';
    await render();
  } catch(e){ alert(e.message); }
}

// ---------------- DISPATCH ----------------
let dispatchCustomersCache = [];
let showAddDispatchCustomer = false;
async function dispatchHTML(){
  dispatchRows = await api('/dispatch');
  dispatchCustomersCache = await api('/dispatch-customers');
  const approvedFG = await api('/batches?stage=finished_good&status=approved&isPacked=true');

  const formHTML = canWrite() ? `
    <div class="panel">
      <h2>Log a dispatch <span class="sub">only QC-approved, packed batches can be selected</span></h2>
      <div class="form-grid">
        <div class="field"><label>Batch</label><select id="dp-batch">
          <option value="">Select packed batch…</option>
          ${approvedFG.map(b=>`<option value="${b.id}">${b.batch_code} — ${b.product_name} ${b.pack_size||''} ${b.pack_type||''} (${fmt(b.remaining_qty)} ${b.unit} left)</option>`).join('')}
        </select></div>
        <div class="field"><label>Date</label><input type="date" id="dp-date" value="${todayStr()}"></div>
        <div class="field"><label>Customer</label>
          <select id="dp-customer">
            <option value="">Select customer…</option>
            ${dispatchCustomersCache.map(c=>`<option value="${c.id}">${c.name}${c.code?` (${c.code})`:''}</option>`).join('')}
          </select>
          <span class="del" onclick="showAddDispatchCustomer=!showAddDispatchCustomer; render();">${showAddDispatchCustomer?'cancel':'+ new customer'}</span>
        </div>
        <div class="field"><label>Quantity</label><input type="number" id="dp-qty" min="0" step="0.01"></div>
        <div class="field"><label>Rate (₹/unit)</label><input type="number" id="dp-rate" min="0" step="0.01"></div>
        <div class="field"><label>Notes</label><input type="text" id="dp-notes" placeholder="optional"></div>
        <button class="btn" onclick="addDispatch()">Add dispatch</button>
      </div>
      ${showAddDispatchCustomer ? `
      <div class="form-grid" style="margin-top:10px;background:var(--white);padding:10px;">
        <div class="field"><label>New customer name</label><input type="text" id="dpc-name" placeholder="required"></div>
        <div class="field"><label>Customer code</label><input type="text" id="dpc-code" placeholder="optional, e.g. CUST-001"></div>
        <div class="field"><label>Address</label><input type="text" id="dpc-address" placeholder="optional"></div>
        <div class="field"><label>Phone</label><input type="text" id="dpc-phone" placeholder="optional"></div>
        <button class="btn secondary-btn small" onclick="addDispatchCustomer()">Save customer</button>
      </div>` : ''}
      ${approvedFG.length===0 ? `<div class="hint">No packed, approved batches yet — pack some finished goods first under the Packing tab.</div>` : ''}
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>Dispatch log <span class="sub">${dispatchRows.length} entries</span></h2>
      ${dispatchRows.length===0 ? `<div class="empty">No dispatches logged yet.</div>` : `
      <table><thead><tr><th>Date</th><th>Batch</th><th>Product</th><th>Customer</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>${dispatchRows.map(r=>`<tr>
        <td>${r.date.slice(0,10)}</td><td>${r.batch_code}</td><td>${r.product_name}</td><td>${r.display_customer||r.customer}${r.customer_code?` (${r.customer_code})`:''}</td>
        <td>${fmt(r.quantity)}</td><td>₹${fmt(r.rate)}</td><td>₹${fmt(r.quantity*r.rate)}</td>
      </tr>`).join('')}</tbody></table>`}
    </div>`;
}
async function addDispatchCustomer(){
  const v = id => document.getElementById(id).value;
  const name = v('dpc-name').trim();
  if (!name) { alert('Customer name is required.'); return; }
  try {
    const c = await api('/dispatch-customers', { method:'POST', body: JSON.stringify({
      name, code: v('dpc-code').trim(), address: v('dpc-address').trim(), phone: v('dpc-phone').trim(),
    }) });
    showAddDispatchCustomer = false;
    dispatchCustomersCache = await api('/dispatch-customers');
    await render();
    document.getElementById('dp-customer').value = c.id;
  } catch(e){ alert(e.message); }
}
async function addDispatch(){
  const v = id => document.getElementById(id).value;
  const body = { batchId:Number(v('dp-batch')), date:v('dp-date')||todayStr(), customerId:Number(v('dp-customer'))||null, quantity:Number(v('dp-qty')), rate:Number(v('dp-rate')), notes:v('dp-notes').trim() };
  if (!body.batchId) { alert('Select a batch.'); return; }
  if (!body.customerId) { alert('Select a customer.'); return; }
  try { await api('/dispatch', { method:'POST', body: JSON.stringify(body) }); note('Dispatch saved'); await render(); }
  catch(e){ alert(e.message); }
}

// ---------------- TRACE ----------------
function traceNodeHTML(b, direction){
  const decision = b.inspections[0]?.decision;
  return `
    <div class="panel" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${b.batch_code}</strong> — ${b.product_name} <span class="tag-pill ${b.stage==='raw_material'?'raw':'oil'}">${b.category_name}</span>
        </div>
        ${statusPill(b.status)}
      </div>
      <div class="hint" style="margin-top:6px;">
        ${b.sourcing ? `Sourced from <strong>${b.sourcing.supplier}</strong> (${b.sourcing.origin}) on ${b.sourcing.date.slice(0,10)} · net ${fmt(b.sourcing.net_weight)} kg` : ''}
        ${b.producedByRun ? `Produced by <strong>${b.producedByRun.process_name}</strong> on ${b.producedByRun.date.slice(0,10)} (${b.producedByRun.shift} shift)` : ''}
      </div>
      ${b.inspections.length ? `<div class="hint">QC: ${decision} by ${b.inspections[0].inspector_name||'—'} on ${new Date(b.inspections[0].created_at).toLocaleDateString()}</div>` : `<div class="hint">No QC recorded yet.</div>`}
      ${b.dispatches.length ? `<div class="hint">Dispatched: ${b.dispatches.map(d=>`${d.customer} (${fmt(d.quantity)}) on ${d.date.slice(0,10)}`).join(', ')}</div>` : ''}
    </div>`;
}
async function traceHTML(){
  return `
    <div class="panel">
      <h2>Trace a batch <span class="sub">enter a batch code to see its full history, forward and back</span></h2>
      <div class="form-grid">
        <div class="field"><label>Batch code</label><input type="text" id="trace-code" placeholder="e.g. KAF-SESOIL-20260810-000012"></div>
        <button class="btn" onclick="runTrace()">Trace</button>
      </div>
    </div>
    <div id="traceResult"></div>`;
}
async function runTrace(){
  const code = document.getElementById('trace-code').value.trim();
  const box = document.getElementById('traceResult');
  if (!code) return;
  box.innerHTML = '<div class="panel">Tracing…</div>';
  try {
    const result = await api(`/trace/${encodeURIComponent(code)}`);
    box.innerHTML = `
      <div class="panel"><h2>Target batch</h2></div>
      ${traceNodeHTML(result.batch)}
      <div class="panel"><h2>Upstream <span class="sub">raw materials this batch traces back to</span></h2></div>
      ${result.upstream.length ? result.upstream.map(traceNodeHTML).join('') : `<div class="panel"><div class="empty">No upstream batches — this is a raw material batch.</div></div>`}
      <div class="panel"><h2>Downstream <span class="sub">what this batch became, or where it was dispatched</span></h2></div>
      ${result.downstream.length ? result.downstream.map(traceNodeHTML).join('') : `<div class="panel"><div class="empty">Not yet processed or dispatched further.</div></div>`}
    `;
  } catch(e){ box.innerHTML = `<div class="panel">${e.message}</div>`; }
}

// ---------------- CATALOG (admin) ----------------
let packTypesCache = [];
let packSizesCache = [];
async function catalogHTML(){
  packTypesCache = await api('/pack-types');
  packSizesCache = await api('/pack-sizes');
  return `
    <div class="panel">
      <h2>Categories</h2>
      <div class="table-scroll"><table><thead><tr><th>Name</th><th>Code</th></tr></thead>
      <tbody>${categories.map(c=>`<tr><td>${c.name}</td><td>${c.code}</td></tr>`).join('')}</tbody></table></div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>New category name</label><input type="text" id="cat-name" placeholder="e.g. Beverages"></div>
        <div class="field"><label>Code</label><input type="text" id="cat-code" placeholder="e.g. BEV"></div>
        <button class="btn" onclick="addCategory()">Add category</button>
      </div>
    </div>
    <div class="panel">
      <h2>Products <span class="sub">any admin can add a new product here</span></h2>
      <div class="table-scroll"><table><thead><tr><th>Category</th><th>Name</th><th>Code</th><th>Kind</th><th>Unit</th></tr></thead>
      <tbody>${products.map(p=>`<tr><td>${p.category_name}</td><td>${p.name}</td><td>${p.code}</td><td>${p.kind}</td><td>${p.unit}</td></tr>`).join('')}</tbody></table></div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Category</label><select id="prod-cat">${categories.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
        <div class="field"><label>Name</label><input type="text" id="prod-name" placeholder="e.g. Idiyappam Flour"></div>
        <div class="field"><label>Code</label><input type="text" id="prod-code" placeholder="e.g. IDIFLR"></div>
        <div class="field"><label>Kind</label><select id="prod-kind"><option value="raw_material">Raw material</option><option value="finished_good">Finished good</option></select></div>
        <div class="field"><label>Unit</label><input type="text" id="prod-unit" value="kg"></div>
        <button class="btn" onclick="addProduct()">Add product</button>
      </div>
    </div>
    <div class="panel">
      <h2>Quality parameters</h2>
      <div class="table-scroll"><table><thead><tr><th>Product</th><th>Stage</th><th>Parameter</th><th>Unit</th><th>Min</th><th>Max</th></tr></thead>
      <tbody id="qpTableBody"><tr><td colspan="6" class="empty">loading…</td></tr></tbody></table></div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Product</label><select id="qp-product">${products.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
        <div class="field"><label>Stage</label><select id="qp-stage"><option value="raw_material">Raw material</option><option value="finished_good">Finished good</option></select></div>
        <div class="field"><label>Parameter name</label><input type="text" id="qp-name" placeholder="e.g. Moisture %"></div>
        <div class="field"><label>Unit</label><input type="text" id="qp-unit" placeholder="%"></div>
        <div class="field"><label>Min value</label><input type="number" step="0.01" id="qp-min" placeholder="optional"></div>
        <div class="field"><label>Max value</label><input type="number" step="0.01" id="qp-max" placeholder="optional"></div>
        <button class="btn" onclick="addQualityParam()">Add parameter</button>
      </div>
    </div>
    <div class="panel">
      <h2>Suppliers <span class="sub">master data used by Sourcing — GST, FSSAI, address, etc.</span></h2>
      <div class="table-scroll"><table><thead><tr><th>Name</th><th>Company</th><th>GST</th><th>FSSAI</th><th>Address</th><th>Phone</th><th>Supplies</th></tr></thead>
      <tbody>${suppliers.map(s=>`<tr><td>${s.name}</td><td>${s.company_name||'—'}</td><td>${s.gst_number||'—'}</td><td>${s.fssai_number||'—'}</td><td>${s.address}</td><td>${s.phone||'—'}</td>
        <td>${(s.productIds||[]).map(pid=>productName(pid)).join(', ')||'—'} <span class="del" onclick="editSupplierProducts(${s.id})">edit</span></td></tr>`).join('') || `<tr><td colspan="7" class="empty">No suppliers yet.</td></tr>`}</tbody></table></div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Supplier name</label><input type="text" id="sup-name" placeholder="e.g. Patel Traders"></div>
        <div class="field"><label>Company name</label><input type="text" id="sup-company" placeholder="optional"></div>
        <div class="field"><label>GST number</label><input type="text" id="sup-gst" placeholder="optional"></div>
        <div class="field"><label>FSSAI number</label><input type="text" id="sup-fssai" placeholder="optional"></div>
        <div class="field"><label>Address <span class="req-star">*</span></label><input type="text" id="sup-address" placeholder="used as sourcing origin"></div>
        <div class="field"><label>Phone</label><input type="text" id="sup-phone" placeholder="optional"></div>
        <div class="field"><label>Email</label><input type="text" id="sup-email" placeholder="optional"></div>
        <div class="field" style="grid-column:span 2;"><label>Raw materials this supplier provides <span class="sub">ctrl/cmd-click to select more than one — leave blank to allow all</span></label>
          <select id="sup-products" multiple size="5">${rawMaterials().map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select>
        </div>
        <button class="btn" onclick="addSupplier()">Add supplier</button>
      </div>
    </div>
    <div class="panel">
      <h2>Process definitions <span class="sub">process name → raw material input(s) → expected output products</span></h2>
      <div class="table-scroll"><table><thead><tr><th>Process</th><th>Category</th><th>Inputs</th><th>Outputs</th><th>RM Wastage %</th><th>PM Wastage %</th></tr></thead>
      <tbody>${processDefs.map(d=>`<tr><td>${d.name}</td><td>${d.category_name||'—'}</td><td>${(d.inputs||[]).map(o=>o.name).join(', ')||'—'}</td><td>${d.outputs.map(o=>o.name).join(', ')}</td><td>${d.rm_wastage_pct??'—'}</td><td>${d.pm_wastage_pct??'—'}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">No processes yet.</td></tr>`}</tbody></table></div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Process name</label><input type="text" id="pd-name" placeholder="e.g. Sesame Oil"></div>
        <div class="field"><label>Category</label><select id="pd-cat">${categories.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
        <div class="field"><label>Raw material input(s) <span class="sub">ctrl/cmd-click for more than one — leave blank to allow any</span></label>
          <select id="pd-inputs" multiple size="6">${rawMaterials().map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Output products <span class="req-star">*</span> <span class="sub">ctrl/cmd-click to select more than one</span></label>
          <select id="pd-outputs" multiple size="6">${finishedGoods().map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Expected RM wastage % <span class="sub">reference only, shown when logging a run</span></label><input type="number" id="pd-rmwaste" min="0" max="100" step="0.1" placeholder="optional"></div>
        <div class="field"><label>Expected PM wastage % <span class="sub">reference only</span></label><input type="number" id="pd-pmwaste" min="0" max="100" step="0.1" placeholder="optional"></div>
        <button class="btn" onclick="addProcessDef()">Add process</button>
      </div>
    </div>
    <div class="panel">
      <h2>Pack types &amp; sizes <span class="sub">shared list used by Packing — same options for every product</span></h2>
      <div class="form-grid">
        <div class="field"><label>Pack types</label>
          <div class="hint">${packTypesCache.map(t=>t.name).join(', ')||'none yet'}</div>
          <input type="text" id="pt-name" placeholder="e.g. Jerrycan">
          <button class="btn secondary-btn small" onclick="addPackType()">+ Add pack type</button>
        </div>
        <div class="field"><label>Pack sizes <span class="sub">weight is a starting estimate for auto-calculating totals — adjust anytime</span></label>
          <div class="table-scroll"><table><thead><tr><th>Label</th><th>Weight (kg)</th></tr></thead>
          <tbody>${packSizesCache.map(s=>`<tr><td>${s.label}</td><td><input type="number" step="0.0001" value="${s.weight_kg??''}" onchange="updatePackSizeWeight(${s.id}, this.value)" style="width:100px;"></td></tr>`).join('')}</tbody></table></div>
          <div class="form-grid" style="margin-top:8px;">
            <input type="text" id="ps-label" placeholder="e.g. 20L">
            <input type="number" id="ps-weight" step="0.0001" placeholder="approx weight (kg)">
            <button class="btn secondary-btn small" onclick="addPackSize()">+ Add pack size</button>
          </div>
        </div>
      </div>
    </div>`;
}
async function loadQPTable(){
  const all = await api('/quality-parameters');
  document.getElementById('qpTableBody').innerHTML = all.map(qp=>`
    <tr><td>${productName(qp.product_id)}</td><td>${qp.stage}</td><td>${qp.name}</td><td>${qp.unit||'—'}</td><td>${qp.min_value ?? '—'}</td><td>${qp.max_value ?? '—'}</td></tr>
  `).join('') || `<tr><td colspan="6" class="empty">No parameters yet.</td></tr>`;
}
async function addCategory(){
  const name = document.getElementById('cat-name').value.trim();
  const code = document.getElementById('cat-code').value.trim();
  try { await api('/categories', { method:'POST', body: JSON.stringify({ name, code }) }); await loadCatalog(); await render(); }
  catch(e){ alert(e.message); }
}
async function addProduct(){
  const v = id => document.getElementById(id).value;
  try {
    await api('/products', { method:'POST', body: JSON.stringify({ categoryId:Number(v('prod-cat')), name:v('prod-name').trim(), code:v('prod-code').trim(), kind:v('prod-kind'), unit:v('prod-unit').trim() }) });
    await loadCatalog(); await render();
  } catch(e){ alert(e.message); }
}
async function addQualityParam(){
  const v = id => document.getElementById(id).value;
  try {
    await api('/quality-parameters', { method:'POST', body: JSON.stringify({ productId:Number(v('qp-product')), stage:v('qp-stage'), name:v('qp-name').trim(), unit:v('qp-unit').trim(), minValue:v('qp-min'), maxValue:v('qp-max') }) });
    await loadQPTable();
  } catch(e){ alert(e.message); }
}
async function addSupplier(){
  const v = id => document.getElementById(id).value;
  const productIds = Array.from(document.getElementById('sup-products').selectedOptions).map(o=>Number(o.value));
  try {
    await api('/suppliers', { method:'POST', body: JSON.stringify({
      name:v('sup-name').trim(), companyName:v('sup-company').trim(), gstNumber:v('sup-gst').trim(),
      fssaiNumber:v('sup-fssai').trim(), address:v('sup-address').trim(), phone:v('sup-phone').trim(), email:v('sup-email').trim(),
      productIds,
    }) });
    await loadCatalog(); await render();
  } catch(e){ alert(e.message); }
}
async function editSupplierProducts(supplierId){
  const supplier = suppliers.find(s=>s.id===supplierId);
  const current = new Set((supplier?.productIds||[]).map(String));
  const picks = rawMaterials().map(p=>`${current.has(String(p.id))?'[x]':'[ ]'} ${p.name} (${p.id})`).join('\n');
  const input = prompt(`Enter the raw material IDs this supplier provides, comma-separated.\n\nAvailable:\n${picks}\n\nCurrent: ${[...current].join(', ')||'none'}`, [...current].join(','));
  if (input === null) return;
  const productIds = input.split(',').map(s=>s.trim()).filter(Boolean).map(Number);
  try {
    await api(`/suppliers/${supplierId}/products`, { method:'POST', body: JSON.stringify({ productIds }) });
    await loadCatalog(); await render();
  } catch(e){ alert(e.message); }
}
async function addProcessDef(){
  const v = id => document.getElementById(id).value;
  const outputIds = Array.from(document.getElementById('pd-outputs').selectedOptions).map(o=>Number(o.value));
  const inputIds = Array.from(document.getElementById('pd-inputs').selectedOptions).map(o=>Number(o.value));
  try {
    await api('/process-definitions', { method:'POST', body: JSON.stringify({
      name:v('pd-name').trim(), categoryId:Number(v('pd-cat')), outputProductIds: outputIds, inputProductIds: inputIds,
      rmWastagePct: v('pd-rmwaste')||null, pmWastagePct: v('pd-pmwaste')||null,
    }) });
    await loadCatalog(); await render();
  } catch(e){ alert(e.message); }
}
async function addPackType(){
  const name = document.getElementById('pt-name').value.trim();
  if (!name) return;
  try { await api('/pack-types', { method:'POST', body: JSON.stringify({ name }) }); await render(); }
  catch(e){ alert(e.message); }
}
async function addPackSize(){
  const label = document.getElementById('ps-label').value.trim();
  const weightKg = document.getElementById('ps-weight').value;
  if (!label) return;
  try { await api('/pack-sizes', { method:'POST', body: JSON.stringify({ label, weightKg: weightKg||null }) }); await render(); }
  catch(e){ alert(e.message); }
}
async function updatePackSizeWeight(id, weightKg){
  try { await api(`/pack-sizes/${id}`, { method:'PATCH', body: JSON.stringify({ weightKg: weightKg||null }) }); }
  catch(e){ alert(e.message); }
}

// ---------------- EXPORT SETUP (admin) — Module 2: Master Data ----------------
async function exportSetupHTML(){
  const [countries, currencies, ports, incoterms, paymentTerms, containerTypes, docSettings, supplierCats] = await Promise.all([
    api('/export/countries'), api('/export/currencies'), api('/export/ports'), api('/export/incoterms'),
    api('/export/payment-terms'), api('/export/container-types'), api('/export/document-number-settings'), api('/export/supplier-categories'),
  ]);

  const simpleList = (rows, cols) => rows.length
    ? `<div class="table-scroll"><table><thead><tr>${cols.map(c=>`<th>${c.label}</th>`).join('')}</tr></thead>
       <tbody>${rows.map(r=>`<tr>${cols.map(c=>`<td>${r[c.key] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">None yet — add one below.</div>`;

  return `
    <div class="panel">
      <h2>Countries</h2>
      ${simpleList(countries, [{key:'name',label:'Name'},{key:'iso_code',label:'ISO'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Country name</label><input type="text" id="ctry-name" placeholder="e.g. United States"></div>
        <div class="field"><label>ISO code</label><input type="text" id="ctry-iso" placeholder="e.g. US" maxlength="3"></div>
        <button class="btn" onclick="addMaster('countries', {name:val('ctry-name'), isoCode:val('ctry-iso')})">Add country</button>
      </div>
    </div>

    <div class="panel">
      <h2>Currencies</h2>
      ${simpleList(currencies, [{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'symbol',label:'Symbol'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Code</label><input type="text" id="cur-code" placeholder="e.g. JPY" maxlength="3"></div>
        <div class="field"><label>Name</label><input type="text" id="cur-name" placeholder="e.g. Japanese Yen"></div>
        <div class="field"><label>Symbol</label><input type="text" id="cur-symbol" placeholder="optional"></div>
        <button class="btn" onclick="addMaster('currencies', {code:val('cur-code'), name:val('cur-name'), symbol:val('cur-symbol')})">Add currency</button>
      </div>
    </div>

    <div class="panel">
      <h2>Ports</h2>
      ${simpleList(ports, [{key:'name',label:'Name'},{key:'country_name',label:'Country'},{key:'port_type',label:'Type'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Port name</label><input type="text" id="port-name" placeholder="e.g. Chennai"></div>
        <div class="field"><label>Country</label><select id="port-country"><option value="">—</option>${countries.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
        <div class="field"><label>Type</label><select id="port-type"><option value="both">Both</option><option value="loading">Loading</option><option value="discharge">Discharge</option></select></div>
        <button class="btn" onclick="addMaster('ports', {name:val('port-name'), countryId:Number(val('port-country'))||null, portType:val('port-type')})">Add port</button>
      </div>
    </div>

    <div class="panel">
      <h2>Incoterms</h2>
      ${simpleList(incoterms, [{key:'code',label:'Code'},{key:'name',label:'Name'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Code</label><input type="text" id="inc-code" placeholder="e.g. DDP"></div>
        <div class="field"><label>Name</label><input type="text" id="inc-name" placeholder="e.g. Delivered Duty Paid"></div>
        <button class="btn" onclick="addMaster('incoterms', {code:val('inc-code'), name:val('inc-name')})">Add incoterm</button>
      </div>
    </div>

    <div class="panel">
      <h2>Payment terms</h2>
      ${simpleList(paymentTerms, [{key:'name',label:'Name'},{key:'description',label:'Description'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Name</label><input type="text" id="pt-name" placeholder="e.g. 30% Advance / 70% Against BL"></div>
        <div class="field"><label>Description</label><input type="text" id="pt-desc" placeholder="optional"></div>
        <button class="btn" onclick="addMaster('payment-terms', {name:val('pt-name'), description:val('pt-desc')})">Add payment term</button>
      </div>
    </div>

    <div class="panel">
      <h2>Container types</h2>
      ${simpleList(containerTypes, [{key:'name',label:'Name'},{key:'max_cbm',label:'Max CBM'},{key:'max_weight_kg',label:'Max Weight (kg)'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Name</label><input type="text" id="ct-name" placeholder="e.g. 20FT"></div>
        <div class="field"><label>Max CBM</label><input type="number" step="0.01" id="ct-cbm" placeholder="optional"></div>
        <div class="field"><label>Max weight (kg)</label><input type="number" step="0.01" id="ct-weight" placeholder="optional"></div>
        <button class="btn" onclick="addMaster('container-types', {name:val('ct-name'), maxCbm:val('ct-cbm')||null, maxWeightKg:val('ct-weight')||null})">Add container type</button>
      </div>
    </div>

    <div class="panel">
      <h2>Document numbering <span class="sub">single company prefix, per-document code — editable, not hard-coded</span></h2>
      <div class="table-scroll"><table><thead><tr><th>Document type</th><th>Prefix</th><th>Code</th><th>Example</th></tr></thead>
      <tbody>${docSettings.map(d=>`<tr>
        <td>${d.document_type.replace(/_/g,' ')}</td>
        <td><input type="text" value="${d.prefix}" style="width:70px;" onchange="updateDocSetting('${d.document_type}','prefix',this.value)"></td>
        <td><input type="text" value="${d.code}" style="width:70px;" onchange="updateDocSetting('${d.document_type}','code',this.value)"></td>
        <td class="hint">${d.prefix}/${d.code}/2026-27/0001</td>
      </tr>`).join('')}</tbody></table></div>
    </div>

    <div class="panel">
      <h2>Supplier categories <span class="sub">shared with the existing Suppliers list — one supplier can hold several</span></h2>
      ${simpleList(supplierCats, [{key:'name',label:'Name'}])}
      <div class="form-grid" style="margin-top:12px;">
        <div class="field"><label>Category name</label><input type="text" id="sc-name" placeholder="e.g. Freight Forwarder"></div>
        <button class="btn" onclick="addMaster('supplier-categories', {name:val('sc-name')})">Add category</button>
      </div>
    </div>
  `;
}
function val(id){ return document.getElementById(id).value.trim ? document.getElementById(id).value.trim() : document.getElementById(id).value; }
async function addMaster(endpoint, body){
  try { await api(`/export/${endpoint}`, { method:'POST', body: JSON.stringify(body) }); note('Added'); await render(); }
  catch(e){ alert(e.message); }
}
async function updateDocSetting(documentType, field, value){
  try { await api(`/export/document-number-settings/${documentType}`, { method:'PATCH', body: JSON.stringify({ [field]: value }) }); note('Saved'); }
  catch(e){ alert(e.message); }
}

// ---------------- CUSTOMERS (Module 3: Customer Master) ----------------
let customersCache = [];
let selectedCustomerId = null;
let selectedCustomerDetail = null;

// First real use of the Module 1 multi-role system for a business permission
// (not just the legacy admin/operator/viewer/qc split).
function canManageCustomers(){ return isAdmin() || hasAnyRole('export_sales','management'); }
function canManageVariants(){ return isAdmin() || hasAnyRole('export_sales','management'); }
function canManagePricing(){ return isAdmin() || hasAnyRole('management'); }
function canManageQuotations(){ return isAdmin() || hasAnyRole('export_sales','management'); }
function canManageSalesOrders(){ return isAdmin() || hasAnyRole('export_sales','management'); }
function canCheckPricing(){ return canManagePricing() || hasAnyRole('export_sales'); }

async function customersHTML(){
  customersCache = await api('/export/customers');
  const [currencies, paymentTerms, incoterms] = await Promise.all([
    api('/export/currencies'), api('/export/payment-terms'), api('/export/incoterms'),
  ]);

  const formHTML = canManageCustomers() ? `
    <div class="panel">
      <h2>Add a customer</h2>
      <div class="form-grid">
        <div class="field"><label>Customer code</label><input type="text" id="cu-code" placeholder="e.g. ABCUS01"></div>
        <div class="field"><label>Company name</label><input type="text" id="cu-name"></div>
        <div class="field"><label>Category</label><input type="text" id="cu-category" placeholder="e.g. Distributor"></div>
        <div class="field"><label>Currency</label><select id="cu-currency"><option value="">—</option>${currencies.map(c=>`<option value="${c.id}">${c.code}</option>`).join('')}</select></div>
        <div class="field"><label>Payment terms</label><select id="cu-terms"><option value="">—</option>${paymentTerms.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
        <div class="field"><label>Incoterm preference</label><select id="cu-incoterm"><option value="">—</option>${incoterms.map(i=>`<option value="${i.id}">${i.code}</option>`).join('')}</select></div>
        <div class="field"><label>Credit limit</label><input type="number" step="0.01" id="cu-credit" value="0"></div>
        <div class="field"><label>GST/Tax reg no.</label><input type="text" id="cu-tax" placeholder="optional"></div>
        <div class="field"><label>Import license no.</label><input type="text" id="cu-license" placeholder="optional"></div>
        <div class="field"><label>Website</label><input type="text" id="cu-website" placeholder="optional"></div>
        <div class="field" style="display:flex;align-items:center;gap:8px;padding-top:22px;"><input type="checkbox" id="cu-private"><label style="margin:0;">Private label customer</label></div>
        <button class="btn" onclick="addCustomer()">Add customer</button>
      </div>
    </div>` : '';

  return formHTML + `
    <div class="panel">
      <h2>All customers <span class="sub">${customersCache.length}</span></h2>
      ${customersCache.length===0 ? `<div class="empty">No customers yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Code</th><th>Company</th><th>Category</th><th>Currency</th><th>Incoterm</th><th>Credit Limit</th><th></th></tr></thead>
        <tbody>${customersCache.map(c=>`<tr>
          <td>${c.code}</td><td>${c.company_name}</td><td>${c.category||'—'}</td><td>${c.currency_code||'—'}</td><td>${c.incoterm_code||'—'}</td><td>${fmt(c.credit_limit)}</td>
          <td><span class="del" onclick="openCustomerDetail(${c.id})">view</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="customerDetailPanel" style="${selectedCustomerId?'':'display:none;'}"></div>
  `;
}

async function openCustomerDetail(id){
  selectedCustomerId = id;
  selectedCustomerDetail = await api(`/export/customers/${id}`);
  renderCustomerDetail();
}
function closeCustomerDetail(){
  selectedCustomerId = null;
  const panel = document.getElementById('customerDetailPanel');
  if (panel) panel.style.display = 'none';
}
function renderCustomerDetail(){
  const panel = document.getElementById('customerDetailPanel');
  if (!panel) return;
  const c = selectedCustomerDetail;
  const canManage = canManageCustomers();
  panel.style.display = '';
  panel.innerHTML = `
    <h2>${c.company_name} <span class="sub">${c.code}</span></h2>
    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Contacts</h3>
    ${c.contacts.length ? `<table><thead><tr><th>Name</th><th>Designation</th><th>Phone</th><th>Email</th><th>Primary</th>${canManage?'<th></th>':''}</tr></thead>
    <tbody>${c.contacts.map(ct=>`<tr><td>${ct.name}</td><td>${ct.designation||'—'}</td><td>${ct.phone||'—'}</td><td>${ct.email||'—'}</td><td>${ct.is_primary?'Yes':'—'}</td>
      ${canManage?`<td><span class="del" onclick="removeContact(${c.id},${ct.id})">remove</span></td>`:''}</tr>`).join('')}</tbody></table>` : `<div class="empty">No contacts yet.</div>`}
    ${canManage ? `
      <div class="form-grid" style="margin-top:10px;">
        <div class="field"><label>Name</label><input type="text" id="ct-name"></div>
        <div class="field"><label>Designation</label><input type="text" id="ct-designation" placeholder="optional"></div>
        <div class="field"><label>Phone</label><input type="text" id="ct-phone" placeholder="optional"></div>
        <div class="field"><label>Email</label><input type="text" id="ct-email" placeholder="optional"></div>
        <div class="field" style="display:flex;align-items:center;gap:8px;padding-top:22px;"><input type="checkbox" id="ct-primary"><label style="margin:0;">Primary</label></div>
        <button class="btn secondary-btn small" onclick="addContact(${c.id})">Add contact</button>
      </div>` : ''}

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Addresses</h3>
    ${c.addresses.length ? `<table><thead><tr><th>Type</th><th>Address</th><th>City</th><th>Country</th><th>Port of discharge</th>${canManage?'<th></th>':''}</tr></thead>
    <tbody>${c.addresses.map(a=>`<tr><td><span class="tag-pill raw">${a.address_type.replace('_',' ')}</span></td><td>${a.address_line}</td><td>${a.city||'—'}</td><td>${a.country_name||'—'}</td><td>${a.port_name||'—'}</td>
      ${canManage?`<td><span class="del" onclick="removeAddress(${c.id},${a.id})">remove</span></td>`:''}</tr>`).join('')}</tbody></table>` : `<div class="empty">No addresses yet.</div>`}
    ${canManage ? `
      <div class="form-grid" style="margin-top:10px;">
        <div class="field"><label>Type</label><select id="ad-type"><option value="billing">Billing</option><option value="shipping">Shipping</option><option value="consignee">Consignee</option><option value="notify_party">Notify party</option></select></div>
        <div class="field" style="grid-column:span 2;"><label>Address</label><input type="text" id="ad-line"></div>
        <div class="field"><label>City</label><input type="text" id="ad-city" placeholder="optional"></div>
        <div class="field"><label>State</label><input type="text" id="ad-state" placeholder="optional"></div>
        <button class="btn secondary-btn small" onclick="addAddress(${c.id})">Add address</button>
      </div>` : ''}
    <div style="margin-top:14px;"><button class="btn secondary-btn" onclick="closeCustomerDetail()">Close</button></div>
  `;
}
async function addCustomer(){
  const v = id => document.getElementById(id).value;
  try {
    await api('/export/customers', { method:'POST', body: JSON.stringify({
      code: v('cu-code').trim(), companyName: v('cu-name').trim(), category: v('cu-category').trim(),
      currencyId: Number(v('cu-currency'))||null, paymentTermsId: Number(v('cu-terms'))||null,
      incotermPrefId: Number(v('cu-incoterm'))||null, creditLimit: Number(v('cu-credit'))||0,
      taxRegNo: v('cu-tax').trim(), importLicenseNo: v('cu-license').trim(), website: v('cu-website').trim(),
      isPrivateLabel: document.getElementById('cu-private').checked,
    }) });
    note('Customer added');
    await render();
  } catch(e){ alert(e.message); }
}
async function addContact(customerId){
  const v = id => document.getElementById(id).value;
  try {
    await api(`/export/customers/${customerId}/contacts`, { method:'POST', body: JSON.stringify({
      name: v('ct-name').trim(), designation: v('ct-designation').trim(), phone: v('ct-phone').trim(), email: v('ct-email').trim(),
      isPrimary: document.getElementById('ct-primary').checked,
    }) });
    selectedCustomerDetail = await api(`/export/customers/${customerId}`);
    renderCustomerDetail();
  } catch(e){ alert(e.message); }
}
async function removeContact(customerId, contactId){
  try { await api(`/export/customers/${customerId}/contacts/${contactId}`, { method:'DELETE' }); selectedCustomerDetail = await api(`/export/customers/${customerId}`); renderCustomerDetail(); }
  catch(e){ alert(e.message); }
}
async function addAddress(customerId){
  const v = id => document.getElementById(id).value;
  try {
    await api(`/export/customers/${customerId}/addresses`, { method:'POST', body: JSON.stringify({
      addressType: v('ad-type'), addressLine: v('ad-line').trim(), city: v('ad-city').trim(), state: v('ad-state').trim(),
    }) });
    selectedCustomerDetail = await api(`/export/customers/${customerId}`);
    renderCustomerDetail();
  } catch(e){ alert(e.message); }
}
async function removeAddress(customerId, addressId){
  try { await api(`/export/customers/${customerId}/addresses/${addressId}`, { method:'DELETE' }); selectedCustomerDetail = await api(`/export/customers/${customerId}`); renderCustomerDetail(); }
  catch(e){ alert(e.message); }
}

// ---------------- PRODUCTS (Module 4: Product Variant Layer) ----------------
let variantsCache = [];
let selectedVariantId = null;
let selectedVariantDetail = null;

async function variantsHTML(){
  variantsCache = await api('/export/product-variants');
  const currencies = await api('/export/currencies');
  const finished = finishedGoods();

  const classificationHTML = isAdmin() ? `
    <div class="panel">
      <h2>Base product classification <span class="sub">does it pass through your own manufacturing line?</span></h2>
      <div class="table-scroll"><table>
        <thead><tr><th>Product</th><th>Category</th><th>Classification</th></tr></thead>
        <tbody>${finished.map(p=>`<tr><td>${p.name}</td><td>${p.category_name}</td>
          <td><select onchange="updateClassification(${p.id}, this.value)">
            ${['manufactured','traded','repacked','outsourced'].map(c=>`<option value="${c}" ${p.classification===c?'selected':''}>${c}</option>`).join('')}
          </select></td></tr>`).join('')}</tbody>
      </table></div>
      <div class="hint">Manufactured goods trace back to a real Mill Line batch. Traded/repacked/outsourced goods will use a supplier-lot record instead once Purchase/Packing for this flow is built.</div>
    </div>` : '';

  const formHTML = canManageVariants() ? `
    <div class="panel">
      <h2>Add a product variant (SKU)</h2>
      <div class="form-grid">
        <div class="field"><label>Base product</label><select id="pv-product">${finished.map(p=>`<option value="${p.id}">${p.name} (${p.classification})</option>`).join('')}</select></div>
        <div class="field"><label>SKU code</label><input type="text" id="pv-sku" placeholder="e.g. GNOIL-1L-BRANDX"></div>
        <div class="field"><label>Variant name</label><input type="text" id="pv-name" placeholder="e.g. Groundnut Oil 1L — Brand X"></div>
        <div class="field"><label>Brand</label><input type="text" id="pv-brand" placeholder="optional"></div>
        <div class="field"><label>Unit</label><input type="text" id="pv-unit" value="kg"></div>
        <div class="field"><label>Standard export price</label><input type="number" step="0.0001" id="pv-price" placeholder="optional"></div>
        <div class="field"><label>Currency</label><select id="pv-currency"><option value="">—</option>${currencies.map(c=>`<option value="${c.id}">${c.code}</option>`).join('')}</select></div>
        <div class="field"><label>Shelf life (days)</label><input type="number" id="pv-shelf" placeholder="optional"></div>
        <div class="field"><label>MOQ</label><input type="number" step="0.01" id="pv-moq" placeholder="optional"></div>
        <div class="field" style="display:flex;align-items:center;gap:8px;padding-top:22px;"><input type="checkbox" id="pv-private"><label style="margin:0;">Private label SKU</label></div>
        <button class="btn" onclick="addVariant()">Add variant</button>
      </div>
    </div>` : '';

  return classificationHTML + formHTML + `
    <div class="panel">
      <h2>All product variants <span class="sub">${variantsCache.length}</span></h2>
      ${variantsCache.length===0 ? `<div class="empty">No SKUs yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>SKU</th><th>Variant name</th><th>Product</th><th>Brand</th><th>Price</th><th>Status</th><th></th></tr></thead>
        <tbody>${variantsCache.map(v=>`<tr>
          <td>${v.sku_code}</td><td>${v.variant_name}</td><td>${v.product_name}</td><td>${v.brand||'—'}</td>
          <td>${v.standard_export_price?`${v.price_currency_code||''} ${fmt(v.standard_export_price)}`:'—'}</td>
          <td><span class="tag-pill ${v.status==='active'?'ok':'high'}">${v.status}</span></td>
          <td><span class="del" onclick="openVariantDetail(${v.id})">view</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="variantDetailPanel" style="${selectedVariantId?'':'display:none;'}"></div>
  `;
}

async function updateClassification(productId, classification){
  try { await api(`/products/${productId}`, { method:'PATCH', body: JSON.stringify({ classification }) }); await loadCatalog(); note('Classification updated'); await render(); }
  catch(e){ alert(e.message); }
}

async function addVariant(){
  const v = id => document.getElementById(id).value;
  try {
    await api('/export/product-variants', { method:'POST', body: JSON.stringify({
      productId: Number(v('pv-product')), skuCode: v('pv-sku').trim(), variantName: v('pv-name').trim(),
      brand: v('pv-brand').trim(), unitOfMeasure: v('pv-unit').trim(), standardExportPrice: v('pv-price')||null,
      priceCurrencyId: Number(v('pv-currency'))||null, shelfLifeDays: v('pv-shelf')||null, moq: v('pv-moq')||null,
      isPrivateLabel: document.getElementById('pv-private').checked,
    }) });
    note('Variant added');
    await render();
  } catch(e){ alert(e.message); }
}

async function openVariantDetail(id){
  selectedVariantId = id;
  selectedVariantDetail = await api(`/export/product-variants/${id}`);
  renderVariantDetail();
}
function closeVariantDetail(){
  selectedVariantId = null;
  const panel = document.getElementById('variantDetailPanel');
  if (panel) panel.style.display = 'none';
}
async function renderVariantDetail(){
  const panel = document.getElementById('variantDetailPanel');
  if (!panel) return;
  const v = selectedVariantDetail;
  const canManage = canManageVariants();
  const allCountries = await api('/export/countries');
  panel.style.display = '';
  panel.innerHTML = `
    <h2>${v.variant_name} <span class="sub">${v.sku_code} · ${v.product_name} (${v.classification})</span></h2>

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">HS codes by country</h3>
    ${v.hsCodes.length ? `<table><thead><tr><th>Country</th><th>HS Code</th></tr></thead>
      <tbody>${v.hsCodes.map(h=>`<tr><td>${h.country_name}</td><td>${h.hs_code}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">No HS codes yet.</div>`}
    ${canManage ? `
      <div class="form-grid" style="margin-top:10px;">
        <div class="field"><label>Country</label><select id="hs-country">${allCountries.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
        <div class="field"><label>HS code</label><input type="text" id="hs-code"></div>
        <button class="btn secondary-btn small" onclick="addHsCode(${v.id})">Add HS code</button>
      </div>` : ''}

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Packaging configurations</h3>
    ${v.packaging.length ? `<table><thead><tr><th>Pack size</th><th>Inner pack</th><th>Outer carton</th><th>Net wt</th><th>Gross wt</th><th>CBM</th></tr></thead>
      <tbody>${v.packaging.map(p=>`<tr><td>${p.pack_size||'—'}</td><td>${p.inner_pack_qty||'—'}</td><td>${p.outer_carton_qty||'—'}</td><td>${fmt(p.net_weight_kg)}</td><td>${fmt(p.gross_weight_kg)}</td><td>${fmt(p.cbm)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">No packaging configs yet.</div>`}
    ${canManage ? `
      <div class="form-grid" style="margin-top:10px;">
        <div class="field"><label>Pack size</label><input type="text" id="pk-size" placeholder="e.g. 1L"></div>
        <div class="field"><label>Inner pack qty</label><input type="number" id="pk-inner" placeholder="optional"></div>
        <div class="field"><label>Outer carton qty</label><input type="number" id="pk-outer" placeholder="optional"></div>
        <div class="field"><label>Net weight (kg)</label><input type="number" step="0.0001" id="pk-net" placeholder="optional"></div>
        <div class="field"><label>Gross weight (kg)</label><input type="number" step="0.0001" id="pk-gross" placeholder="optional"></div>
        <div class="field"><label>Carton L (cm)</label><input type="number" step="0.001" id="pk-l" placeholder="optional"></div>
        <div class="field"><label>Carton W (cm)</label><input type="number" step="0.001" id="pk-w" placeholder="optional"></div>
        <div class="field"><label>Carton H (cm)</label><input type="number" step="0.001" id="pk-h" placeholder="optional"></div>
        <div class="field"><label>Barcode</label><input type="text" id="pk-barcode" placeholder="optional"></div>
        <button class="btn secondary-btn small" onclick="addPackaging(${v.id})">Add packaging config</button>
      </div>` : ''}

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Customer-specific overrides</h3>
    ${v.customerConfigs.length ? `<table><thead><tr><th>Customer</th><th>Special price</th><th>Packaging requirement</th></tr></thead>
      <tbody>${v.customerConfigs.map(c=>`<tr><td>${c.customer_name}</td><td>${c.special_price?fmt(c.special_price):'—'}</td><td>${c.packaging_requirement||'—'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">No customer-specific overrides yet.</div>`}
    ${canManage ? `
      <div class="form-grid" style="margin-top:10px;">
        <div class="field"><label>Customer</label><select id="cc-customer">${(customersCache.length?customersCache:[]).map(c=>`<option value="${c.id}">${c.company_name}</option>`).join('')}</select></div>
        <div class="field"><label>Special price</label><input type="number" step="0.0001" id="cc-price" placeholder="optional"></div>
        <div class="field"><label>Packaging requirement</label><input type="text" id="cc-packreq" placeholder="optional"></div>
        <button class="btn secondary-btn small" onclick="addCustomerConfig(${v.id})">Add override</button>
      </div>
    <div class="hint">Customer list is empty here until you've visited the Customers tab at least once this session.</div>` : ''}

    <div style="margin-top:14px;"><button class="btn secondary-btn" onclick="closeVariantDetail()">Close</button></div>
  `;
}
async function addHsCode(variantId){
  const v = id => document.getElementById(id).value;
  try { await api(`/export/product-variants/${variantId}/hs-codes`, { method:'POST', body: JSON.stringify({ countryId:Number(v('hs-country')), hsCode:v('hs-code').trim() }) });
    selectedVariantDetail = await api(`/export/product-variants/${variantId}`); renderVariantDetail(); }
  catch(e){ alert(e.message); }
}
async function addPackaging(variantId){
  const v = id => document.getElementById(id).value;
  try {
    await api(`/export/product-variants/${variantId}/packaging`, { method:'POST', body: JSON.stringify({
      packSize:v('pk-size').trim(), innerPackQty:v('pk-inner')||null, outerCartonQty:v('pk-outer')||null,
      netWeightKg:v('pk-net')||null, grossWeightKg:v('pk-gross')||null, cartonLengthCm:v('pk-l')||null,
      cartonWidthCm:v('pk-w')||null, cartonHeightCm:v('pk-h')||null, barcode:v('pk-barcode').trim(),
    }) });
    selectedVariantDetail = await api(`/export/product-variants/${variantId}`); renderVariantDetail();
  } catch(e){ alert(e.message); }
}
async function addCustomerConfig(variantId){
  const v = id => document.getElementById(id).value;
  try {
    await api('/export/customer-product-configs', { method:'POST', body: JSON.stringify({
      customerId:Number(v('cc-customer')), variantId, specialPrice:v('cc-price')||null, packagingRequirement:v('cc-packreq').trim(),
    }) });
    selectedVariantDetail = await api(`/export/product-variants/${variantId}`); renderVariantDetail();
  } catch(e){ alert(e.message); }
}

// ---------------- PRICING (Module 5: Pricing Controls) ----------------
async function pricingHTML(){
  const [customersList, variantsList] = await Promise.all([
    api('/export/customers'), api('/export/product-variants'),
  ]);
  customersCache = customersList; // also refreshes the cache other tabs use

  const manageHTML = canManagePricing() ? `
    <div class="panel">
      <h2>Add a pricing control <span class="sub">global · variant · customer · customer + variant</span></h2>
      <div class="form-grid">
        <div class="field"><label>Scope</label><select id="pc-scope" onchange="onPricingScopeChange(this.value)">
          <option value="global">Global (company-wide default)</option>
          <option value="variant">Product / SKU-specific</option>
          <option value="customer">Customer-wide</option>
          <option value="customer_variant">Customer + SKU-specific</option>
        </select></div>
        <div class="field" id="pc-variant-field" style="display:none;"><label>SKU</label><select id="pc-variant">${variantsList.map(v=>`<option value="${v.id}">${v.sku_code} — ${v.variant_name}</option>`).join('')}</select></div>
        <div class="field" id="pc-customer-field" style="display:none;"><label>Customer</label><select id="pc-customer">${customersList.map(c=>`<option value="${c.id}">${c.company_name}</option>`).join('')}</select></div>
        <div class="field"><label>Minimum selling price</label><input type="number" step="0.0001" id="pc-minprice" placeholder="optional"></div>
        <div class="field"><label>Minimum margin %</label><input type="number" step="0.01" id="pc-minmargin" placeholder="optional"></div>
        <div class="field" id="pc-override-field" style="display:none;align-items:center;gap:8px;padding-top:22px;">
          <input type="checkbox" id="pc-override"><label style="margin:0;">Explicit override <span class="sub">supersedes every other applicable control</span></label>
        </div>
        <button class="btn" onclick="addPricingControl()">Add control</button>
      </div>
      <div class="hint">Rule: the highest (strictest) applicable minimum wins across Global/Variant/Customer — unless a Customer+SKU control is marked as an explicit override, which then applies alone.</div>
    </div>` : '';

  const controlsList = canManagePricing() ? await api('/export/pricing-controls') : [];
  const listHTML = canManagePricing() ? `
    <div class="panel">
      <h2>All pricing controls <span class="sub">${controlsList.length}</span></h2>
      ${controlsList.length===0 ? `<div class="empty">None yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Scope</th><th>Customer</th><th>SKU</th><th>Min price</th><th>Min margin %</th><th>Override</th><th></th></tr></thead>
        <tbody>${controlsList.map(c=>`<tr>
          <td>${c.scope.replace('_',' + ')}</td><td>${c.customer_name||'—'}</td><td>${c.sku_code||'—'}</td>
          <td>${c.min_selling_price?fmt(c.min_selling_price):'—'}</td><td>${c.min_margin_pct?fmt(c.min_margin_pct)+'%':'—'}</td>
          <td>${c.is_explicit_override?'Yes':'—'}</td>
          <td><span class="del" onclick="deactivatePricingControl(${c.id})">deactivate</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>` : '';

  const checkHTML = canCheckPricing() ? `
    <div class="panel">
      <h2>Check effective price floor</h2>
      <div class="form-grid">
        <div class="field"><label>SKU</label><select id="chk-variant"><option value="">—</option>${variantsList.map(v=>`<option value="${v.id}">${v.sku_code} — ${v.variant_name}</option>`).join('')}</select></div>
        <div class="field"><label>Customer</label><select id="chk-customer"><option value="">—</option>${customersList.map(c=>`<option value="${c.id}">${c.company_name}</option>`).join('')}</select></div>
        <button class="btn" onclick="checkPricingFloor()">Check floor</button>
      </div>
      <div id="pricingCheckResult" class="hint" style="margin-top:10px;"></div>
    </div>` : '';

  return manageHTML + listHTML + checkHTML;
}
function onPricingScopeChange(scope){
  document.getElementById('pc-variant-field').style.display = (scope==='variant'||scope==='customer_variant') ? '' : 'none';
  document.getElementById('pc-customer-field').style.display = (scope==='customer'||scope==='customer_variant') ? '' : 'none';
  document.getElementById('pc-override-field').style.display = (scope==='customer_variant') ? 'flex' : 'none';
}
async function addPricingControl(){
  const v = id => document.getElementById(id).value;
  const scope = v('pc-scope');
  try {
    await api('/export/pricing-controls', { method:'POST', body: JSON.stringify({
      scope, variantId: (scope==='variant'||scope==='customer_variant') ? Number(v('pc-variant')) : null,
      customerId: (scope==='customer'||scope==='customer_variant') ? Number(v('pc-customer')) : null,
      minSellingPrice: v('pc-minprice')||undefined, minMarginPct: v('pc-minmargin')||undefined,
      isExplicitOverride: scope==='customer_variant' && document.getElementById('pc-override').checked,
    }) });
    note('Pricing control added');
    await render();
  } catch(e){ alert(e.message); }
}
async function deactivatePricingControl(id){
  try { await api(`/export/pricing-controls/${id}`, { method:'PATCH', body: JSON.stringify({ active:false }) }); await render(); }
  catch(e){ alert(e.message); }
}
async function checkPricingFloor(){
  const variantId = document.getElementById('chk-variant').value;
  const customerId = document.getElementById('chk-customer').value;
  const box = document.getElementById('pricingCheckResult');
  try {
    const params = new URLSearchParams();
    if (variantId) params.set('variantId', variantId);
    if (customerId) params.set('customerId', customerId);
    const result = await api(`/export/pricing-controls/resolve?${params}`);
    box.innerHTML = `
      Minimum selling price: <strong>${result.minSellingPrice ?? 'none set'}</strong> &nbsp;|&nbsp;
      Minimum margin: <strong>${result.minMarginPct ?? 'none set'}${result.minMarginPct?'%':''}</strong> &nbsp;|&nbsp;
      Source: <strong>${result.source==='explicit_override'?'explicit override':result.source==='computed'?'most restrictive applicable control':'no control applies'}</strong>
    `;
  } catch(e){ box.textContent = e.message; }
}

// ---------------- APPROVALS (Module 6: Generic Approval Engine) ----------------
let wfBuilderGroups = [];
const DOC_TYPE_LABELS = { quotation:'Quotation', customer_po:'Customer PO', sales_order:'Sales Order', sales_order_amendment:'Sales Order Amendment', purchase_order:'Purchase Order', commercial_invoice:'Commercial Invoice', payment_adjustment:'Payment Adjustment', urid_preprocessing:'Urid Pre-Processing', urid_dhall_processing:'Urid Dhall Processing' };
const CONDITION_LABELS = { '':'Always required', value_threshold:'Order value above X', margin_below_min:'Margin below minimum', credit_exceeded:'Credit limit exceeded', price_below_min:'Price below minimum', po_difference:'PO differs from quotation', new_customer:'New customer', new_product:'New product', special_packing:'Special packing', shipment_without_advance:'Shipment without advance', invoice_revision:'Invoice revision' };

async function approvalsHTML(){
  const rolesList = isAdmin() ? await api('/roles') : [];
  const workflows = isAdmin() ? await api('/export/approval-workflows') : [];
  const pending = await api('/export/approvals/pending');

  const builderHTML = isAdmin() ? `
    <div class="panel">
      <h2>Build a workflow</h2>
      <div class="form-grid">
        <div class="field"><label>Workflow name</label><input type="text" id="wf-name" placeholder="e.g. Quotation Approval"></div>
        <div class="field"><label>Document type</label><select id="wf-doctype">${Object.entries(DOC_TYPE_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <div id="wfGroupsBox">
        ${wfBuilderGroups.map((g,gi)=>`
          <div class="panel" style="background:var(--white);">
            <div class="form-grid">
              <div class="field"><label>Group order</label><input type="number" value="${g.groupOrder}" onchange="wfBuilderGroups[${gi}].groupOrder=Number(this.value)"></div>
              <div class="field"><label>Rule</label><select onchange="wfBuilderGroups[${gi}].groupRule=this.value">
                <option value="ALL" ${g.groupRule==='ALL'?'selected':''}>ALL must approve</option>
                <option value="ANY" ${g.groupRule==='ANY'?'selected':''}>ANY one suffices</option>
              </select></div>
            </div>
            ${g.steps.map((s,si)=>`
              <div class="form-grid" style="margin-top:6px;">
                <div class="field"><label>Role</label><select onchange="wfBuilderGroups[${gi}].steps[${si}].roleRequired=this.value">
                  <option value="">Select role…</option>
                  ${rolesList.map(r=>`<option value="${r.code}" ${s.roleRequired===r.code?'selected':''}>${r.name}</option>`).join('')}
                </select></div>
                <div class="field"><label>Condition</label><select onchange="wfBuilderGroups[${gi}].steps[${si}].conditionType=this.value">
                  ${Object.entries(CONDITION_LABELS).map(([k,v])=>`<option value="${k}" ${s.conditionType===k?'selected':''}>${v}</option>`).join('')}
                </select></div>
                <div class="field"><label>Condition value <span class="sub">e.g. {"minValue":500000}</span></label><input type="text" value="${s.conditionConfig||''}" placeholder="optional JSON" onchange="wfBuilderGroups[${gi}].steps[${si}].conditionConfig=this.value"></div>
              </div>`).join('')}
            <button class="btn secondary-btn small" style="margin-top:8px;" onclick="wfBuilderGroups[${gi}].steps.push({roleRequired:'',conditionType:'',conditionConfig:''}); render();">+ Add step to this group</button>
          </div>`).join('')}
      </div>
      <button class="btn secondary-btn small" onclick="wfBuilderGroups.push({groupOrder:wfBuilderGroups.length+1,groupRule:'ALL',steps:[]}); render();">+ Add step group</button>
      <div style="margin-top:12px;"><button class="btn" onclick="submitWorkflow()">Save workflow</button></div>
    </div>

    <div class="panel">
      <h2>Existing workflows</h2>
      ${workflows.length===0 ? `<div class="empty">None yet.</div>` : workflows.map(w=>`
        <div style="border-bottom:1px solid var(--line);padding:10px 0;">
          <strong>${w.name}</strong> <span class="tag-pill ${w.active?'ok':'high'}">${w.active?'active':'inactive'}</span>
          <span class="sub">${DOC_TYPE_LABELS[w.document_type]}</span>
          <span class="del" style="float:right;" onclick="toggleWorkflow(${w.id}, ${!w.active})">${w.active?'deactivate':'activate'}</span>
          <div class="hint">${w.groups.map(g=>`Group ${g.group_order} (${g.group_rule}): ${g.steps.map(s=>s.role_required+(s.condition_type?` [if ${CONDITION_LABELS[s.condition_type]||s.condition_type}]`:'')).join(', ')}`).join(' → ')}</div>
        </div>`).join('')}
    </div>

    <div class="panel">
      <h2>Test harness <span class="sub">Quotation/Sales Order don't exist yet — use this to exercise a workflow end-to-end now</span></h2>
      <div class="form-grid">
        <div class="field"><label>Document type</label><select id="test-doctype">${Object.entries(DOC_TYPE_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field" style="grid-column:span 2;"><label>Context JSON</label><input type="text" id="test-context" placeholder='e.g. {"orderValue":600000,"creditExceeded":true}'></div>
        <button class="btn" onclick="startTestRun()">Start test run</button>
      </div>
      <div id="testRunResult" class="hint" style="margin-top:8px;"></div>
    </div>` : '';

  const inboxHTML = `
    <div class="panel">
      <h2>My Approvals <span class="sub">${pending.length} pending</span></h2>
      ${pending.length===0 ? `<div class="empty">Nothing waiting on you right now.</div>` : pending.map(p=>`
        <div class="panel" style="background:var(--white);">
          <strong>${p.workflowName}</strong> <span class="sub">${DOC_TYPE_LABELS[p.documentType]||p.documentType} #${p.documentId} · your role: ${p.roleRequired} · group rule: ${p.groupRule}</span>
          <div class="hint">Context: ${JSON.stringify(p.context)}</div>
          <div class="form-grid" style="margin-top:8px;">
            <div class="field"><label>Decision</label><select id="dec-${p.approvalRunId}-${p.workflowStepId}">
              <option value="approve">Approve</option>
              <option value="reject">Reject</option>
              <option value="return_for_correction">Return for Correction</option>
              <option value="clarification_requested">Request Clarification</option>
              <option value="cancel">Cancel</option>
            </select></div>
            <div class="field" style="grid-column:span 2;"><label>Comment</label><input type="text" id="cmt-${p.approvalRunId}-${p.workflowStepId}" placeholder="optional"></div>
            <button class="btn" onclick="submitApprovalAction(${p.approvalRunId}, ${p.workflowStepId})">Submit</button>
          </div>
        </div>`).join('')}
    </div>`;

  return builderHTML + inboxHTML;
}

async function submitWorkflow(){
  const name = document.getElementById('wf-name').value.trim();
  const documentType = document.getElementById('wf-doctype').value;
  const stepGroups = wfBuilderGroups.map(g => ({
    groupOrder: g.groupOrder, groupRule: g.groupRule,
    steps: g.steps.filter(s=>s.roleRequired).map(s => ({
      roleRequired: s.roleRequired, conditionType: s.conditionType || null,
      conditionConfig: s.conditionConfig ? (()=>{ try { return JSON.parse(s.conditionConfig); } catch { return null; } })() : null,
    })),
  }));
  try {
    await api('/export/approval-workflows', { method:'POST', body: JSON.stringify({ name, documentType, stepGroups }) });
    note('Workflow saved');
    wfBuilderGroups = [];
    await render();
  } catch(e){ alert(e.message); }
}
async function toggleWorkflow(id, active){
  try { await api(`/export/approval-workflows/${id}`, { method:'PATCH', body: JSON.stringify({ active }) }); await render(); }
  catch(e){ alert(e.message); }
}
async function startTestRun(){
  const documentType = document.getElementById('test-doctype').value;
  const raw = document.getElementById('test-context').value.trim();
  let context = {};
  if (raw) { try { context = JSON.parse(raw); } catch { alert('Context must be valid JSON.'); return; } }
  const box = document.getElementById('testRunResult');
  try {
    const run = await api('/export/approvals/test-run', { method:'POST', body: JSON.stringify({ documentType, context }) });
    box.textContent = `Test run #${run.id} started — status: ${run.status}, current group: ${run.current_group_order}. Check "My Approvals" below if you hold a required role.`;
    await render();
  } catch(e){ box.textContent = e.message; }
}
async function submitApprovalAction(runId, stepId){
  const decision = document.getElementById(`dec-${runId}-${stepId}`).value;
  const comment = document.getElementById(`cmt-${runId}-${stepId}`).value.trim();
  try {
    await api(`/export/approvals/${runId}/steps/${stepId}/action`, { method:'POST', body: JSON.stringify({ decision, comment }) });
    note('Decision recorded');
    await render();
  } catch(e){ alert(e.message); }
}

// ---------------- QUOTATIONS (Module 7: Quotation + Revisions) ----------------
let quotationsCache = [];
let qItemRows = [];
let selectedQuotationId = null;
let selectedQuotationDetail = null;
const QUOTATION_STATUS_LABEL = { draft:'Draft', pending_approval:'Pending Approval', approved:'Approved', sent_to_customer:'Sent to Customer', customer_reviewing:'Customer Reviewing', customer_accepted:'Customer Accepted', customer_rejected:'Customer Rejected', revision_requested:'Revision Requested', po_awaited:'PO Awaited', closed:'Closed' };
const QUOTATION_STATUS_CLASS = { draft:'raw', pending_approval:'high', approved:'ok', sent_to_customer:'oil', customer_reviewing:'high', customer_accepted:'ok', customer_rejected:'high', revision_requested:'high', po_awaited:'high', closed:'raw' };

// ---------------- SHARED LIST FILTERS ----------------
let quotationFilters = { customerId:'', status:'', text:'' };
let poFilters = { customerId:'', status:'', text:'' };
let soFilters = { customerId:'', status:'', text:'' };
function applyListFilters(list, filters, textFields){
  return list.filter(item => {
    if (filters.customerId && String(item.customer_id) !== String(filters.customerId)) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.text) {
      const t = filters.text.toLowerCase();
      if (!textFields.some(f => (item[f]||'').toLowerCase().includes(t))) return false;
    }
    return true;
  });
}
function filterBarHTML(filterVarName, filters, customersList, statusLabels, textPlaceholder){
  return `
    <div class="form-grid" style="margin-bottom:10px;">
      <div class="field"><label>Customer</label><select onchange="Object.assign(${filterVarName},{customerId:this.value}); render();">
        <option value="">All</option>${customersList.map(c=>`<option value="${c.id}" ${filters.customerId==c.id?'selected':''}>${c.company_name}</option>`).join('')}
      </select></div>
      <div class="field"><label>Status</label><select onchange="Object.assign(${filterVarName},{status:this.value}); render();">
        <option value="">All</option>${Object.entries(statusLabels).map(([k,v])=>`<option value="${k}" ${filters.status===k?'selected':''}>${v}</option>`).join('')}
      </select></div>
      <div class="field"><label>Search</label><input type="text" value="${filters.text}" placeholder="${textPlaceholder}" oninput="Object.assign(${filterVarName},{text:this.value}); renderFilterOnly();"></div>
      <button class="btn secondary-btn small" onclick="Object.assign(${filterVarName},{customerId:'',status:'',text:''}); render();">Clear filter</button>
    </div>`;
}
// Typing in a text filter shouldn't refetch from the server on every
// keystroke — this just re-runs render() but debounced.
let filterDebounce = null;
function renderFilterOnly(){ clearTimeout(filterDebounce); filterDebounce = setTimeout(render, 300); }

async function quotationsHTML(){
  quotationsCache = await api('/export/quotations');
  const canManage = canManageQuotations();
  const [currencies, incoterms, paymentTerms] = await Promise.all([
    api('/export/currencies'), api('/export/incoterms'), api('/export/payment-terms'),
  ]);
  customersCache = await api('/export/customers');
  variantsCache = await api('/export/product-variants');

  if (canManage && qItemRows.length===0) qItemRows = [{ variantId:'', quantity:'', unitPrice:'', productCost:'', packingCost:'', freightAllocation:'' }];

  const formHTML = canManage ? `
    <div class="panel">
      <h2>New quotation</h2>
      <div class="form-grid">
        <div class="field"><label>Customer</label><select id="q-customer">${customersCache.map(c=>`<option value="${c.id}">${c.company_name}</option>`).join('')}</select></div>
        <div class="field"><label>Currency</label><select id="q-currency">${currencies.map(c=>`<option value="${c.id}">${c.code}</option>`).join('')}</select></div>
        <div class="field"><label>Incoterm</label><select id="q-incoterm">${incoterms.map(i=>`<option value="${i.id}">${i.code}</option>`).join('')}</select></div>
        <div class="field"><label>Payment terms</label><select id="q-terms">${paymentTerms.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
        <div class="field"><label>Validity date</label><input type="date" id="q-validity"></div>
        <div class="field"><label>Production lead time (days)</label><input type="number" id="q-prodlead" placeholder="optional"></div>
        <div class="field"><label>Shipment lead time (days)</label><input type="number" id="q-shiplead" placeholder="optional"></div>
        <div class="field" style="grid-column:span 2;"><label>Remarks</label><input type="text" id="q-remarks" placeholder="optional"></div>
      </div>
      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Line items</h3>
      ${qItemRows.map((r,i)=>`
        <div class="form-grid" style="margin-bottom:6px;">
          <div class="field"><label>SKU</label><select onchange="qItemRows[${i}].variantId=this.value">
            <option value="">Select…</option>${variantsCache.map(v=>`<option value="${v.id}" ${r.variantId==v.id?'selected':''}>${v.sku_code} — ${v.variant_name}</option>`).join('')}
          </select></div>
          <div class="field"><label>Qty</label><input type="number" step="0.01" value="${r.quantity}" onchange="qItemRows[${i}].quantity=this.value"></div>
          <div class="field"><label>Unit price</label><input type="number" step="0.0001" value="${r.unitPrice}" onchange="qItemRows[${i}].unitPrice=this.value"></div>
          <div class="field"><label>Product cost <span class="sub">internal</span></label><input type="number" step="0.0001" value="${r.productCost}" onchange="qItemRows[${i}].productCost=this.value" placeholder="optional"></div>
          <div class="field"><label>Packing cost <span class="sub">internal</span></label><input type="number" step="0.0001" value="${r.packingCost}" onchange="qItemRows[${i}].packingCost=this.value" placeholder="optional"></div>
          <div class="field"><label>Freight alloc. <span class="sub">internal</span></label><input type="number" step="0.0001" value="${r.freightAllocation}" onchange="qItemRows[${i}].freightAllocation=this.value" placeholder="optional"></div>
        </div>`).join('')}
      <button class="btn secondary-btn small" onclick="qItemRows.push({variantId:'',quantity:'',unitPrice:'',productCost:'',packingCost:'',freightAllocation:''}); render();">+ Add line item</button>
      <div style="margin-top:12px;"><button class="btn" onclick="createQuotation()">Create quotation (Draft)</button></div>
      <div class="hint">Cost fields are internal-only — used for margin checks and approval routing, never shown to the customer.</div>
    </div>` : '';

  const filteredQuotations = applyListFilters(quotationsCache, quotationFilters, ['quotation_no', 'customer_name']);

  return formHTML + `
    <div class="panel">
      <h2>All quotations <span class="sub">${filteredQuotations.length} of ${quotationsCache.length}</span></h2>
      ${filterBarHTML('quotationFilters', quotationFilters, customersCache, QUOTATION_STATUS_LABEL, 'quotation no. or customer')}
      ${filteredQuotations.length===0 ? `<div class="empty">No matches.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Quotation No.</th><th>Customer</th><th>Revision</th><th>Status</th><th></th></tr></thead>
        <tbody>${filteredQuotations.map(q=>`<tr>
          <td>${q.quotation_no}</td><td>${q.customer_name}</td><td>REV-${String(q.current_revision_no).padStart(2,'0')}</td>
          <td><span class="tag-pill ${QUOTATION_STATUS_CLASS[q.status]||'raw'}">${QUOTATION_STATUS_LABEL[q.status]||q.status}</span></td>
          <td><span class="del" onclick="openQuotationDetail(${q.id})">view</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="quotationDetailPanel" style="${selectedQuotationId?'':'display:none;'}"></div>
  `;
}

async function createQuotation(){
  const v = id => document.getElementById(id).value;
  const items = qItemRows.filter(r=>r.variantId && r.quantity && r.unitPrice).map(r=>({
    variantId:Number(r.variantId), quantity:Number(r.quantity), unitPrice:Number(r.unitPrice),
    productCost:r.productCost||null, packingCost:r.packingCost||null, freightAllocation:r.freightAllocation||null,
  }));
  try {
    await api('/export/quotations', { method:'POST', body: JSON.stringify({
      customerId:Number(v('q-customer')), currencyId:Number(v('q-currency')), incotermId:Number(v('q-incoterm')),
      paymentTermsId:Number(v('q-terms')), validityDate:v('q-validity')||null, productionLeadTimeDays:v('q-prodlead')||null,
      shipmentLeadTimeDays:v('q-shiplead')||null, remarks:v('q-remarks').trim(), items,
    }) });
    note('Quotation created as Draft');
    qItemRows = [];
    await render();
  } catch(e){ alert(e.message); }
}

let quotationTimelineCache = [];
async function openQuotationDetail(id){
  selectedQuotationId = id;
  selectedQuotationDetail = await api(`/export/quotations/${id}`);
  quotationTimelineCache = await api(`/export/timeline?quotationId=${id}`);
  renderQuotationDetail();
}
function closeQuotationDetail(){
  selectedQuotationId = null;
  const panel = document.getElementById('quotationDetailPanel');
  if (panel) panel.style.display = 'none';
}
function renderQuotationDetail(){
  const panel = document.getElementById('quotationDetailPanel');
  if (!panel) return;
  const q = selectedQuotationDetail;
  const canManage = canManageQuotations();
  panel.style.display = '';

  const actionButtons = canManage ? `
    ${q.status==='draft' ? `<button class="btn" onclick="submitQuotationForApproval(${q.id})">Submit for Approval</button>` : ''}
    ${q.status==='approved' ? `<button class="btn" onclick="sendQuotationToCustomer(${q.id})">Send to Customer</button>` : ''}
    ${['sent_to_customer','customer_reviewing'].includes(q.status) ? `
      <button class="btn secondary-btn small" onclick="recordCustomerResponse(${q.id},'accepted')">Customer Accepted</button>
      <button class="btn secondary-btn small" onclick="recordCustomerResponse(${q.id},'rejected')">Customer Rejected</button>
      <button class="btn secondary-btn small" onclick="recordCustomerResponse(${q.id},'revision_requested')">Revision Requested</button>
    ` : ''}
    ${['customer_rejected','revision_requested'].includes(q.status) ? `<button class="btn" onclick="reviseQuotation(${q.id})">Create New Revision</button>` : ''}
  ` : '';

  panel.innerHTML = `
    <h2>${q.quotation_no} <span class="sub">${q.customer_name} · ${QUOTATION_STATUS_LABEL[q.status]||q.status}</span></h2>
    ${q.latestApprovalRun ? `<div class="hint">Latest approval run: #${q.latestApprovalRun.id} — ${q.latestApprovalRun.status} (group ${q.latestApprovalRun.current_group_order}). Check the Approvals tab to act on it.</div>` : ''}
    <div style="margin:10px 0;display:flex;gap:8px;flex-wrap:wrap;">${actionButtons}</div>
    ${q.revisions.map(rev=>`
      <div class="panel" style="background:var(--white);">
        <h3 style="font-family:'Oswald',sans-serif;font-size:14px;text-transform:uppercase;margin:0 0 8px;">REV-${String(rev.revision_no).padStart(2,'0')} ${rev.is_immutable?'<span class="tag-pill high">sent — immutable</span>':'<span class="tag-pill ok">editable</span>'}</h3>
        <div class="hint">Snapshot: ${rev.snapshot_customer_name||'—'} · ${rev.snapshot_billing_address||'no billing address on file'} · ${rev.snapshot_country||''}</div>
        <table><thead><tr><th>SKU</th><th>Qty</th><th>Unit Price</th><th>Margin %</th></tr></thead>
        <tbody>${rev.items.map(it=>`<tr><td>${it.sku_code}</td><td>${fmt(it.quantity)}</td><td>${fmt(it.unit_price)}</td><td>${fmt(it.expected_margin_pct)}%</td></tr>`).join('')}</tbody></table>
      </div>`).join('')}
    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Timeline</h3>
    ${quotationTimelineCache.length===0 ? `<div class="empty">Nothing recorded yet.</div>` : `
    <div class="hint">${quotationTimelineCache.map(t=>`${new Date(t.event_at).toLocaleString()} — ${t.event_label}`).join('<br>')}</div>`}
    <div style="margin-top:14px;"><button class="btn secondary-btn" onclick="closeQuotationDetail()">Close</button></div>
  `;
}
async function submitQuotationForApproval(id){
  try { await api(`/export/quotations/${id}/submit-for-approval`, { method:'POST' }); note('Submitted for approval'); selectedQuotationDetail = await api(`/export/quotations/${id}`); renderQuotationDetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function sendQuotationToCustomer(id){
  if (!confirm('Once sent, this revision becomes permanently immutable. Continue?')) return;
  try { await api(`/export/quotations/${id}/send-to-customer`, { method:'POST' }); note('Sent to customer'); selectedQuotationDetail = await api(`/export/quotations/${id}`); renderQuotationDetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function recordCustomerResponse(id, response){
  try { await api(`/export/quotations/${id}/customer-response`, { method:'PATCH', body: JSON.stringify({ response }) }); selectedQuotationDetail = await api(`/export/quotations/${id}`); renderQuotationDetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function reviseQuotation(id){
  try { await api(`/export/quotations/${id}/revise`, { method:'POST' }); note('New revision created'); selectedQuotationDetail = await api(`/export/quotations/${id}`); renderQuotationDetail(); await render(); }
  catch(e){ alert(e.message); }
}

// ---------------- CUSTOMER POs (Module 8: Intake + Comparison) ----------------
let poItemRows = [];
let selectedPOId = null;
let selectedPODetail = null;
let poSelectedQuotationRevisionId = null;
const PO_STATUS_LABEL = { uploaded:'Uploaded', under_comparison:'Under Comparison', differences_pending_approval:'Differences Pending Approval', confirmed:'Confirmed', superseded:'Superseded' };
const PO_STATUS_CLASS = { uploaded:'raw', under_comparison:'high', differences_pending_approval:'high', confirmed:'ok', superseded:'raw' };
const PO_FIELD_LABEL = { currency:'Currency', incoterm:'Incoterm', payment_terms:'Payment Terms', requested_shipment_date:'Requested Shipment Date', destination_port:'Destination Port', sku:'Product / SKU', quantity:'Quantity', unit_price:'Unit Price' };

async function customerPOsHTML(){
  const poList = await api('/export/customer-pos');
  const canManage = canManageQuotations();
  quotationsCache = await api('/export/quotations');
  variantsCache = await api('/export/product-variants');
  const sendableQuotations = quotationsCache.filter(q => !['draft','pending_approval','approved'].includes(q.status));

  if (canManage && poItemRows.length===0) poItemRows = [{ variantId:'', quantity:'', price:'' }];

  const formHTML = canManage ? `
    <div class="panel">
      <h2>Upload a customer PO</h2>
      <div class="form-grid">
        <div class="field"><label>Quotation this responds to</label><select id="po-quotation" onchange="onPOQuotationChange(this.value)">
          <option value="">Select…</option>
          ${sendableQuotations.map(q=>`<option value="${q.id}">${q.quotation_no} — ${q.customer_name}</option>`).join('')}
        </select></div>
        <div class="field"><label>PO number</label><input type="text" id="po-no"></div>
        <div class="field"><label>PO date</label><input type="date" id="po-date" value="${todayStr()}"></div>
        <div class="field"><label>Currency</label><select id="po-currency"><option value="">—</option>${(await api('/export/currencies')).map(c=>`<option value="${c.id}">${c.code}</option>`).join('')}</select></div>
        <div class="field"><label>Incoterm</label><select id="po-incoterm"><option value="">—</option>${(await api('/export/incoterms')).map(i=>`<option value="${i.id}">${i.code}</option>`).join('')}</select></div>
        <div class="field"><label>Payment terms</label><select id="po-terms"><option value="">—</option>${(await api('/export/payment-terms')).map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
        <div class="field"><label>Requested shipment date</label><input type="date" id="po-shipdate"></div>
        <div class="field" style="grid-column:span 2;"><label>Shipping instructions</label><input type="text" id="po-shipinst" placeholder="optional — not compared, carried forward"></div>
      </div>
      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Line items</h3>
      ${poItemRows.map((r,i)=>`
        <div class="form-grid" style="margin-bottom:6px;">
          <div class="field"><label>SKU</label><select onchange="poItemRows[${i}].variantId=this.value">
            <option value="">Select…</option>${variantsCache.map(v=>`<option value="${v.id}" ${r.variantId==v.id?'selected':''}>${v.sku_code} — ${v.variant_name}</option>`).join('')}
          </select></div>
          <div class="field"><label>Qty</label><input type="number" step="0.01" value="${r.quantity}" onchange="poItemRows[${i}].quantity=this.value"></div>
          <div class="field"><label>Price</label><input type="number" step="0.0001" value="${r.price}" onchange="poItemRows[${i}].price=this.value"></div>
        </div>`).join('')}
      <button class="btn secondary-btn small" onclick="poItemRows.push({variantId:'',quantity:'',price:''}); render();">+ Add line item</button>
      <div style="margin-top:12px;"><button class="btn" onclick="createCustomerPO()">Upload PO</button></div>
    </div>` : '';

  const filteredPOs = applyListFilters(poList, poFilters, ['po_no', 'customer_name']);

  return formHTML + `
    <div class="panel">
      <h2>All customer POs <span class="sub">${filteredPOs.length} of ${poList.length}</span></h2>
      ${filterBarHTML('poFilters', poFilters, customersCache, PO_STATUS_LABEL, 'PO no. or customer')}
      ${filteredPOs.length===0 ? `<div class="empty">No matches.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>PO No.</th><th>Customer</th><th>Quotation</th><th>Status</th><th></th></tr></thead>
        <tbody>${filteredPOs.map(p=>`<tr>
          <td>${p.po_no}</td><td>${p.customer_name}</td><td>${p.quotation_no}</td>
          <td><span class="tag-pill ${PO_STATUS_CLASS[p.status]||'raw'}">${PO_STATUS_LABEL[p.status]||p.status}</span></td>
          <td><span class="del" onclick="openPODetail(${p.id})">view</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="poDetailPanel" style="${selectedPOId?'':'display:none;'}"></div>
  `;
}

async function onPOQuotationChange(quotationId){
  if (!quotationId) { poSelectedQuotationRevisionId = null; return; }
  const detail = await api(`/export/quotations/${quotationId}`);
  const currentRev = detail.revisions.find(r => r.revision_no === detail.current_revision_no);
  poSelectedQuotationRevisionId = currentRev ? currentRev.id : null;
}

async function createCustomerPO(){
  const v = id => document.getElementById(id).value;
  if (!poSelectedQuotationRevisionId) { alert('Select the quotation this PO responds to.'); return; }
  const items = poItemRows.filter(r=>r.variantId && r.quantity && r.price).map(r=>({
    variantId:Number(r.variantId), quantity:Number(r.quantity), price:Number(r.price),
  }));
  try {
    await api('/export/customer-pos', { method:'POST', body: JSON.stringify({
      poNo:v('po-no').trim(), poDate:v('po-date')||todayStr(), customerId:quotationsCache.find(q=>q.id==v('po-quotation'))?.customer_id,
      quotationRevisionId:poSelectedQuotationRevisionId, currencyId:Number(v('po-currency'))||null,
      incotermId:Number(v('po-incoterm'))||null, paymentTermsId:Number(v('po-terms'))||null,
      requestedShipmentDate:v('po-shipdate')||null, shippingInstructions:v('po-shipinst').trim(), items,
    }) });
    note('PO uploaded');
    poItemRows = [];
    await render();
  } catch(e){ alert(e.message); }
}

let poDocumentsCache = [];
async function openPODetail(id){
  selectedPOId = id;
  poPreviewDocId = null;
  selectedPODetail = await api(`/export/customer-pos/${id}`);
  poDocumentsCache = await api(`/export/documents?relatedType=customer_po&relatedId=${id}`);
  renderPODetail();
}
function closePODetail(){
  selectedPOId = null;
  const panel = document.getElementById('poDetailPanel');
  if (panel) panel.style.display = 'none';
}
let poPreviewDocId = null;
function renderPODetail(){
  const panel = document.getElementById('poDetailPanel');
  if (!panel) return;
  const p = selectedPODetail;
  panel.style.display = '';

  const enteredDataHTML = `
    <table><thead><tr><th>SKU</th><th>Qty</th><th>Price</th></tr></thead>
    <tbody>${p.items.map(it=>`<tr><td>${it.sku_code}</td><td>${fmt(it.quantity)}</td><td>${fmt(it.price)}</td></tr>`).join('')}</tbody></table>

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Comparison vs quotation</h3>
    ${p.comparison.length===0 ? `<div class="empty">Not compared yet.</div>` : `
    <table><thead><tr><th>Field</th><th>Quotation value</th><th>PO value</th><th>Difference</th></tr></thead>
    <tbody>${p.comparison.map(c=>`<tr><td>${PO_FIELD_LABEL[c.field_name]||c.field_name}</td><td>${c.quotation_value}</td><td>${c.po_value}</td>
      <td>${c.is_difference ? `<span class="tag-pill high">material — needs approval</span>` : `<span class="tag-pill ok">match</span>`}</td></tr>`).join('')}</tbody></table>`}
  `;

  const previewDoc = poDocumentsCache.find(d => d.id === poPreviewDocId);
  const canPreview = d => (d.file_mime_type||'').includes('pdf') || (d.file_mime_type||'').startsWith('image/');

  panel.innerHTML = `
    <h2>${p.po_no} <span class="sub">${p.customer_name} · vs ${p.quotation_no} · ${PO_STATUS_LABEL[p.status]||p.status}</span></h2>
    ${p.latestApprovalRun ? `<div class="hint">Latest approval run: #${p.latestApprovalRun.id} — ${p.latestApprovalRun.status}. Check the Approvals tab to act on it.</div>` : ''}

    ${previewDoc ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:10px;">
        <div>
          <div class="hint" style="margin-bottom:6px;">Original: ${previewDoc.original_filename||previewDoc.doc_type} <span class="del" onclick="poPreviewDocId=null; renderPODetail();">close preview</span></div>
          ${(previewDoc.file_mime_type||'').startsWith('image/')
            ? `<img src="/api/export/documents/${previewDoc.id}/file?inline=1" style="width:100%;border:1px solid var(--line);">`
            : `<iframe src="/api/export/documents/${previewDoc.id}/file?inline=1" style="width:100%;height:520px;border:1px solid var(--line);"></iframe>`}
        </div>
        <div>${enteredDataHTML}</div>
      </div>
    ` : enteredDataHTML}

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Attached documents <span class="sub">e.g. the original signed PO</span></h3>
    ${poDocumentsCache.length===0 ? `<div class="empty">Nothing attached yet.</div>` : `
    <table><thead><tr><th>Doc type</th><th>Ver.</th><th>File</th><th>Status</th><th></th></tr></thead>
    <tbody>${poDocumentsCache.map(d=>`<tr><td>${d.doc_type}</td><td>${d.version_no}</td>
      <td><a href="/api/export/documents/${d.id}/file" target="_blank">${d.original_filename||'download'}</a></td>
      <td><span class="tag-pill ${DOC_STATUS_CLASS[d.status]||'raw'}">${DOC_STATUS_LABEL[d.status]||d.status}</span></td>
      <td>${canPreview(d) ? `<span class="del" onclick="poPreviewDocId=${d.id}; renderPODetail();">preview side-by-side</span>` : `<span class="sub">no preview for this file type</span>`}</td>
      </tr>`).join('')}</tbody></table>`}
    <div class="form-grid" style="margin-top:8px;">
      <div class="field"><label>Document type</label><input type="text" id="po-doc-type" placeholder="e.g. customer_po_original" value="customer_po_original"></div>
      <div class="field"><label>File</label><input type="file" id="po-doc-file"></div>
      <button class="btn secondary-btn small" onclick="attachPODocument(${p.id})">Attach</button>
    </div>

    <div style="margin-top:14px;display:flex;gap:8px;">
      ${p.status==='uploaded' ? `<button class="btn" onclick="runPOComparison(${p.id})">Run Comparison</button>` : ''}
      <button class="btn secondary-btn" onclick="closePODetail()">Close</button>
    </div>
  `;
}
async function attachPODocument(poId){
  const docType = document.getElementById('po-doc-type').value.trim();
  const fileInput = document.getElementById('po-doc-file');
  if (!docType || !fileInput.files.length) { alert('Enter a document type and choose a file.'); return; }
  try {
    await uploadDocumentToServer('customer_po', poId, 'customer', docType, fileInput.files[0]);
    poDocumentsCache = await api(`/export/documents?relatedType=customer_po&relatedId=${poId}`);
    renderPODetail();
  } catch(e){ alert(e.message); }
}
async function runPOComparison(id){
  try {
    const result = await api(`/export/customer-pos/${id}/compare`, { method:'POST' });
    if (result.approvalRunError) alert(`Comparison ran, but no approval workflow exists for Customer PO yet: ${result.approvalRunError}`);
    else note(result.hasDifferences ? 'Differences found — approval required' : 'No differences — PO confirmed');
    selectedPODetail = await api(`/export/customer-pos/${id}`);
    renderPODetail();
    await render();
  } catch(e){ alert(e.message); }
}

// ---------------- SALES ORDERS (Module 9: SO + PO Allocation) ----------------
let soAllocRows = [];
let selectedSOId = null;
let selectedSODetail = null;
const SO_STATUS_LABEL = { draft:'Draft', pending_approval:'Pending Approval', approved:'Approved', rejected:'Rejected', factory_released:'Factory Released', in_production:'In Production', production_complete:'Production Complete', packing:'Packing', partially_shipped:'Partially Shipped', fully_shipped:'Fully Shipped', delivered:'Delivered', payment_pending:'Payment Pending', payment_partial:'Payment Partial', payment_complete:'Payment Complete', closed:'Closed', cancelled:'Cancelled' };
const SO_STATUS_CLASS = { draft:'raw', pending_approval:'high', approved:'ok', rejected:'high', cancelled:'high', closed:'raw' };

async function salesOrdersHTML(){
  const soList = await api('/export/sales-orders');
  const canManage = canManageSalesOrders();
  customersCache = await api('/export/customers');
  const confirmedPOs = (await api('/export/customer-pos')).filter(p => p.status === 'confirmed');

  if (canManage && soAllocRows.length===0) soAllocRows = [{ customerPoId:'', customerPoItemId:'', allocatedQty:'', poItems:[], balance:null }];

  const formHTML = canManage ? `
    <div class="panel">
      <h2>Create Sales Order <span class="sub">allocate specific quantities from confirmed POs — supports partial allocation</span></h2>
      <div class="form-grid">
        <div class="field"><label>Customer</label><select id="so-customer">${customersCache.map(c=>`<option value="${c.id}">${c.company_name}</option>`).join('')}</select></div>
        <div class="field"><label>ETD (planned)</label><input type="date" id="so-etd"></div>
        <div class="field"><label>ETA (planned)</label><input type="date" id="so-eta"></div>
      </div>
      <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Allocations</h3>
      ${soAllocRows.map((r,i)=>`
        <div class="form-grid" style="margin-bottom:6px;">
          <div class="field"><label>Confirmed PO</label><select onchange="onSOAllocPOChange(${i}, this.value)">
            <option value="">Select…</option>${confirmedPOs.map(p=>`<option value="${p.id}" ${r.customerPoId==p.id?'selected':''}>${p.po_no} — ${p.customer_name}</option>`).join('')}
          </select></div>
          <div class="field"><label>PO line item</label><select onchange="onSOAllocItemChange(${i}, this.value)">
            <option value="">Select PO first…</option>
            ${r.poItems.map(it=>`<option value="${it.id}" ${r.customerPoItemId==it.id?'selected':''}>${it.sku_code} (${fmt(it.quantity)} @ ${fmt(it.price)})</option>`).join('')}
          </select></div>
          <div class="field"><label>Allocate qty</label><input type="number" step="0.01" value="${r.allocatedQty}" onchange="soAllocRows[${i}].allocatedQty=this.value"></div>
          <div class="field"><label class="sub">Balance</label><div class="hint">${r.balance ? `PO qty: ${fmt(r.balance.poQty)} · Already allocated: ${fmt(r.balance.previouslyAllocated)} · Remaining: ${fmt(r.balance.remainingBalance)}` : '—'}</div></div>
        </div>`).join('')}
      <button class="btn secondary-btn small" onclick="soAllocRows.push({customerPoId:'',customerPoItemId:'',allocatedQty:'',poItems:[],balance:null}); render();">+ Add allocation line</button>
      <div style="margin-top:12px;"><button class="btn" onclick="createSalesOrder()">Create Sales Order</button></div>
    </div>` : '';

  const filteredSOs = applyListFilters(soList, soFilters, ['so_no', 'customer_name']);

  return formHTML + `
    <div class="panel">
      <h2>All sales orders <span class="sub">${filteredSOs.length} of ${soList.length}</span></h2>
      ${filterBarHTML('soFilters', soFilters, customersCache, SO_STATUS_LABEL, 'SO no. or customer')}
      ${filteredSOs.length===0 ? `<div class="empty">No matches.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>SO No.</th><th>Customer</th><th>Total Value</th><th>Status</th><th></th></tr></thead>
        <tbody>${filteredSOs.map(s=>`<tr>
          <td>${s.so_no}</td><td>${s.customer_name}</td><td>${fmt(s.total_value)}</td>
          <td><span class="tag-pill ${SO_STATUS_CLASS[s.status]||'high'}">${SO_STATUS_LABEL[s.status]||s.status}</span></td>
          <td><span class="del" onclick="openSODetail(${s.id})">view</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <div class="panel" id="soDetailPanel" style="${selectedSOId?'':'display:none;'}"></div>
  `;
}

async function onSOAllocPOChange(rowIndex, poId){
  soAllocRows[rowIndex].customerPoId = poId;
  soAllocRows[rowIndex].customerPoItemId = '';
  soAllocRows[rowIndex].balance = null;
  if (poId) {
    const detail = await api(`/export/customer-pos/${poId}`);
    soAllocRows[rowIndex].poItems = detail.items;
  } else {
    soAllocRows[rowIndex].poItems = [];
  }
  await render();
}
async function onSOAllocItemChange(rowIndex, itemId){
  soAllocRows[rowIndex].customerPoItemId = itemId;
  if (itemId) soAllocRows[rowIndex].balance = await api(`/export/customer-po-items/${itemId}/allocation-balance`);
  else soAllocRows[rowIndex].balance = null;
  await render();
}
async function createSalesOrder(){
  const v = id => document.getElementById(id).value;
  const allocations = soAllocRows.filter(r=>r.customerPoId && r.customerPoItemId && r.allocatedQty).map(r=>({
    customerPoId:Number(r.customerPoId), customerPoItemId:Number(r.customerPoItemId), allocatedQty:Number(r.allocatedQty),
  }));
  try {
    await api('/export/sales-orders', { method:'POST', body: JSON.stringify({
      customerId:Number(v('so-customer')), etdPlanned:v('so-etd')||null, etaPlanned:v('so-eta')||null, allocations,
    }) });
    note('Sales Order created');
    soAllocRows = [];
    await render();
  } catch(e){ alert(e.message); }
}

// ---------------- SALES ORDER AMENDMENTS (Module 10) ----------------
let soAmendmentsCache = [];
let amendRows = [];
const AMEND_STATUS_CLASS = { pending:'high', approved:'ok', rejected:'high' };

let soTimelineCache = [];
async function openSODetail(id){
  selectedSOId = id;
  selectedSODetail = await api(`/export/sales-orders/${id}`);
  soAmendmentsCache = await api(`/export/sales-orders/${id}/amendments`);
  soTimelineCache = await api(`/export/timeline?salesOrderId=${id}`);
  if (amendRows.length===0) amendRows = [{ entityLevel:'header', salesOrderItemId:'', fieldName:'', newValue:'' }];
  renderSODetail();
}
function closeSODetail(){
  selectedSOId = null;
  amendRows = [];
  const panel = document.getElementById('soDetailPanel');
  if (panel) panel.style.display = 'none';
}
function renderSODetail(){
  const panel = document.getElementById('soDetailPanel');
  if (!panel) return;
  const s = selectedSODetail;
  const canManage = canManageSalesOrders();
  panel.style.display = '';
  panel.innerHTML = `
    <h2>${s.so_no} <span class="sub">${s.customer_name} · ${SO_STATUS_LABEL[s.status]||s.status} · ${fmt(s.total_value)}</span></h2>
    ${s.latestApprovalRun ? `<div class="hint">Latest approval run: #${s.latestApprovalRun.id} — ${s.latestApprovalRun.status}. Check the Approvals tab to act on it.</div>` : ''}
    ${s.creditSnapshot ? `<div class="hint">Credit check: exposure ${fmt(s.creditSnapshot.projected_exposure)} vs limit ${fmt(s.creditSnapshot.credit_limit)} ${s.creditSnapshot.exceeded?'<span class="tag-pill high">exceeded</span>':'<span class="tag-pill ok">within limit</span>'}</div>` : ''}
    <table><thead><tr><th>SKU</th><th>Ordered</th><th>Price</th><th>Manufactured?</th><th>Status</th><th>From PO(s)</th></tr></thead>
    <tbody>${s.items.map(it=>`<tr><td>${it.sku_code}</td><td>${fmt(it.ordered_qty)}</td><td>${fmt(it.unit_price)}</td><td>${it.requires_manufacturing?'Yes':'No — traded/repacked/outsourced'}</td>
      <td>${it.status}</td><td>${it.allocations.map(a=>`${a.po_no} (${fmt(a.allocated_qty)})`).join(', ')}</td></tr>`).join('')}</tbody></table>

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Timeline</h3>
    ${soTimelineCache.length===0 ? `<div class="empty">Nothing recorded yet.</div>` : `
    <div class="hint">${soTimelineCache.map(t=>`${new Date(t.event_at).toLocaleString()} — ${t.event_label}`).join('<br>')}</div>`}

    <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:16px 0 8px;">Amendments <span class="sub">${soAmendmentsCache.length} so far${soAmendmentsCache.length?` · displayed as ${s.so_no}/A${String(soAmendmentsCache.filter(a=>a.status==='approved').length).padStart(2,'0')}`:''}</span></h3>
    ${soAmendmentsCache.length===0 ? `<div class="empty">No amendments yet.</div>` : soAmendmentsCache.map(a=>`
      <div style="border-bottom:1px solid var(--line);padding:8px 0;">
        <strong>A${String(a.amendment_no).padStart(2,'0')}</strong> <span class="tag-pill ${AMEND_STATUS_CLASS[a.status]}">${a.status}</span> — ${a.reason}
        <div class="hint">${a.items.map(it=>`${it.entity_level}: ${it.field_name} ${it.old_value??'—'} → ${it.new_value}`).join(' · ')}</div>
      </div>`).join('')}

    ${canManage && !['cancelled','closed'].includes(s.status) ? `
      <div class="panel" style="background:var(--white);margin-top:10px;">
        <h3 style="font-family:'Oswald',sans-serif;font-size:13px;text-transform:uppercase;margin:0 0 8px;">Propose an amendment <span class="sub">one submission, several field changes, applied only once approved</span></h3>
        <div class="field"><label>Reason</label><input type="text" id="amend-reason" placeholder="required"></div>
        ${amendRows.map((r,i)=>`
          <div class="form-grid" style="margin:8px 0;">
            <div class="field"><label>Level</label><select onchange="onAmendLevelChange(${i}, this.value)">
              <option value="header" ${r.entityLevel==='header'?'selected':''}>Header</option>
              <option value="item" ${r.entityLevel==='item'?'selected':''}>Line item</option>
            </select></div>
            ${r.entityLevel==='item' ? `<div class="field"><label>Item</label><select onchange="amendRows[${i}].salesOrderItemId=this.value">
              <option value="">Select…</option>${s.items.map(it=>`<option value="${it.id}" ${r.salesOrderItemId==it.id?'selected':''}>${it.sku_code}</option>`).join('')}
            </select></div>` : ''}
            <div class="field"><label>Field</label><select onchange="amendRows[${i}].fieldName=this.value">
              <option value="">Select…</option>
              ${(r.entityLevel==='header' ? [['currencyId','Currency'],['incotermId','Incoterm'],['paymentTermsId','Payment Terms'],['etdPlanned','ETD'],['etaPlanned','ETA']] : [['unitPrice','Unit Price'],['orderedQty','Ordered Qty']]).map(([k,l])=>`<option value="${k}" ${r.fieldName===k?'selected':''}>${l}</option>`).join('')}
            </select></div>
            <div class="field"><label>New value</label><input type="text" value="${r.newValue}" onchange="amendRows[${i}].newValue=this.value" placeholder="new value / date / ID"></div>
          </div>`).join('')}
        <button class="btn secondary-btn small" onclick="amendRows.push({entityLevel:'header',salesOrderItemId:'',fieldName:'',newValue:''}); renderSODetail();">+ Add field change</button>
        <div style="margin-top:10px;"><button class="btn" onclick="submitAmendment(${s.id})">Submit amendment</button></div>
      </div>` : ''}

    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
      ${canManage && s.status==='draft' ? `<button class="btn" onclick="submitSOForApproval(${s.id})">Submit for Approval</button>` : ''}
      ${canManage && !['cancelled','closed'].includes(s.status) ? `<button class="btn secondary-btn small" onclick="cancelSO(${s.id})">Cancel Order</button>` : ''}
      <button class="btn secondary-btn" onclick="closeSODetail()">Close</button>
    </div>
  `;
}
function onAmendLevelChange(i, level){
  amendRows[i].entityLevel = level;
  amendRows[i].fieldName = '';
  amendRows[i].salesOrderItemId = '';
  renderSODetail();
}
async function submitAmendment(soId){
  const reason = document.getElementById('amend-reason').value.trim();
  if (!reason) { alert('A reason is required.'); return; }
  const items = amendRows.filter(r=>r.fieldName && r.newValue && (r.entityLevel==='header' || r.salesOrderItemId)).map(r=>({
    entityLevel: r.entityLevel, salesOrderItemId: r.salesOrderItemId?Number(r.salesOrderItemId):undefined,
    fieldName: r.fieldName, newValue: r.newValue,
  }));
  if (!items.length) { alert('Add at least one valid field change.'); return; }
  try {
    await api(`/export/sales-orders/${soId}/amendments`, { method:'POST', body: JSON.stringify({ reason, items }) });
    note('Amendment submitted for approval');
    amendRows = [];
    selectedSODetail = await api(`/export/sales-orders/${soId}`);
    soAmendmentsCache = await api(`/export/sales-orders/${soId}/amendments`);
    renderSODetail();
  } catch(e){ alert(e.message); }
}
async function submitSOForApproval(id){
  try { await api(`/export/sales-orders/${id}/submit-for-approval`, { method:'POST' }); note('Submitted for approval'); selectedSODetail = await api(`/export/sales-orders/${id}`); renderSODetail(); await render(); }
  catch(e){ alert(e.message); }
}
async function cancelSO(id){
  const reason = prompt('Reason for cancellation:');
  if (!reason) return;
  try { await api(`/export/sales-orders/${id}/cancel`, { method:'POST', body: JSON.stringify({ reason }) }); selectedSODetail = await api(`/export/sales-orders/${id}`); renderSODetail(); await render(); }
  catch(e){ alert(e.message); }
}

// ---------------- DOCUMENTS (Module 11) ----------------
let documentsCache = [];
let docsFilterType = '';
const DOC_RELATED_TYPES = { quotation:'Quotation', customer_po:'Customer PO', sales_order:'Sales Order', factory_order:'Factory Order', shipment:'Shipment', invoice:'Invoice', packing_list:'Packing List', other:'Other' };
const DOC_CATEGORIES = ['customer','sales','factory','purchase','qc','shipping','bank','government'];
const DOC_STATUS_LABEL = { draft:'Draft', under_review:'Under Review', approved:'Approved', released_to_customer:'Released to Customer', superseded:'Superseded', cancelled:'Cancelled' };
const DOC_STATUS_CLASS = { draft:'raw', under_review:'high', approved:'ok', released_to_customer:'oil', superseded:'raw', cancelled:'high' };

function canApproveDocuments(){ return isAdmin() || hasAnyRole('export_docs','management'); }
function canReleaseDocuments(){ return hasAnyRole('export_docs','management'); } // deliberately NOT admin — Owner Decision 9

async function documentsHTML(){
  const qs = docsFilterType ? `?relatedType=${docsFilterType}` : '';
  documentsCache = await api(`/export/documents${qs}`);

  return `
    <div class="panel">
      <h2>Upload a document</h2>
      <div class="form-grid">
        <div class="field"><label>Related to</label><select id="doc-relatedtype">${Object.entries(DOC_RELATED_TYPES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field"><label>Record ID</label><input type="number" id="doc-relatedid" placeholder="e.g. the Sales Order's ID"></div>
        <div class="field"><label>Category</label><select id="doc-category">${DOC_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('')}</select></div>
        <div class="field"><label>Document type</label><input type="text" id="doc-doctype" placeholder="e.g. customer_po_original"></div>
        <div class="field"><label>File</label><input type="file" id="doc-file"></div>
        <button class="btn" onclick="uploadDocumentFromForm()">Upload</button>
      </div>
      <div class="hint">Uploading again with the same "related to" + record ID + document type creates a new version and marks the old one superseded — the file is never overwritten.</div>
    </div>
    <div class="panel">
      <h2>All documents <span class="sub">${documentsCache.length}</span></h2>
      <div class="form-grid" style="margin-bottom:12px;">
        <div class="field"><label>Filter by related type</label><select onchange="docsFilterType=this.value; render();">
          <option value="">All</option>${Object.entries(DOC_RELATED_TYPES).map(([k,v])=>`<option value="${k}" ${docsFilterType===k?'selected':''}>${v}</option>`).join('')}
        </select></div>
      </div>
      ${documentsCache.length===0 ? `<div class="empty">No documents yet.</div>` : `
      <div class="table-scroll"><table>
        <thead><tr><th>Related</th><th>Category</th><th>Doc type</th><th>Ver.</th><th>File</th><th>Status</th><th></th></tr></thead>
        <tbody>${documentsCache.map(d=>`<tr>
          <td>${DOC_RELATED_TYPES[d.related_type]||d.related_type} #${d.related_id}</td><td>${d.category}</td><td>${d.doc_type}</td><td>${d.version_no}</td>
          <td><a href="/api/export/documents/${d.id}/file" target="_blank">${d.original_filename||'download'}</a></td>
          <td><span class="tag-pill ${DOC_STATUS_CLASS[d.status]||'raw'}">${DOC_STATUS_LABEL[d.status]||d.status}</span></td>
          <td>
            ${canApproveDocuments() && ['draft','under_review'].includes(d.status) ? `<span class="del" onclick="approveDocument(${d.id})">approve</span> ` : ''}
            ${canReleaseDocuments() && d.status==='approved' ? `<span class="del" onclick="releaseDocument(${d.id})">release</span> ` : ''}
            ${canApproveDocuments() && !['cancelled','superseded'].includes(d.status) ? `<span class="del" onclick="cancelDocument(${d.id})">cancel</span>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
  `;
}

async function uploadDocumentToServer(relatedType, relatedId, category, docType, file){
  const formData = new FormData();
  formData.append('file', file);
  formData.append('relatedType', relatedType);
  formData.append('relatedId', relatedId);
  formData.append('category', category);
  formData.append('docType', docType);
  const res = await fetch('/api/export/documents', { method:'POST', credentials:'same-origin', body: formData });
  const body = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(body.error || 'Upload failed.');
  return body;
}
async function uploadDocumentFromForm(){
  const v = id => document.getElementById(id).value;
  const fileInput = document.getElementById('doc-file');
  if (!fileInput.files.length) { alert('Choose a file first.'); return; }
  try {
    await uploadDocumentToServer(v('doc-relatedtype'), v('doc-relatedid'), v('doc-category'), v('doc-doctype').trim(), fileInput.files[0]);
    note('Document uploaded');
    await render();
  } catch(e){ alert(e.message); }
}
async function approveDocument(id){
  try { await api(`/export/documents/${id}/approve`, { method:'PATCH' }); await render(); } catch(e){ alert(e.message); }
}
async function releaseDocument(id){
  if (!confirm('Release this document to the customer? This should only be done once you are sure it is final.')) return;
  try { await api(`/export/documents/${id}/release`, { method:'PATCH' }); await render(); } catch(e){ alert(e.message); }
}
async function cancelDocument(id){
  try { await api(`/export/documents/${id}/cancel`, { method:'PATCH' }); await render(); } catch(e){ alert(e.message); }
}

// ---------------- NOTIFICATIONS (Module 12) ----------------
async function notificationsHTML(){
  const mine = await api('/export/notifications/mine');
  const rulesHTML = isAdmin() ? await (async () => {
    const rules = await api('/export/notification-rules');
    return `
    <div class="panel">
      <h2>Notification rules <span class="sub">which role gets notified for which event — in-app only for now</span></h2>
      <div class="table-scroll"><table><thead><tr><th>Event</th><th>Recipient role</th><th>Active</th></tr></thead>
      <tbody>${rules.map(r=>`<tr><td>${r.event_type}</td><td>${r.recipient_role}</td>
        <td><span class="del" onclick="toggleNotificationRule('${r.event_type}', ${!r.active})">${r.active?'active — disable':'inactive — enable'}</span></td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  })() : '';

  return rulesHTML + `
    <div class="panel">
      <h2>My notifications <span class="sub">${mine.filter(n=>!n.read_at).length} unread</span></h2>
      ${mine.length===0 ? `<div class="empty">Nothing yet.</div>` : `
      <div class="table-scroll"><table><thead><tr><th>Event</th><th>Details</th><th>When</th><th></th></tr></thead>
      <tbody>${mine.map(n=>`<tr style="${n.read_at?'opacity:0.55;':''}">
        <td>${n.event_type}</td><td>${JSON.stringify(n.payload)}</td><td>${new Date(n.created_at).toLocaleString()}</td>
        <td>${n.read_at?'read':`<span class="del" onclick="markNotificationRead(${n.id})">mark read</span>`}</td>
      </tr>`).join('')}</tbody></table></div>`}
    </div>
  `;
}
async function markNotificationRead(id){
  try { await api(`/export/notifications/${id}/read`, { method:'PATCH' }); await render(); } catch(e){ alert(e.message); }
}
async function toggleNotificationRule(eventType, active){
  try { await api(`/export/notification-rules/${eventType}`, { method:'PATCH', body: JSON.stringify({ active }) }); await render(); } catch(e){ alert(e.message); }
}

// ---------------- USERS (admin) ----------------
let allRolesCache = [];
let roleManagerUserId = null;
let roleManagerUserRoles = [];

async function usersHTML(){
  const usersCache = await api('/users');
  allRolesCache = await api('/roles');
  return `
    <div class="panel">
      <h2>Add an employee login</h2>
      <div class="form-grid">
        <div class="field"><label>Full name</label><input type="text" id="u-name"></div>
        <div class="field"><label>Username</label><input type="text" id="u-username" placeholder="lowercase, no spaces"></div>
        <div class="field"><label>Legacy role <span class="sub">drives Sourcing/Processing/etc.</span></label><select id="u-role"><option value="operator">Operator</option><option value="qc">QC</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></div>
        <div class="field"><label>Temporary PIN</label><input type="text" id="u-pin" placeholder="min 4 digits"></div>
        <button class="btn" onclick="addUser()">Create login</button>
      </div>
      <div class="hint">They sign in once with this PIN, then add their own fingerprint/Face ID passkey from the profile menu. Export-module roles (Management, Export Sales, Accounts, etc.) are added afterward via "Manage roles" below.</div>
    </div>
    <div class="panel">
      <h2>All users <span class="sub">${usersCache.length} accounts</span></h2>
      <div class="table-scroll"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Legacy Role</th><th>Passkeys</th><th>Status</th><th>Reset PIN</th><th>Deactivate</th><th>Export Roles</th></tr></thead>
        <tbody>${usersCache.map(u=>`
          <tr><td>${u.name}</td><td>${u.username}</td><td><span class="tag-pill ${u.role==='admin'?'admin':u.role==='operator'?'operator':'viewer'}">${u.role}</span></td>
          <td>${u.passkey_count}</td><td>${u.active?'Active':'Disabled'}</td>
          <td><span class="del" onclick="resetPin(${u.id})">reset</span></td>
          <td><span class="del" onclick="toggleActive(${u.id}, ${!u.active})">${u.active?'disable':'enable'}</span></td>
          <td><span class="del" onclick="openRoleManager(${u.id}, '${u.name.replace(/'/g,"\\'")}')">manage roles</span></td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="panel" id="roleManagerPanel" style="${roleManagerUserId ? '' : 'display:none;'}"></div>
    <div class="panel"><h2>Recent activity</h2><div id="auditLogBox" class="hint">loading…</div></div>`;
}
async function addUser(){
  const v = id => document.getElementById(id).value;
  try { await api('/users', { method:'POST', body: JSON.stringify({ name:v('u-name').trim(), username:v('u-username').trim(), role:v('u-role'), pin:v('u-pin').trim() }) }); note('User created'); await render(); }
  catch(e){ alert(e.message); }
}
async function resetPin(id){
  const pin = prompt('New temporary PIN (min 4 digits):'); if (!pin) return;
  try { await api(`/users/${id}/reset-pin`, { method:'POST', body: JSON.stringify({ pin }) }); alert('PIN reset.'); } catch(e){ alert(e.message); }
}
async function toggleActive(id, active){
  try { await api(`/users/${id}`, { method:'PATCH', body: JSON.stringify({ active }) }); await render(); } catch(e){ alert(e.message); }
}
async function openRoleManager(userId, userName){
  roleManagerUserId = userId;
  roleManagerUserRoles = await api(`/users/${userId}/roles`);
  renderRoleManagerPanel(userName);
}
function renderRoleManagerPanel(userName){
  const panel = document.getElementById('roleManagerPanel');
  if (!panel) return;
  const assignedCodes = roleManagerUserRoles.map(r=>r.code);
  panel.style.display = '';
  panel.innerHTML = `
    <h2>Export roles for ${userName} <span class="sub">a user can hold several at once</span></h2>
    <div class="form-grid">
      ${allRolesCache.map(r=>`
        <label style="display:flex;align-items:center;gap:8px;font-family:'IBM Plex Sans',sans-serif;font-size:13px;">
          <input type="checkbox" ${assignedCodes.includes(r.code)?'checked':''} onchange="toggleUserRole(${roleManagerUserId}, '${r.code}', this.checked, '${userName.replace(/'/g,"\\'")}')">
          ${r.name}
        </label>`).join('')}
    </div>
    <div style="margin-top:10px;"><button class="btn secondary-btn small" onclick="closeRoleManager()">Close</button></div>
  `;
}
async function toggleUserRole(userId, roleCode, checked, userName){
  try {
    if (checked) await api(`/users/${userId}/roles`, { method:'POST', body: JSON.stringify({ roleCode }) });
    else await api(`/users/${userId}/roles/${roleCode}`, { method:'DELETE' });
    roleManagerUserRoles = await api(`/users/${userId}/roles`);
    renderRoleManagerPanel(userName);
  } catch(e){ alert(e.message); }
}
function closeRoleManager(){
  roleManagerUserId = null;
  const panel = document.getElementById('roleManagerPanel');
  if (panel) panel.style.display = 'none';
}
async function loadAuditLog(){
  try { const rows = await api('/audit-log'); document.getElementById('auditLogBox').innerHTML = rows.slice(0,30).map(r=>`${new Date(r.created_at).toLocaleString()} — ${r.name||'system'} — ${r.action}`).join('<br>') || 'No activity yet.'; }
  catch(e){}
}

// ---------------- render dispatcher ----------------
async function render(){
  document.querySelectorAll('.station').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
  const content = document.getElementById('content');
  content.innerHTML = '<div class="panel">Loading…</div>';
  try {
    if (activeTab==='mytasks') content.innerHTML = await myTasksHTML();
    else if (activeTab==='overview') content.innerHTML = await overviewHTML();
    else if (activeTab==='sourcing') content.innerHTML = await sourcingHTML();
    else if (activeTab==='processing') content.innerHTML = await processingHTML();
    else if (activeTab==='uridpreproc') content.innerHTML = await uridPreProcHTML();
    else if (activeTab==='uriddhall') content.innerHTML = await uridDhallHTML();
    else if (activeTab==='quality') content.innerHTML = await qualityHTML();
    else if (activeTab==='packing') content.innerHTML = await packingHTML();
    else if (activeTab==='dispatch') content.innerHTML = await dispatchHTML();
    else if (activeTab==='trace') content.innerHTML = await traceHTML();
    else if (activeTab==='catalog' && isAdmin()) { content.innerHTML = await catalogHTML(); loadQPTable(); }
    else if (activeTab==='exportsetup' && isAdmin()) { content.innerHTML = await exportSetupHTML(); }
    else if (activeTab==='customers') { content.innerHTML = await customersHTML(); }
    else if (activeTab==='variants') { content.innerHTML = await variantsHTML(); }
    else if (activeTab==='pricing') { content.innerHTML = await pricingHTML(); }
    else if (activeTab==='approvals') { content.innerHTML = await approvalsHTML(); }
    else if (activeTab==='quotations') { content.innerHTML = await quotationsHTML(); }
    else if (activeTab==='customerpos') { content.innerHTML = await customerPOsHTML(); }
    else if (activeTab==='salesorders') { content.innerHTML = await salesOrdersHTML(); }
    else if (activeTab==='documents') { content.innerHTML = await documentsHTML(); }
    else if (activeTab==='notifications') { content.innerHTML = await notificationsHTML(); }
    else if (activeTab==='users' && isAdmin()) { content.innerHTML = await usersHTML(); loadAuditLog(); }
  } catch(e) {
    content.innerHTML = `<div class="panel">Could not load: ${e.message}</div>`;
  }
}

document.getElementById('stations').addEventListener('click', (e)=>{
  const btn = e.target.closest('.station');
  if (!btn || btn.classList.contains('hidden')) return;
  activeTab = btn.dataset.tab;
  render();
});

checkSession();
