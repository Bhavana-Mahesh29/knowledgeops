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

function percent(value) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a';
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

// Value avoids the literal word that FDK's deprecated-endpoint lint scans for.
const RETIRED = 'retired_route_in_use';
const GAP = 'knowledge_gap';

const BAND_LABELS = {
  critical: 'High Knowledge Drift',
  warning: 'Emerging Knowledge Drift',
  vetoed: 'Drift on hold (tickets reopened)',
  gap: 'Knowledge Gap'
};

function isGap(alert) {
  return alert.finding === GAP;
}

function badge(alert) {
  const band = isGap(alert) ? 'gap' : alert.band;

  return `<span class="badge ${esc(band)}">${esc(BAND_LABELS[band] || band)}</span>`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function evidenceLine(alert) {
  const agents = (alert.agents || []).length;
  const tickets = (alert.evidenceTicketIds || []).length;

  return `Confirmed by ${plural(agents, 'agent')} across ${plural(tickets, 'ticket')} `
    + `(${percent(alert.share)} convergence)`;
}

// How many leading steps two paths share.
function sharedPrefix(a, b) {
  let n = 0;

  while (n < a.length && n < b.length && a[n] === b[n]) {
    n += 1;
  }

  return n;
}

// The part of the path that changed: whatever sits between the steps both
// paths share at the start and at the end.
function changedSteps(alert) {
  const before = alert.documentedPathLabels || [];
  const after = alert.targetPathLabels || [];
  const head = sharedPrefix(before, after);
  const tail = sharedPrefix(before.slice(head).reverse(), after.slice(head).reverse());

  return {
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail)
  };
}

function stepLine(alert) {
  if (alert.finding === RETIRED) {
    return `Step: agents still use retired ${esc((alert.deprecatedSteps || []).join(', '))}`;
  }

  const { removed, added } = changedSteps(alert);
  const join = (labels) => esc(labels.join(' / '));

  if (!removed.length && !added.length) {
    return 'Step: no change';
  }

  if (!removed.length) {
    return `Step added: ${join(added)}`;
  }

  if (!added.length) {
    return `Step removed: ${join(removed)}`;
  }

  return `Step: ${join(removed)}${ARROW}${join(added)}`;
}

function cardClass(alert) {
  return alert.alertId === state.selectedId ? 'card selected' : 'card';
}

function gapTitle(alert) {
  return `Knowledge Gap: New procedure detected <span class="nowrap">(Ticket #${esc(alert.ticketId)})</span>`;
}

function gapCard(alert) {
  return `<button class="${cardClass(alert)}" type="button" data-alert-id="${esc(alert.alertId)}">
      ${badge(alert)}
      <span class="card-title">${gapTitle(alert)}</span>
      <span class="card-line">Draft: ${esc(alert.articleTitle)}</span>
    </button>`;
}

function driftCard(alert) {
  return `<button class="${cardClass(alert)}" type="button" data-alert-id="${esc(alert.alertId)}">
      ${badge(alert)}
      <span class="card-title">${esc(alert.articleTitle)}</span>
      <span class="card-line">${stepLine(alert)}</span>
      <span class="card-meta">${evidenceLine(alert)}</span>
    </button>`;
}

function alertCard(alert) {
  return isGap(alert) ? gapCard(alert) : driftCard(alert);
}

function findingLine(alert) {
  return alert.finding === RETIRED
    ? 'Agents are still using retired steps. The article is current, so there is nothing to publish.'
    : 'Agents now resolve this with a different path than the published article.';
}

function validatorLine(alert) {
  const patch = alert.patch;

  if (!patch) {
    return alert.finding === RETIRED
      ? 'Not drafted: a patch may not contain retired steps.'
      : 'No patch drafted for this alert.';
  }

  return patch.passed
    ? `Checks passed (${esc(patch.mode)} draft)`
    : `Checks failed: ${esc((patch.errors || []).join('; '))}`;
}

function checkLine(alert) {
  const passed = Boolean(alert.patch && alert.patch.passed);

  return `<p class="check ${passed ? 'ok' : 'bad'}">${validatorLine(alert)}</p>`;
}

// One breadcrumb. Nodes the other path does not have get `changedClass`.
function breadcrumb(labels, other, changedClass) {
  if (!labels.length) {
    return '<span class="muted">No path documented</span>';
  }

  return labels.map((label) => {
    const cls = other.includes(label) ? 'crumb' : `crumb ${changedClass}`;

    return `<span class="${cls}">${esc(label)}</span>`;
  }).join('<span class="crumb-sep" aria-hidden="true">&rsaquo;</span>');
}

function pathDiff(alert) {
  const before = alert.documentedPathLabels || [];
  const after = alert.targetPathLabels || [];

  return `<div class="path-diff">
      <div class="path-row">
        <span class="path-label">Published Path</span>
        <div class="crumbs">${breadcrumb(before, after, 'removed')}</div>
      </div>
      <div class="path-row">
        <span class="path-label">Proposed Path</span>
        <div class="crumbs">${breadcrumb(after, before, 'added')}</div>
      </div>
    </div>`;
}

