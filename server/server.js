// server/server.js
// KnowledgeOps server-side logic for Freshworks FDK.
//
// Pipeline: onTicketUpdate -> redact -> extract steps -> canonicalise ->
// cluster + score -> draft a patch -> (agent approves) -> publish to Freshdesk.
//
// NOTE on exports: the FDK serverless sandbox provides `exports` as a bare
// global and does NOT define `module`, which is why every file under
// server/lib assigns `exports` and only touches `module.exports` behind a
// `typeof module` guard.
'use strict';

const tax = require('./lib/taxonomy');
const { toCanonicalPath, missingEdges } = require('./lib/canonical');
const { scoreCluster, shareOf, densityOf, DEFAULT_CFG } = require('./lib/scoring');
const { redact } = require('./lib/redact');
const { extractSteps } = require('./lib/extractor');
const { draftAndValidate } = require('./lib/architect');
const { validatePatch } = require('./lib/validator');
const md = require('./lib/markdown');
const store = require('./lib/store');

// Updated regex to support /support/solutions/articles/, /a/solutions/articles/, and relative article URLs
const ARTICLE_LINK_RE = /(?:a\/|support\/)?solutions\/articles\/(\d+)/i;
const ARROW = '\u2192';

// Freshdesk ticket statuses that mean "the agent considers this answered".
const RESOLVED_STATUSES = [4, 5];
// Freshdesk solution-article statuses.
const ARTICLE_DRAFT = 1;
const ARTICLE_PUBLISHED = 2;

const STALE_BANDS = ['warning', 'critical'];
const EVIDENCE_REPLIES = 3;
const MAX_ERROR_CHARS = 300;

// Demo mode relaxes the convergence gates so a single simulated ticket is
// enough to raise an alert. Production keeps the real thresholds.
const DEMO_CFG = Object.assign({}, DEFAULT_CFG, {
  N: 1,
  K: 1,
  X: 0,
  AGENT_DENSITY_TARGET: 1
});

function scoringCfg(iparams) {
  return iparams.demo_mode === true ? DEMO_CFG : DEFAULT_CFG;
}

// $request rejections are plain `{ status, response }` objects rather than
// Errors, so a plain `err.message` is not enough to describe what went wrong.
function errorText(err) {
  if (err === null || err === undefined) {
    return 'unknown error';
  }
  if (err.message) {
    return String(err.message);
  }
  if (err.response) {
    return `HTTP ${err.status}: ${String(err.response).slice(0, MAX_ERROR_CHARS)}`;
  }
  return JSON.stringify(err).slice(0, MAX_ERROR_CHARS);
}

// ---------- Freshdesk fetch helpers ---------------------------------------

async function fdGetTicket(ticketId) {
  const r = await $request.invokeTemplate('fdGetTicket', {
    context: { ticket_id: String(ticketId) }
  });

  return JSON.parse(r.response);
}

async function fdGetConversations(ticketId) {
  const r = await $request.invokeTemplate('fdGetConversations', {
    context: { ticket_id: String(ticketId) }
  });

  return JSON.parse(r.response);
}

async function fdGetArticle(articleId) {
  const r = await $request.invokeTemplate('fdGetArticle', {
    context: { article_id: String(articleId) }
  });

  return JSON.parse(r.response);
}

function fdUpdateArticle(articleId, html, status) {
  return $request.invokeTemplate('fdUpdateArticle', {
    context: { article_id: String(articleId) },
    body: JSON.stringify({ description: html, status })
  });
}

// ---------- Article baseline ---------------------------------------------

// The store holds the article as markdown plus the path it currently
// documents. Without this, rescoring has nothing to compare a cluster against
// and silently does nothing.
//
// This re-reads Freshdesk on every ingest rather than caching on first sight.
// Caching meant an edit to the article had no effect until the datastore was
// wiped, which is indistinguishable from the app being broken. One extra GET
// per ticket is worth not having that failure mode.
async function syncArticle(articleId) {
  const remote = await fdGetArticle(articleId);
  const markdown = md.normaliseArticleMarkdown(
    md.htmlToMarkdown(remote.description),
    remote.title
  );

  const article = {
    articleId: String(articleId),
    title: remote.title || `Article ${articleId}`,
    markdown,
    documentedPath: md.documentedPathOf(markdown),
    baselineReopenRate: 0.0
  };

  await store.saveArticle(articleId, article);

  return article;
}

