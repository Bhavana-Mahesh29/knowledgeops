// server/lib/store.js
// Thin wrapper over the FDK key-value store ($db).
//
// $db keys are capped at 60 characters and a key+value pair at 40KB, so every
// key built here is prefixed, stringified and length-clamped before use.
'use strict';

const MAX_KEY_LEN = 60;
const INDEX = 'index';

function storeKey(collection, key) {
  return `${collection}:${String(key)}`.slice(0, MAX_KEY_LEN);
}

// ---- Storage helpers ---------------------------------------------------

async function dbGet(collection, key) {
  try {
    const row = await $db.get(storeKey(collection, key));

    return row && row.value ? JSON.parse(row.value) : null;
  } catch (err) {
    void err;
    // $db.get rejects with a 404-shaped payload when the key is absent; an
    // absent record is a normal outcome here, not a failure.
    return null;
  }
}

function dbSet(collection, key, value) {
  return $db.set(storeKey(collection, key), { value: JSON.stringify(value) });
}

async function dbList(collection) {
  const idx = (await dbGet(INDEX, collection)) || [];
  const items = [];

  for (const key of idx) {
    const v = await dbGet(collection, key);

    if (v) {
      items.push(v);
    }
  }

  return items;
}

async function dbAppendIndex(collection, key) {
  const idx = (await dbGet(INDEX, collection)) || [];

  if (!idx.includes(String(key))) {
    idx.push(String(key));
    await dbSet(INDEX, collection, idx);
  }
}

// ---- Articles ----------------------------------------------------------

async function saveArticle(articleId, article) {
  await dbSet('articles', articleId, article);
  await dbAppendIndex('articles', articleId);
}

function getArticle(articleId) {
  return dbGet('articles', articleId);
}

// ---- Tickets -----------------------------------------------------------

async function saveTicket(ticketId, ticket) {
  await dbSet('tickets', ticketId, ticket);
  await dbAppendIndex('tickets', ticketId);
}

function getTicket(ticketId) {
  return dbGet('tickets', ticketId);
}

async function getTicketsForArticle(articleId) {
  const all = await dbList('tickets');

  return all.filter((t) => String(t.articleId) === String(articleId));
}

// ---- Alerts ------------------------------------------------------------

async function saveAlert(alertId, alert) {
  await dbSet('alerts', alertId, alert);
  await dbAppendIndex('alerts', alertId);
}

function getAlert(alertId) {
  return dbGet('alerts', alertId);
}

async function listOpenAlerts() {
  const all = await dbList('alerts');

  return all.filter((a) => a.state === 'open');
}

// Called before a rescore writes fresh alerts, so the board never shows two
// generations of alerts for the same article.
async function clearOpenAlertsForArticle(articleId) {
  const all = await dbList('alerts');

  for (const a of all) {
    if (String(a.articleId) === String(articleId) && a.state === 'open') {
      a.state = 'superseded';
      await dbSet('alerts', a.alertId, a);
    }
  }
}

// ---- Unknown labels (Taxonomy Mutation Warning - lite) -----------------

// Sightings are deduplicated by ticket: re-simulating the same event must not
// inflate a label towards the promotion threshold.
async function saveUnknownLabel(label, ticketId, agentId) {
  const existing = (await dbGet('unknown_labels', label)) || { label, entries: [], promotedTo: null };
  const seen = existing.entries.some((e) => e.ticketId === String(ticketId));

  if (!seen) {
    existing.entries.push({ ticketId: String(ticketId), agentId: String(agentId) });
  }

  await dbSet('unknown_labels', label, existing);
  await dbAppendIndex('unknown_labels', label);
}

function listUnknownLabels() {
  return dbList('unknown_labels');
}

async function markUnknownLabelPromoted(label, nodeId, nodeLabel) {
  const existing = await dbGet('unknown_labels', label);

  if (existing !== null) {
    existing.promotedTo = nodeId;
    existing.promotedToLabel = nodeLabel;
    await dbSet('unknown_labels', label, existing);
  }
}

// ---- Candidate parent edges --------------------------------------------
//
// Recorded when an agent went straight from one menu node to another that the
// graph says is not reachable from it. Enough of those and the graph gains
// the edge.

function edgeKey(from, to) {
  return `${from}>${to}`;
}

async function saveEdgeCandidate(from, to, ticketId, agentId) {
  const key = edgeKey(from, to);
  const existing = (await dbGet('edges', key)) || { from, to, entries: [], promoted: false };

  if (!existing.entries.some((e) => e.ticketId === String(ticketId))) {
    existing.entries.push({ ticketId: String(ticketId), agentId: String(agentId) });
  }

  await dbSet('edges', key, existing);
  await dbAppendIndex('edges', key);
}

function listEdgeCandidates() {
  return dbList('edges');
}

async function markEdgePromoted(from, to) {
  const key = edgeKey(from, to);
  const existing = await dbGet('edges', key);

  if (existing !== null) {
    existing.promoted = true;
    await dbSet('edges', key, existing);
  }
}

// ---- The learned overlay -----------------------------------------------
//
// server/lib/taxonomy.js ships inside the app bundle and cannot be written to
// at runtime, so everything the app works out for itself lives here: extra
// aliases as { normalisedLabel: nodeId }, and extra parent edges as
// { childNodeId: [parentNodeId, ...] }. Both are layered over the static
// graph on every lookup.

async function getLearned() {
  return {
    aliases: (await dbGet('learned', 'aliases')) || {},
    edges: (await dbGet('learned', 'edges')) || {}
  };
}

async function saveLearnedAlias(normalisedLabel, nodeId) {
  const all = (await dbGet('learned', 'aliases')) || {};

  all[normalisedLabel] = nodeId;
  await dbSet('learned', 'aliases', all);
}

async function saveLearnedEdge(childId, parentId) {
  const all = (await dbGet('learned', 'edges')) || {};
  const parents = all[childId] || [];

  if (!parents.includes(parentId)) {
    parents.push(parentId);
  }

  all[childId] = parents;
  await dbSet('learned', 'edges', all);
}

async function clearPromotionMarks(collection, reset) {
  for (const record of await dbList(collection)) {
    await dbSet(collection, reset(record), record);
  }
}

// The only undo for automatic promotion, so it has to put the candidates back
// rather than just dropping the overlay.
async function resetLearning() {
  const { aliases, edges } = await getLearned();
  const counts = {
    aliases: Object.keys(aliases).length,
    edges: Object.values(edges).reduce((n, parents) => n + parents.length, 0)
  };

  await dbSet('learned', 'aliases', {});
  await dbSet('learned', 'edges', {});

  await clearPromotionMarks('unknown_labels', (r) => {
    r.promotedTo = null;
    r.promotedToLabel = null;
    return r.label;
  });

  await clearPromotionMarks('edges', (r) => {
    r.promoted = false;
    return edgeKey(r.from, r.to);
  });

  return counts;
}

const api = {
  saveArticle,
  getArticle,
  saveTicket,
  getTicket,
  getTicketsForArticle,
  saveAlert,
  getAlert,
  listOpenAlerts,
  clearOpenAlertsForArticle,
  saveUnknownLabel,
  listUnknownLabels,
  markUnknownLabelPromoted,
  saveEdgeCandidate,
  listEdgeCandidates,
  markEdgePromoted,
  getLearned,
  saveLearnedAlias,
  saveLearnedEdge,
  resetLearning
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
