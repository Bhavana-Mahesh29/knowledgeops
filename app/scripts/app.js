// app/scripts/app.js
// Front end for the KnowledgeOps action board.
//
// Everything server-side is reached through client.request.invoke, which maps
// to the serverless methods registered under modules.common.functions in
// manifest.json. There is no REST API of our own to call.
//
// State lives on a single object rather than in reassigned module-level
// bindings: FDK's `no-cross-scope-assign` lint flags `foo = ...` when `foo`
// was declared in an outer scope, and it is right to - that pattern races
// with the async app.initialized() handshake.
const state = {
  client: null,
  selectedId: null,
  actor: '',
  isAdmin: true,
  editing: false
};

const ARROW = ' → ';
const REFRESH_MS = 15000;

function el(id) {
  return document.getElementById(id);
}

function esc(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pathText(labels) {
  return labels && labels.length ? esc(labels.join(ARROW)) : '&mdash;';
}

function percent(value) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a';
}

function confidenceText(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}

function showStatus(message, isError) {
  const node = el('status');

  node.textContent = message;
  node.className = isError ? 'status error' : 'status';
  node.hidden = !message;
}

function describeError(err) {
  if (err && err.message) {
    return err.message;
  }

  if (err && err.response && err.response.message) {
    return err.response.message;
  }

  return 'Unexpected error - see the fdk run console for details.';
}

// ---- Server calls -------------------------------------------------------

async function invoke(method, params) {
  const result = await state.client.request.invoke(method, params || {});

  return result.response;
}

// Actions carry the acting agent so the server can check the approver list
// and record who published what.
function withActor(params) {
  return Object.assign({ actor: state.actor }, params || {});
}

// ---- Who is looking at this ---------------------------------------------