// An article whose Steps section has no bold menu items documents no path at
// all, so every observed path trivially "differs" from it. That is a content
// problem in Freshdesk, not a detection, and it needs saying out loud.
function articleWarning(article) {
  return article.documentedPath.length
    ? null
    : `article ${article.articleId} documents no navigation path - put the menu steps in **bold** under a "Steps" heading`;
}

// ---------- Ingest --------------------------------------------------------

function isPublicAgentReply(c) {
  return !c.incoming && !c.private;
}

function findArticleId(replies) {
  let articleId = null;

  for (const c of replies) {
    const m = ARTICLE_LINK_RE.exec(c.body || '');

    if (m !== null) {
      articleId = m[1];
    }
  }

  return articleId;
}

function recentReplyText(replies) {
  return replies
    .slice(-EVIDENCE_REPLIES)
    .map((c) => c.body_text || '')
    .join('\n\n');
}

async function recordUnknownLabels(labels, ticket) {
  for (const label of labels) {
    await store.saveUnknownLabel(label, ticket.id, ticket.responder_id);
  }
}

// ---------- Graph learning ------------------------------------------------
//
// The navigation graph grows from resolved tickets in two ways, both behind
// the same convergence gate that guards alerts: seen N times, by K different
// agents. Nothing here is reviewed by a human before it takes effect, so both
// promotions are deliberately refusable - an ambiguous match or an edge that
// would close a loop is declined rather than guessed at - and both are
// reversible from the board.

// A label earns an alias when tax.bestNodeFor finds exactly one node it could
// be a rewording of.
function aliasTarget(record, learned, cfg) {
  const entries = record.entries || [];
  const known = learned.aliases[tax.normalise(record.label)];

  // An alias pointing at a node that no longer exists (the taxonomy was
  // edited under it) counts as not learned, so it gets re-resolved against
  // the current graph and the dead entry is overwritten.
  if (known && tax.node(known) !== null) {
    return null;
  }

  if (entries.length < cfg.N || new Set(entries.map((e) => e.agentId)).size < cfg.K) {
    return null;
  }

  return tax.bestNodeFor(record.label);
}

async function promoteAliases(cfg, learned) {
  const promoted = [];

  for (const record of await store.listUnknownLabels()) {
    const target = aliasTarget(record, learned, cfg);

    if (target !== null) {
      const nodeLabel = tax.displayLabel(target.nodeId);

      await store.saveLearnedAlias(tax.normalise(record.label), target.nodeId);
      await store.markUnknownLabelPromoted(record.label, target.nodeId, nodeLabel);
      promoted.push({ label: record.label, node: nodeLabel });
    }
  }

  return promoted;
}

// Already reachable one way or the other: adding the edge would be a no-op,
// or it would close a loop and make the lineage walk meaningless.
function edgeRedundant(record, edges) {
  return tax.hasAncestor(record.to, record.from, edges)
    || tax.hasAncestor(record.from, record.to, edges);
}

function edgeAccepted(record, learned, cfg) {
  const entries = record.entries || [];

  if (tax.node(record.from) === null || tax.node(record.to) === null) {
    return false;
  }

  if (entries.length < cfg.N || new Set(entries.map((e) => e.agentId)).size < cfg.K) {
    return false;
  }

  return !edgeRedundant(record, learned.edges);
}

// An agent walking straight from one menu node to another the graph cannot
// join up is evidence of a route the graph does not know about yet. This is
// what fixes 'inconsistent' - an alias cannot, because the labels involved
// already resolved.
async function recordEdgeCandidates(canon, learned, ticket) {
  if (canon.status !== 'inconsistent') {
    return;
  }

  for (const gap of missingEdges(canon.mapped_nodes, learned.edges)) {
    await store.saveEdgeCandidate(gap.from, gap.to, ticket.id, ticket.responder_id);
  }
}

async function promoteEdges(cfg, learned) {
  const promoted = [];

  for (const record of await store.listEdgeCandidates()) {
    if (edgeAccepted(record, learned, cfg)) {
      await store.saveLearnedEdge(record.to, record.from);
      await store.markEdgePromoted(record.from, record.to);
      promoted.push({
        parent: tax.displayLabel(record.from),
        child: tax.displayLabel(record.to)
      });
    }
  }

  return promoted;
}