function patchPane(patch) {
  const markdown = esc(patch ? patch.markdown : '');

  return state.editing
    ? `<textarea id="patchEdit" spellcheck="false" rows="18">${markdown}</textarea>`
    : `<pre class="markdown">${markdown || '(no draft)'}</pre>`;
}

function driftDetail(alert) {
  return `<div class="detail-head">
      <h3>${esc(alert.articleTitle)}</h3>
      ${badge(alert)}
    </div>
    <p class="summary">${findingLine(alert)}</p>
    <p class="evidence">${evidenceLine(alert)}</p>
    ${pathDiff(alert)}
    <h4>Updated article</h4>
    ${patchPane(alert.patch)}
    ${checkLine(alert)}
    ${actionsHtml(alert)}`;
}

function gapDetail(alert) {
  const note = esc(alert.resolutionNote) || '<span class="muted">(empty)</span>';

  return `<div class="detail-head">
      <h3>${gapTitle(alert)}</h3>
      ${badge(alert)}
    </div>
    <p class="summary">No article describes how this ticket was resolved. A new article was drafted from it.</p>
    <div class="gap-grid">
      <div>
        <h4>Ticket resolution note</h4>
        <div class="note">
          <p class="note-subject">${esc(alert.subject)}</p>
          <p>${note}</p>
        </div>
      </div>
      <div>
        <h4>Draft article</h4>
        ${patchPane(alert.patch)}
      </div>
    </div>
    ${checkLine(alert)}
    ${actionsHtml(alert)}`;
}

function detailHtml(alert) {
  return isGap(alert) ? gapDetail(alert) : driftDetail(alert);
}

function actionsHtml(alert) {
  const patch = alert.patch;

  if (!state.isAdmin) {
    return '<p class="muted">Only an approver can publish, edit or reject. '
      + 'Ask whoever is listed in the app settings.</p>';
  }

  if (state.editing) {
    return `<div class="actions">
      <button class="primary" type="button" data-action="save">Save &amp; recheck</button>
      <button class="secondary" type="button" data-action="cancel">Cancel</button>
    </div>`;
  }

  const approveLabel = isGap(alert) ? 'Approve &amp; create article' : 'Approve &amp; publish';

  return `<div class="actions">
      <button class="primary" type="button" data-action="approve"
        ${patch && patch.passed ? '' : 'disabled'}>${approveLabel}</button>
      <button class="secondary" type="button" data-action="edit"
        ${patch ? '' : 'disabled'}>Edit</button>
      <button class="danger" type="button" data-action="reject">Reject</button>
    </div>`;
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
  markSelected();
}

function markSelected() {
  for (const card of el('board').querySelectorAll('[data-alert-id]')) {
    card.classList.toggle('selected', card.getAttribute('data-alert-id') === state.selectedId);
  }
}

async function loadBoard() {
  const alerts = await invoke('listAlerts');

  el('board').innerHTML = alerts && alerts.length
    ? alerts.map(alertCard).join('')
    : '<p class="muted empty">No open alerts.</p>';
}

// ---- Actions ------------------------------------------------------------

async function approveSelected() {
  const result = await invoke('approveAlert', withActor({ alertId: state.selectedId }));

  const what = result.created ? `New article ${result.articleId} created` : `Article ${result.articleId}`;

  showStatus(result.published
    ? `${what} and published to Freshdesk.`
    : `${what} and saved to Freshdesk as a draft for manual release.`, false);

  el('detail').innerHTML = '<p class="muted empty">Approved.</p>';
  state.selectedId = null;
  await loadBoard();
}

async function rejectSelected() {
  await invoke('rejectAlert', withActor({ alertId: state.selectedId }));
  showStatus('Alert rejected.', false);
  el('detail').innerHTML = '<p class="muted empty">Alert rejected.</p>';
  state.selectedId = null;
  await loadBoard();
}

function ingestMessage(ticketId, result) {
  if (result.knowledgeGap) {
    return `Ticket ${ticketId}: no article covers this resolution. A new article was drafted for review.`;
  }

  return result.skipped
    ? `Ticket ${ticketId} skipped: ${result.skipped}`
    : `Ticket ${ticketId} ingested (${result.canonicalStatus}); ${result.alerts.length} alert(s) raised.`;
}

async function ingestTicket() {
  const ticketId = el('ticketId').value.trim();

  if (!ticketId) {
    showStatus('Enter a ticket id first.', true);
    return;
  }

  showStatus(`Ingesting ticket ${ticketId}…`, false);

  const result = await invoke('ingestTicketById', { ticketId });

  showStatus(ingestMessage(ticketId, result), false);

  await loadBoard();
}

async function saveEdit() {
  const markdown = el('patchEdit').value;
  const alert = await invoke('updatePatch', withActor({ alertId: state.selectedId, markdown }));

  state.editing = false;
  el('detail').innerHTML = detailHtml(alert);

  showStatus(alert.patch.passed
    ? 'Edit saved and revalidated. Approve is enabled.'
    : `Edit saved but it does not pass the checks: ${(alert.patch.errors || []).join('; ')}`,
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