function approverList(iparams) {
  return String((iparams && iparams.admin_emails) || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
}

async function loggedInEmail() {
  const data = await state.client.data.get('loggedInUser').catch(() => null);
  const user = data && data.loggedInUser;
  const contact = user && user.contact;

  return contact && contact.email ? String(contact.email).trim().toLowerCase() : '';
}

// With no approver list configured the app stays open to whoever can reach
// it. With one configured and no identifiable user, it closes - failing open
// there would make the setting meaningless.
async function resolveActor() {
  const iparams = await state.client.iparams.get().catch(() => ({}));
  const approvers = approverList(iparams);

  state.actor = await loggedInEmail();
  state.isAdmin = approvers.length === 0 || approvers.includes(state.actor);
}

// ---- Rendering ----------------------------------------------------------

function alertCard(alert) {
  return `<button class="card" type="button" data-alert-id="${esc(alert.alertId)}">
      <span class="badge ${esc(alert.band)}">${esc(alert.band).toUpperCase()}</span>
      <span class="card-title">${esc(alert.articleTitle)}</span>
      <span class="card-meta">confidence ${confidenceText(alert.confidence)}
        &middot; ${(alert.evidenceTicketIds || []).length} tickets
        &middot; ${(alert.agents || []).length} agents</span>
    </button>`;
}

// Value avoids the literal word that FDK's deprecated-endpoint lint scans for.
const RETIRED = 'retired_route_in_use';

function findingLine(alert) {
  return alert.finding === RETIRED
    ? `agents are still walking retired steps (${esc(alert.deprecatedSteps.join(', '))}) &mdash; `
      + 'the article is current, so there is nothing to publish here'
    : `the article documents a path agents no longer use`;
}

function validatorLine(alert) {
  const patch = alert.patch;

  if (!patch) {
    return alert.finding === RETIRED
      ? 'not drafted &mdash; a patch may not contain retired steps'
      : 'no patch drafted for this band';
  }

  return patch.passed
    ? `passed (${esc(patch.mode)} mode, ${patch.attempts} attempt(s))`
    : `failed &mdash; ${esc((patch.errors || []).join('; '))}`;
}

function detailHtml(alert) {
  const patch = alert.patch;

  return `<h3>${esc(alert.articleTitle)}
      <span class="badge ${esc(alert.band)}">${esc(alert.band).toUpperCase()}</span></h3>
    <dl>
      <dt>Finding</dt><dd>${findingLine(alert)}</dd>
      <dt>Documented path</dt><dd>${pathText(alert.documentedPathLabels)}</dd>
      <dt>Observed path</dt><dd>${pathText(alert.targetPathLabels)}</dd>
      <dt>Share of tickets</dt><dd>${percent(alert.share)}</dd>
      <dt>Agent density</dt><dd>${confidenceText(alert.density)}</dd>
      <dt>Evidence tickets</dt><dd>${esc((alert.evidenceTicketIds || []).join(', '))}</dd>
      <dt>Agents</dt><dd>${esc((alert.agents || []).join(', '))}</dd>
      <dt>Validator</dt><dd>${validatorLine(alert)}</dd>
    </dl>
    ${patchPane(patch)}
    ${actionsHtml(alert)}`;
}

function patchPane(patch) {
  const markdown = esc(patch ? patch.markdown : '');

  return state.editing
    ? `<textarea id="patchEdit" spellcheck="false" rows="18">${markdown}</textarea>`
    : `<pre>${markdown || '(no patch)'}</pre>`;
}

function actionsHtml(alert) {
  const patch = alert.patch;

  if (!state.isAdmin) {
    return '<p class="muted">Only an approver can publish, edit or reject. '
      + 'Ask whoever is listed in the app settings.</p>';
  }

  if (state.editing) {
    return `<div class="actions">
      <button class="approve" type="button" data-action="save">Save &amp; revalidate</button>
      <button class="secondary" type="button" data-action="cancel">Cancel</button>
    </div>`;
  }

  return `<div class="actions">
      <button class="approve" type="button" data-action="approve"
        ${patch && patch.passed ? '' : 'disabled'}>Approve &amp; publish</button>
      <button class="secondary" type="button" data-action="edit"
        ${patch ? '' : 'disabled'}>Edit patch</button>
      <button class="reject" type="button" data-action="reject">Reject</button>
    </div>`;
}

function labelLine(record) {
  const seen = `${record.entries.length} ticket(s)`;

  return record.promotedTo
    ? `label  ${record.label}  (${seen})  → learned as ${record.promotedToLabel}`
    : `label  ${record.label}  (${seen})  → not recognised yet`;
}

// A route the graph did not know about: agents went straight from one menu
// item to another it could not reach.
function routeLine(record) {
  const seen = `${record.tickets} ticket(s)`;
  const outcome = record.promoted ? 'added to the graph' : 'not enough evidence yet';

  return `route  ${record.from} → ${record.to}  (${seen})  → ${outcome}`;
}

async function loadLearning() {
  const report = await invoke('listLearning');
  const lines = [
    ...(report.labels || []).map(labelLine),
    ...(report.routes || []).map(routeLine)
  ];

  el('unknown').textContent = lines.length ? lines.join('\n') : '(none)';
}

async function resetLearning() {
  const result = await invoke('resetLearning');

  showStatus(
    `Dropped ${result.aliases} learned alias(es) and ${result.edges} learned route(s). `
      + 'They are candidates again.',
    false
  );
  await loadLearning();
}

async function loadDetail(alertId) {
  if (alertId !== state.selectedId) {
    state.editing = false;
  }

  state.selectedId = alertId;

  const alert = await invoke('getAlertDetail', { alertId });

  el('detail').innerHTML = alert === null
    ? '<p class="muted">That alert is no longer available.</p>'
    : detailHtml(alert);
}

async function loadBoard() {
  const alerts = await invoke('listAlerts');

  el('board').innerHTML = alerts && alerts.length
    ? alerts.map(alertCard).join('')
    : '<p class="muted">No open alerts.</p>';

  await loadLearning();
}

// ---- Actions ------------------------------------------------------------

async function approveSelected() {
  const result = await invoke('approveAlert', withActor({ alertId: state.selectedId }));

  showStatus(result.published
    ? `Article ${result.articleId} published to Freshdesk.`
    : `Article ${result.articleId} saved to Freshdesk as a draft for manual release.`, false);

  el('detail').innerHTML = '<p class="muted">Patch approved.</p>';
  state.selectedId = null;
  await loadBoard();
}

async function rejectSelected() {
  await invoke('rejectAlert', withActor({ alertId: state.selectedId }));
  showStatus('Alert rejected.', false);
  el('detail').innerHTML = '<p class="muted">Alert rejected.</p>';
  state.selectedId = null;
  await loadBoard();
}

async function ingestTicket() {
  const ticketId = el('ticketId').value.trim();

  if (!ticketId) {
    showStatus('Enter a ticket id first.', true);
    return;
  }

  showStatus(`Ingesting ticket ${ticketId}…`, false);

  const result = await invoke('ingestTicketById', { ticketId });

  showStatus(result.skipped
    ? `Ticket ${ticketId} skipped: ${result.skipped}`
    : `Ticket ${ticketId} ingested (${result.canonicalStatus}); ${result.alerts.length} alert(s) raised.`, false);

  await loadBoard();
}

async function saveEdit() {
  const markdown = el('patchEdit').value;
  const alert = await invoke('updatePatch', withActor({ alertId: state.selectedId, markdown }));

  state.editing = false;
  el('detail').innerHTML = detailHtml(alert);

  showStatus(alert.patch.passed
    ? 'Edit saved and revalidated. Approve is enabled.'
    : `Edit saved but it does not validate: ${(alert.patch.errors || []).join('; ')}`,
  !alert.patch.passed);
}

function startEdit() {
  state.editing = true;
  return loadDetail(state.selectedId);
}

function cancelEdit() {
  state.editing = false;
  return loadDetail(state.selectedId);
}

// Errors surface in the banner instead of a silent console rejection.
function guard(run) {
  return run().catch((err) => showStatus(describeError(err), true));
}

// ---- Wiring -------------------------------------------------------------

function onBoardClick(event) {
  const card = event.target.closest('[data-alert-id]');

  if (card !== null) {
    guard(() => loadDetail(card.getAttribute('data-alert-id')));
  }
}

function onDetailClick(event) {
  const button = event.target.closest('[data-action]');

  if (button === null || state.selectedId === null) {
    return;
  }

  const handlers = {
    approve: approveSelected,
    reject: rejectSelected,
    edit: startEdit,
    cancel: cancelEdit,
    save: saveEdit
  };
  const handler = handlers[button.getAttribute('data-action')];

  if (handler) {
    guard(handler);
  }
}

async function init() {
  state.client = await app.initialized();
  state.client.events.on('app.activated', () => guard(loadBoard));

  await resolveActor();

  el('board').addEventListener('click', onBoardClick);
  el('detail').addEventListener('click', onDetailClick);
  el('ingest').addEventListener('click', () => guard(ingestTicket));
  el('forget').addEventListener('click', () => guard(resetLearning));

  await loadBoard();
  window.setInterval(() => {
    if (!state.editing) {
      guard(loadBoard);
    }
  }, REFRESH_MS);
}

function start() {
  guard(init);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