// Canonicalise, feed whatever did not resolve back into the learning pass,
// and canonicalise again if the graph grew. Aliases are settled before edge
// candidates are recorded, so the gap that gets voted on is between the two
// real nodes either side of it rather than whatever happened to resolve on
// the first pass.
async function resolveSteps(steps, ticket, cfg) {
  let learned = await store.getLearned();
  let canon = toCanonicalPath(steps, learned);

  await recordUnknownLabels(canon.unknown_labels, ticket);

  const aliases = await promoteAliases(cfg, learned);

  if (aliases.length) {
    learned = await store.getLearned();
    canon = toCanonicalPath(steps, learned);
  }

  await recordEdgeCandidates(canon, learned, ticket);

  const edges = await promoteEdges(cfg, learned);

  if (edges.length) {
    learned = await store.getLearned();
    canon = toCanonicalPath(steps, learned);
  }

  return { canon, learned, promoted: { aliases, edges } };
}

// Learning is retroactive: tickets already on file are re-canonicalised
// against the grown graph, so evidence banked before the taxonomy caught up
// still counts. This is why the raw extracted labels are stored per ticket.
async function relearnTickets(articleId, learned) {
  for (const t of await store.getTicketsForArticle(articleId)) {
    const canon = toCanonicalPath(t.stepsRaw || [], learned);
    const changed = canon.status !== t.status
      || JSON.stringify(canon.canonical_path) !== JSON.stringify(t.canonicalPath);

    if (changed) {
      await store.saveTicket(t.ticketId, Object.assign(t, {
        status: canon.status,
        canonicalPath: canon.canonical_path,
        partial: canon.partial
      }));
    }
  }
}

// ---------- Ingest --------------------------------------------------------

async function ingestTicket(ticket, cfg) {
  if (!RESOLVED_STATUSES.includes(Number(ticket.status))) {
    return { ticketId: ticket.id, skipped: 'ticket is not resolved or closed' };
  }

  const replies = (await fdGetConversations(ticket.id)).filter(isPublicAgentReply);
  const articleId = findArticleId(replies);

  if (articleId === null) {
    return { ticketId: ticket.id, skipped: 'no solution-article link in the public replies' };
  }

  const article = await syncArticle(articleId);
  const { redactedText } = redact(recentReplyText(replies));
  const steps = await extractSteps(redactedText);

  // Anything this ticket teaches the graph applies to this ticket too, and
  // to every ticket already on file for the article.
  const { canon, learned, promoted } = await resolveSteps(steps, ticket, cfg);

  await relearnTickets(articleId, learned);

  await store.saveTicket(ticket.id, {
    ticketId: String(ticket.id),
    articleId: String(articleId),
    linkType: 'explicit',
    agentId: String(ticket.responder_id),
    reopened: false,
    redactedText,
    stepsRaw: steps,
    canonicalPath: canon.canonical_path,
    status: canon.status,
    partial: canon.partial
  });

  return {
    ticketId: ticket.id,
    articleId: String(articleId),
    canonicalStatus: canon.status,
    canonicalPath: tax.displayPath(canon.canonical_path),
    documentedPath: tax.displayPath(article.documentedPath),
    unknownLabels: canon.unknown_labels,
    learnedAliases: promoted.aliases,
    learnedRoutes: promoted.edges,
    warning: articleWarning(article),
    alerts: await rescoreArticle(article, cfg)
  };
}

// A ticket that left resolved/closed after we ingested it is a reopen, which
// is the signal the veto gate in scoring.js keys off.
async function markReopened(ticket, cfg) {
  const stored = await store.getTicket(ticket.id);

  if (stored === null) {
    return { ticketId: ticket.id, skipped: 'ticket is not resolved or closed' };
  }

  if (stored.reopened === true) {
    return { ticketId: ticket.id, skipped: 'already counted as reopened' };
  }

  stored.reopened = true;
  await store.saveTicket(ticket.id, stored);

  const article = await store.getArticle(stored.articleId);

  return {
    ticketId: ticket.id,
    articleId: stored.articleId,
    reopened: true,
    alerts: article === null ? [] : await rescoreArticle(article, cfg)
  };
}

function handleTicketUpdate(payload) {
  const ticket = (payload.data && payload.data.ticket) || {};
  const cfg = scoringCfg(payload.iparams || {});

  if (!ticket.id) {
    return Promise.resolve({ skipped: 'event payload carried no ticket' });
  }

  if (!RESOLVED_STATUSES.includes(Number(ticket.status))) {
    return markReopened(ticket, cfg);
  }

  return ingestTicket(ticket, cfg);
}

// ---------- Rescoring -----------------------------------------------------

// Groups the article's ingested tickets by the canonical path their agent
// actually walked, dropping the ones that match what the article already
// documents. Only 'ok' tickets count - an unknown or self-contradictory path
// is not evidence of anything.
function buildClusters(tickets, documentedPath) {
  const documented = JSON.stringify(documentedPath || []);
  const clusters = new Map();

  for (const t of tickets) {
    const key = JSON.stringify(t.canonicalPath || []);

    if (t.status !== 'ok' || key === documented) {
      continue;
    }

    if (!clusters.has(key)) {
      clusters.set(key, []);
    }

    clusters.get(key).push(t);
  }

  return clusters;
}

function newAlertId(articleId) {
  const suffix = Math.random().toString(36).slice(2, 6);

  return `${articleId}-${Date.now()}-${suffix}`;
}

async function buildAlert(article, path, clusterTickets, denom, cfg) {
  const agents = [...new Set(clusterTickets.map((t) => t.agentId))].sort();
  const total = clusterTickets.length;

  const result = scoreCluster({
    explicit: clusterTickets.filter((t) => t.linkType === 'explicit').length,
    total,
    agents: agents.length,
    denom,
    reopens: clusterTickets.filter((t) => t.reopened === true).length,
    baselineReopen: article.baselineReopenRate || 0.0
  }, cfg);

  if (result.band === 'blocked') {
    return null;
  }

  const alert = {
    alertId: newAlertId(article.articleId),
    articleId: String(article.articleId),
    articleTitle: article.title || `Article ${article.articleId}`,
    pathSignature: path,
    documentedPathLabels: tax.displayPath(article.documentedPath),
    targetPathLabels: tax.displayPath(path),
    band: result.band,
    confidence: result.confidence,
    reason: result.reason,
    finding: 'article_stale',
    deprecatedSteps: tax.displayPath(path.filter(tax.isDeprecated)),
    evidenceTicketIds: clusterTickets.map((t) => t.ticketId),
    agents,
    share: shareOf(total, denom),
    density: densityOf(agents.length, cfg),
    state: 'open'
  };

  // A cluster that walks retired menu items is the opposite finding: the
  // article is current and the agents are behind it. Drafting is skipped
  // rather than attempted - the validator refuses deprecated steps by
  // design, so every attempt would fail, and an alert nobody can approve
  // does not belong on an approvals board pretending to be one.
  if (alert.deprecatedSteps.length) {
    alert.finding = 'retired_route_in_use';
  } else if (STALE_BANDS.includes(result.band)) {
    alert.patch = await draftAndValidate(
      article.markdown,
      path,
      clusterTickets.slice(0, EVIDENCE_REPLIES).map((t) => t.redactedText)
    );
  }

  await store.saveAlert(alert.alertId, alert);

  return alert;
}

async function rescoreArticle(article, cfg = DEFAULT_CFG) {
  const tickets = await store.getTicketsForArticle(article.articleId);
  const denom = tickets.filter((t) => t.status !== 'no_steps').length;
  const clusters = buildClusters(tickets, article.documentedPath);

  await store.clearOpenAlertsForArticle(article.articleId);

  const raised = [];

  for (const [key, clusterTickets] of clusters) {
    const alert = await buildAlert(article, JSON.parse(key), clusterTickets, denom, cfg);

    if (alert !== null) {
      raised.push({
        alertId: alert.alertId,
        band: alert.band,
        confidence: alert.confidence,
        patchPassed: alert.patch ? alert.patch.passed : null
      });
    }
  }

  return raised;
}

// ---------- Freshness -----------------------------------------------------

function bySeverity(a, b) {
  const critical = (b.band === 'critical') - (a.band === 'critical');

  return critical || (b.confidence || 0) - (a.confidence || 0);
}

function pickTopAlert(alerts, articleId) {
  const mine = alerts
    .filter((a) => String(a.articleId) === String(articleId))
    .sort(bySeverity);

  return mine.length ? mine[0] : null;
}

function documentedStepsText(article) {
  const path = (article && article.documentedPath) || [];

  return path.length ? tax.displayPath(path).join(` ${ARROW} `) : 'N/A';
}

function freshAnswer(articleId, oldStepsText) {
  return {
    article_id: articleId,
    status: 'fresh',
    is_stale: false,
    drift_confidence: 0.0,
    evidence_count: 0,
    recommended_action: 'answer_from_article',
    bot_message: `To resolve this: ${oldStepsText}`
  };
}

function alertBasis(articleId, alert) {
  return {
    article_id: articleId,
    is_stale: true,
    drift_confidence: alert.confidence,
    evidence_count: (alert.evidenceTicketIds || []).length
  };
}

// Critical + hedging on: share the unapproved path, clearly labelled.
function provisionalAnswer(articleId, alert) {
  const labels = tax.displayPath(alert.pathSignature || []);

  return Object.assign(alertBasis(articleId, alert), {
    status: 'critical',
    recommended_action: 'answer_with_provisional_notice',
    provisional_path_labels: labels,
    bot_message: `Our system has flagged a recent change to this procedure. While our help guides are being updated, our support agents are currently using this path: ${labels.join(` ${ARROW} `)}.`
  });
}

// Critical + hedging off: say nothing we cannot stand behind.
function handoffAnswer(articleId, alert) {
  return Object.assign(alertBasis(articleId, alert), {
    status: 'critical',
    recommended_action: 'handoff_to_human',
    bot_message: 'This guide is being updated. Connecting you with a human agent who can help.'
  });
}

function warningAnswer(articleId, alert, oldStepsText) {
  return Object.assign(alertBasis(articleId, alert), {
    status: 'warning',
    recommended_action: 'answer_from_article',
    bot_message: `To resolve this: ${oldStepsText}`
  });
}

async function checkFreshness(articleId, provisionHedging) {
  const article = await store.getArticle(articleId);
  const topAlert = pickTopAlert(await store.listOpenAlerts(), articleId);

  if (topAlert === null || !STALE_BANDS.includes(topAlert.band)) {
    return freshAnswer(articleId, documentedStepsText(article));
  }

  if (topAlert.band === 'critical') {
    return provisionHedging
      ? provisionalAnswer(articleId, topAlert)
      : handoffAnswer(articleId, topAlert);
  }

  return warningAnswer(articleId, topAlert, documentedStepsText(article));
}

// ---------- Who may act --------------------------------------------------
//
// HONEST LIMIT: a serverless method receives no authenticated caller. The
// front end tells us who it thinks is acting, and the front end can be
// bypassed by anyone able to call the data-pipe directly. This check stops
// the wrong person clicking the button and gives every published change an
// attributable name; it is not a security boundary. The boundary is which
// agents can open the app at all, which is a Freshdesk placement decision.
function adminList(iparams) {
  return String(iparams.admin_emails || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
}

function requireAdmin(args) {
  const admins = adminList(args.iparams || {});
  const actor = String(args.actor || '').trim().toLowerCase();

  // Unconfigured means unrestricted, so a fresh install is usable before
  // anyone has filled the field in.
  if (admins.length === 0) {
    return actor || 'unrestricted';
  }

  if (!admins.includes(actor)) {
    throw new Error(`${actor || 'this user'} is not an approver for this app`);
  }

  return actor;
}

// ---------- Approve / reject / edit --------------------------------------

async function approveAlert(alertId, publishMode, actor) {
  const alert = await store.getAlert(alertId);

  if (alert === null || !alert.patch || alert.patch.passed !== true) {
    throw new Error('cannot approve: no validated patch for this alert');
  }

  const statusCode = publishMode === 'demo' ? ARTICLE_PUBLISHED : ARTICLE_DRAFT;

  await fdUpdateArticle(alert.articleId, md.markdownToHtml(alert.patch.markdown), statusCode);

  const article = (await store.getArticle(alert.articleId)) || {
    articleId: String(alert.articleId),
    title: alert.articleTitle,
    baselineReopenRate: 0.0
  };

  article.markdown = alert.patch.markdown;
  article.documentedPath = alert.pathSignature;
  await store.saveArticle(alert.articleId, article);

  alert.state = 'approved';
  alert.approvedBy = actor;
  alert.approvedAt = new Date().toISOString();
  await store.saveAlert(alertId, alert);

  return {
    alertId,
    articleId: String(alert.articleId),
    publishedStatus: statusCode,
    published: statusCode === ARTICLE_PUBLISHED,
    approvedBy: actor
  };
}

async function rejectAlert(alertId, actor) {
  const alert = await store.getAlert(alertId);

  if (alert === null) {
    return { alertId, rejected: false };
  }

  alert.state = 'rejected';
  alert.rejectedBy = actor;
  await store.saveAlert(alertId, alert);

  return { alertId, rejected: true, rejectedBy: actor };
}

// A hand-edited patch goes through exactly the same validator as a drafted
// one. Editing cannot be a way to smuggle past the checks - if the edit drops
// a step or touches a section outside Steps, it fails and Approve stays
// disabled, with the reason shown.
async function updatePatch(alertId, markdown, actor) {
  const alert = await store.getAlert(alertId);

  if (alert === null) {
    throw new Error('cannot edit: that alert no longer exists');
  }

  const article = await store.getArticle(alert.articleId);

  if (article === null) {
    throw new Error('cannot edit: the article baseline is missing, re-ingest a ticket first');
  }

  const result = validatePatch(article.markdown, markdown, alert.pathSignature);

  alert.patch = {
    markdown,
    mode: 'manual',
    passed: result.passed,
    errors: result.errors,
    attempts: 0,
    editedBy: actor
  };

  await store.saveAlert(alertId, alert);

  return alert;
}

async function ingestTicketById(ticketId, cfg) {
  return ingestTicket(await fdGetTicket(ticketId), cfg);
}

// What the board shows in its taxonomy panel: every label and every route
// the graph has been asked about, and what became of it.
async function learningReport() {
  const labels = await store.listUnknownLabels();
  const edges = await store.listEdgeCandidates();

  return {
    labels,
    routes: edges.map((e) => ({
      from: tax.displayLabel(e.from),
      to: tax.displayLabel(e.to),
      tickets: (e.entries || []).length,
      promoted: e.promoted === true
    }))
  };
}

// ---------- Freshworks event / method exports -----------------------------
//
// Serverless methods invoked from the front end MUST answer through
// `renderData`; returning a value leaves the caller waiting for the gateway
// timeout. Product-event handlers must NOT call it (the platform has already
// answered the webhook) and must swallow their own rejections, otherwise an
// unhandled rejection takes the local FDK server down.

function respond(promise) {
  return promise.then(
    function (output) {
      renderData(null, output);
    },
    function (err) {
      renderData({ status: 500, message: errorText(err) });
    }
  );
}

function log(label, promise) {
  return promise.then(
    function (output) {
      console.info(`[knowledgeops] ${label}: ${JSON.stringify(output)}`);
    },
    function (err) {
      console.error(`[knowledgeops] ${label} failed: ${errorText(err)}`);
    }
  );
}

exports = {
  onTicketUpdateHandler: function (payload) {
    return log('onTicketUpdate', handleTicketUpdate(payload));
  },

  listAlerts: function () {
    return respond(store.listOpenAlerts());
  },

  getAlertDetail: function (args) {
    return respond(store.getAlert(args.alertId));
  },

  approveAlert: function (args) {
    const iparams = args.iparams || {};
    const mode = args.publishMode || iparams.publish_mode || 'production';

    return respond(Promise.resolve(requireAdmin(args))
      .then((actor) => approveAlert(args.alertId, mode, actor)));
  },

  rejectAlert: function (args) {
    return respond(Promise.resolve(requireAdmin(args))
      .then((actor) => rejectAlert(args.alertId, actor)));
  },

  updatePatch: function (args) {
    return respond(Promise.resolve(requireAdmin(args))
      .then((actor) => updatePatch(args.alertId, args.markdown, actor)));
  },

  checkFreshness: function (args) {
    const iparams = args.iparams || {};
    const hedging = args.provisionHedging === undefined
      ? iparams.provision_hedging === true
      : args.provisionHedging === true;

    return respond(checkFreshness(String(args.articleId), hedging));
  },

  listLearning: function () {
    return respond(learningReport());
  },

  // Auto-promotion has no human in the loop, so this is the undo: it drops
  // everything the graph taught itself and re-opens the candidates.
  resetLearning: function () {
    return respond(store.resetLearning());
  },

  ingestTicketById: function (args) {
    return respond(ingestTicketById(args.ticketId, scoringCfg(args.iparams || {})));
  }
};