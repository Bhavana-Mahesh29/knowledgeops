// server/server.js
// KnowledgeOps server-side logic for Freshworks FDK.
//
// Pipeline: onTicketUpdate -> match the ticket to a KB article (linkage ->
// semantic retrieval -> relevance gate) -> redact -> extract steps ->
// canonicalise -> cluster + score -> draft a patch -> (agent approves) ->
// publish to Freshdesk. A ticket no article matches is recorded as a
// knowledge gap instead of entering drift analysis.
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
const { draftAndValidate, draftGapArticle, validateGapArticle } = require('./lib/architect');
const { validatePatch } = require('./lib/validator');
const md = require('./lib/markdown');
const store = require('./lib/store');
const { resolveMatchConfig } = require('./lib/matchconfig');
const { createEmbedder } = require('./lib/embeddings');
const { buildKnowledgeIndex } = require('./lib/vectorstore');
const { judgeRelevance } = require('./lib/relevance');
const { matchResolvedTicket } = require('./lib/matcher');
const { buildResolutionQuery, normaliseKbArticle } = require('./lib/query');
const voice = require('./lib/voice');

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

async function fdCreateArticle(folderId, title, html, status) {
  const r = await $request.invokeTemplate('fdCreateArticle', {
    context: { folder_id: String(folderId) },
    body: JSON.stringify({ title, description: html, status })
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
//
// Freshdesk's article payload carries category and folder ids, not names, so
// the category labels matching uses (set through indexKnowledgeBase) are
// carried over from the stored copy rather than wiped by each sync.
// Freshdesk's folder/category id when it sent one, else what we had.
function idOr(remote, known) {
  if (remote !== undefined && remote !== null) {
    return String(remote);
  }

  return known || '';
}

async function syncArticle(articleId) {
  const remote = await fdGetArticle(articleId);
  const known = (await store.getArticle(articleId)) || {};
  const authored = md.htmlToMarkdown(remote.description);
  const markdown = md.normaliseArticleMarkdown(authored, remote.title);

  const article = {
    articleId: String(articleId),
    source: 'freshdesk',
    title: remote.title || `Article ${articleId}`,
    category: known.category || '',
    subcategory: known.subcategory || '',
    stepsHeading: md.stepsHeadingOf(authored),
    folderId: idOr(remote.folder_id, known.folderId),
    categoryId: idOr(remote.category_id, known.categoryId),
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

// Replies that are not a human agent's account of the fix: Freshdesk's own
// acknowledgement (no user), and answers a Freddy AI Agent drafted from the
// knowledge base. The latter matter most - an AI answer quotes the article,
// so counting it as evidence would make every ticket look like it followed
// the documented steps.
const AI_GENERATED = /generated by freddy ai|freddy ai agent/i;

function isHumanReply(c) {
  const system = c.user_id === 0 || c.user_id === '0';

  return !system && !AI_GENERATED.test(`${c.body_text || ''} ${c.body || ''}`);
}

// The resolving agent's own replies when they wrote any, otherwise every
// human agent reply on the ticket.
function resolutionReplies(conversations, responderId) {
  const human = conversations.filter((c) => isPublicAgentReply(c) && isHumanReply(c));
  const own = human.filter((c) => String(c.user_id) === String(responderId));

  return own.length ? own : human;
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

// Already a direct parent, so adding the edge would be a no-op; or it would
// close a loop and make the lineage walk meaningless. A shortcut past an
// intermediate menu (Profile -> Security, skipping Authentication) is a real
// new route and is allowed.
function edgeRedundant(record, edges) {
  return tax.parentsOf(record.to, edges).includes(record.from)
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

// ---------- Ticket-to-article matching -----------------------------------
//
// server/lib/matcher.js decides which article a resolved ticket was solved
// with; this section supplies its I/O. Claude only ever sees the ticket and
// the <= 3 candidates retrieval produced, never the knowledge base.

const EMBEDDING_CACHE = {
  get: (articleId) => store.getEmbedding(articleId),
  save: (articleId, record) => store.saveEmbedding(articleId, record)
};

// How strongly a match method links a ticket to its article. Only 'explicit'
// counts towards the N gate in scoring.js; the other kinds still add to the
// article's traffic and agent count.
const LINK_TYPES = {
  associated_solution_article_id: 'explicit',
  direct_solution_url: 'explicit',
  taxonomy_category_mapping: 'taxonomy',
  semantic_llm_gate: 'semantic'
};

function notFound(err) {
  return Boolean(err) && Number(err.status) === 404;
}

// Stage 1 on the Freshdesk path. A linked article counts when Freshdesk has
// it, indexed or not - which is how ingest worked before matching existed. A
// 404 is a dead link; any other failure is an outage and propagates, so it
// ends as MATCHING_UNAVAILABLE rather than a knowledge gap.
function freshdeskArticleExists(synced) {
  return async function (articleId) {
    try {
      synced.set(String(articleId), await syncArticle(articleId));
      return true;
    } catch (err) {
      if (notFound(err)) {
        return false;
      }
      throw err;
    }
  };
}

// What gets logged: the decision and the funnel. The query text is already
// redacted, and no request headers or keys ever reach the result.
function matchLog(result) {
  return {
    ticket_id: result.ticket_id,
    classification: result.classification,
    method: result.method,
    stage: result.stage,
    article_id: result.article_id || null,
    metrics: result.metrics,
    funnel: result.trace.join(' | ')
  };
}

async function runMatcher(ticket, iparams, articleExists) {
  const cfg = resolveMatchConfig(iparams);
  const result = await matchResolvedTicket(ticket, {
    cfg,
    articles: await store.listArticles(),
    embedder: createEmbedder(cfg),
    cache: EMBEDDING_CACHE,
    judge: judgeRelevance,
    articleExists
  });

  await store.recordMatchMetrics(result.metrics);
  console.info(`[knowledgeops] match: ${JSON.stringify(matchLog(result))}`);

  return result;
}

// A semantic match can land on a stored copy of an article Freshdesk no
// longer has - deleted, or synced from a different helpdesk earlier. Only
// articles loaded through indexKnowledgeBase are meant to live without a
// Freshdesk original; any other copy that 404s is dropped from the knowledge
// base and the ticket is matched again against what is left.
const MAX_REMATCHES = 3;

async function vanishedArticle(match, synced) {
  const articleId = String(match.article_id);

  if (match.classification !== 'ARTICLE_MATCH' || synced.has(articleId)) {
    return false;
  }

  const stored = await store.getArticle(articleId);

  if (stored !== null && stored.source === 'kb') {
    return false;
  }

  const exists = await freshdeskArticleExists(synced)(articleId).catch(() => true);

  if (!exists) {
    await store.removeArticle(articleId);
    console.info(`[knowledgeops] article ${articleId} no longer exists in Freshdesk - removed from the knowledge base, re-matching`);
  }

  return !exists;
}

async function matchLiveArticle(input, iparams, synced) {
  let match = await runMatcher(input, iparams, freshdeskArticleExists(synced));

  for (let i = 0; i < MAX_REMATCHES && await vanishedArticle(match, synced); i++) {
    match = await runMatcher(input, iparams, freshdeskArticleExists(synced));
  }

  return match;
}

// The explainable part of a match, as returned to callers.
function matchSummary(result) {
  const keys = ['ticket_id', 'classification', 'article_id', 'method', 'stage', 'semantic_score',
    'confidence', 'candidates', 'semantic_result', 'nearest', 'reason', 'error', 'metrics', 'trace'];

  return keys.reduce((out, k) => {
    if (result[k] !== undefined) {
      out[k] = result[k];
    }
    return out;
  }, {});
}

// Kept so a gap can later seed a new article: the redacted subject and
// resolution, and the nearest articles that were ruled out.
async function recordKnowledgeGap(match, ticket) {
  const query = buildResolutionQuery(ticket);
  const gap = {
    ticketId: String(match.ticket_id),
    subject: query.subject,
    resolution: query.resolution,
    method: match.method,
    stage: match.stage,
    ruledOut: match.candidates || match.nearest || [],
    reason: match.reason || null,
    recommendedAction: 'create_article',
    detectedAt: new Date().toISOString()
  };

  await store.saveKnowledgeGap(gap.ticketId, gap);

  return gap;
}

// A gap also goes on the board as an alert carrying a drafted new article,
// so it can be approved into Freshdesk the same way a patch is. One alert per
// ticket: re-ingesting refreshes an open draft but never resurrects one a
// reviewer already approved or rejected.
const GAP_FINDING = 'knowledge_gap';

function gapAlertId(ticketId) {
  return `gap-${ticketId}`;
}

async function raiseGapAlert(gap, evidence) {
  const alertId = gapAlertId(gap.ticketId);
  const existing = await store.getAlert(alertId);

  if (existing !== null && existing.state !== 'open') {
    return existing;
  }

  const steps = await extractSteps(gap.resolution || '').catch(() => []);
  const draft = await draftGapArticle({ subject: gap.subject, resolution: gap.resolution, steps });
  const alert = {
    alertId,
    articleId: null,
    articleTitle: draft.title,
    finding: GAP_FINDING,
    band: 'gap',
    ticketId: gap.ticketId,
    subject: gap.subject,
    resolutionNote: gap.resolution,
    evidenceTicketIds: [gap.ticketId],
    agents: evidence && evidence.responder_id !== undefined ? [String(evidence.responder_id)] : [],
    patch: {
      markdown: draft.markdown,
      mode: draft.mode,
      passed: draft.passed,
      errors: draft.errors,
      attempts: draft.attempts
    },
    detectedAt: gap.detectedAt,
    state: 'open'
  };

  await store.saveAlert(alertId, alert);

  return alert;
}

// ---------- Drift verdict for the terminal -------------------------------
//
// The ingest result is JSON for the board; this is the same outcome as a
// sentence, so whoever is watching `fdk run` can see whether a resolved
// ticket showed procedural drift without reading the payload.

function pathText(labels) {
  return labels && labels.length ? labels.join(` ${ARROW} `) : '(none)';
}

function alertText(alert) {
  const confidence = Number(alert.confidence || 0).toFixed(2);

  if (alert.finding === 'retired_route_in_use') {
    return `agents are walking a retired route - ${alert.band} alert raised (confidence ${confidence}), no patch drafted`;
  }

  const patch = alert.patchPassed === true ? 'validated patch drafted, awaiting approval' : 'no approvable patch yet';

  return `${alert.band} alert raised (confidence ${confidence}), ${patch}`;
}

function driftVerdict(drift) {
  if (drift.canonicalStatus === 'inconsistent' && drift.canonicalPath.length) {
    return 'PROCEDURAL DRIFT (unconfirmed) - the agent took a route the navigation graph does not know yet; recorded as a route candidate, no alert until other responders confirm it';
  }

  if (drift.canonicalStatus !== 'ok') {
    return `UNDETERMINED - the agent's steps could not be resolved to one navigation path (${drift.canonicalStatus})`;
  }

  if (JSON.stringify(drift.canonicalPath) === JSON.stringify(drift.documentedPath)) {
    return 'NO DRIFT - the agent followed the documented path';
  }

  if (drift.alerts.length) {
    return `PROCEDURAL DRIFT - ${drift.alerts.map(alertText).join('; ')}`;
  }

  return 'PROCEDURAL DRIFT observed - recorded as evidence, below the alert gates for now (needs more explicit links from more distinct responders; demo mode relaxes this)';
}

function driftReport(ticketId, outcome) {
  const head = `[knowledgeops] drift: ticket ${ticketId}`;
  const drift = outcome.drift;

  if (!drift) {
    return `${head} - no drift check: ${outcome.skipped}`;
  }

  return [
    `${head} -> article ${drift.articleId} "${drift.articleTitle}"`,
    `  documented path : ${pathText(drift.documentedPath)}`,
    `  agent's steps   : ${(drift.agentSteps || []).join(', ') || 'N/A'}`,
    `  agent's path    : ${pathText(drift.canonicalPath)}`,
    `  verdict         : ${driftVerdict(drift)}`
  ].concat(drift.warning ? [`  warning         : ${drift.warning}`] : []).join('\n');
}

// ---------- Ingest --------------------------------------------------------

// An article matched from the local knowledge base may not exist in
// Freshdesk (a dataset article, a deleted one); its stored copy is the
// baseline then. When Freshdesk has it, Freshdesk wins, as before.
async function articleForDrift(articleId, synced) {
  if (synced.has(articleId)) {
    return synced.get(articleId);
  }

  try {
    return await syncArticle(articleId);
  } catch (err) {
    const stored = await store.getArticle(articleId);

    if (stored !== null && stored.markdown) {
      return stored;
    }
    throw err;
  }
}

// The existing drift pipeline, unchanged, fed with whichever article the
// matcher chose. `ticket` needs { id, responder_id }.
async function runDrift(ticket, replyText, match, cfg, synced) {
  const articleId = String(match.article_id);
  const article = await articleForDrift(articleId, synced);
  const { redactedText } = redact(replyText);
  const steps = await extractSteps(redactedText);

  // Anything this ticket teaches the graph applies to this ticket too, and
  // to every ticket already on file for the article.
  const { canon, learned, promoted } = await resolveSteps(steps, ticket, cfg);

  await relearnTickets(articleId, learned);

  await store.saveTicket(ticket.id, {
    ticketId: String(ticket.id),
    articleId: String(articleId),
    linkType: LINK_TYPES[match.method] || 'semantic',
    matchMethod: match.method,
    matchStage: match.stage,
    matchConfidence: match.confidence,
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
    articleTitle: article.title,
    canonicalStatus: canon.status,
    agentSteps: steps,
    canonicalPath: tax.displayPath(canon.canonical_path),
    documentedPath: tax.displayPath(article.documentedPath),
    unknownLabels: canon.unknown_labels,
    learnedAliases: promoted.aliases,
    learnedRoutes: promoted.edges,
    warning: articleWarning(article),
    alerts: await rescoreArticle(article, cfg)
  };
}

// MATCH -> drift analysis. KNOWLEDGE_GAP -> a gap record, no drift: comparing
// a ticket against an article that does not describe what was done would
// manufacture drift. Anything else (no resolution, matching unavailable)
// concludes nothing and records nothing.
async function afterMatch(match, input, evidence, cfg, synced, iparams) {
  const outcome = await matchOutcome(match, input, evidence, cfg, synced);

  if (outcome.drift) {
    outcome.drift.adminCalls = await callAdminAboutCriticalAlerts(outcome.drift.alerts, iparams || {});
  }

  console.info(driftReport(evidence.id, outcome));

  return outcome;
}

async function matchOutcome(match, input, evidence, cfg, synced) {
  if (match.classification === 'ARTICLE_MATCH') {
    return { drift: await runDrift(evidence, evidence.replyText, match, cfg, synced) };
  }

  if (match.classification === 'KNOWLEDGE_GAP') {
    const gap = await recordKnowledgeGap(match, input);
    const alert = await raiseGapAlert(gap, evidence);

    return {
      knowledgeGap: Object.assign({ alertId: alert.alertId }, gap),
      skipped: 'knowledge gap - no article describes this resolution; new article drafted for review'
    };
  }

  return { skipped: `no article matched (${match.classification}: ${match.method})` };
}

// The matcher's view of a Freshdesk ticket. Freshdesk has no resolution-note
// field, so the last public agent reply stands in for it; private notes are
// scanned for article links alongside the replies.
function freshdeskMatchInput(ticket, conversations) {
  const custom = ticket.custom_fields || {};

  return {
    ticket_id: ticket.id,
    subject: ticket.subject || '',
    category: custom.cf_category || '',
    subcategory: custom.cf_subcategory || '',
    custom_fields: custom,
    conversation: resolutionReplies(conversations, ticket.responder_id),
    internal_notes: conversations.filter((c) => !c.incoming && c.private)
  };
}

async function ingestTicket(ticket, cfg, iparams) {
  if (!RESOLVED_STATUSES.includes(Number(ticket.status))) {
    return { ticketId: ticket.id, skipped: 'ticket is not resolved or closed' };
  }

  const conversations = await fdGetConversations(ticket.id);
  const input = freshdeskMatchInput(ticket, conversations);
  const synced = new Map();
  const match = await matchLiveArticle(input, iparams, synced);
  const evidence = {
    id: ticket.id,
    responder_id: ticket.responder_id,
    replyText: recentReplyText(input.conversation)
  };
  const outcome = await afterMatch(match, input, evidence, cfg, synced, iparams);

  return Object.assign({ ticketId: ticket.id }, outcome.drift, {
    match: matchSummary(match),
    knowledgeGap: outcome.knowledgeGap,
    skipped: outcome.skipped
  });
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
  const iparams = payload.iparams || {};
  const cfg = scoringCfg(iparams);

  if (!ticket.id) {
    return Promise.resolve({ skipped: 'event payload carried no ticket' });
  }

  if (!RESOLVED_STATUSES.includes(Number(ticket.status))) {
    return markReopened(ticket, cfg);
  }

  return ingestTicket(ticket, cfg, iparams);
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

  return alert;
}

async function rescoreArticle(article, cfg = DEFAULT_CFG) {
  const tickets = await store.getTicketsForArticle(article.articleId);
  const denom = tickets.filter((t) => t.status !== 'no_steps').length;
  const clusters = buildClusters(tickets, article.documentedPath);

  await store.clearOpenAlertsForArticle(article.articleId);

  // Patch drafting is an LLM round trip per cluster; run them side by side so
  // a multi-cluster article stays inside the serverless method timeout. The
  // saves stay sequential - the alert index is a read-modify-write.
  const alerts = await Promise.all([...clusters].map(([key, clusterTickets]) =>
    buildAlert(article, JSON.parse(key), clusterTickets, denom, cfg)));
  const raised = [];

  for (const alert of alerts) {
    if (alert !== null) {
      await store.saveAlert(alert.alertId, alert);
      raised.push({
        alertId: alert.alertId,
        band: alert.band,
        confidence: alert.confidence,
        finding: alert.finding,
        patchPassed: alert.patch ? alert.patch.passed : null
      });
    }
  }

  return raised;
}

// ---------- Phone calls ----------------------------------------------------
//
// Every rescore replaces an article's alerts with fresh ones under new ids,
// so "already called about this" is keyed on what the alert is about - the
// article and the path agents converged on - not on the alert id. Otherwise
// each further ticket on the same drift would ring the admin again.

function pathKey(path) {
  let h = 5381;

  for (const ch of JSON.stringify(path || [])) {
    h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  }

  return h.toString(36);
}

async function callAdminAboutAlert(alertId, iparams) {
  const alert = await store.getAlert(alertId);

  if (alert === null) {
    return null;
  }

  const key = `drift:${alert.articleId}:${pathKey(alert.pathSignature)}`;
  const earlier = await store.getCallRecord(key);
  const calls = earlier || await voice.callAdmins(iparams, voice.driftMessage(alert));

  if (earlier === null && calls.some((c) => c.placed)) {
    await store.saveCallRecord(key, calls);
  }

  alert.adminCalls = calls;
  await store.saveAlert(alert.alertId, alert);
  logAdminCalls(alertId, calls, earlier !== null);

  return { alertId, calls, repeat: earlier !== null };
}

function logAdminCalls(alertId, calls, repeat) {
  const note = repeat ? ' (already called about this drift)' : '';

  for (const c of calls) {
    const outcome = c.placed ? `placed to ${c.to}` : `not placed - ${c.reason}`;

    console.info(`[knowledgeops] admin call for alert ${alertId}: ${outcome}${note}`);
  }
}

// Only high drift rings a phone; an emerging drift waits on the board.
async function callAdminAboutCriticalAlerts(raised, iparams) {
  if (!voice.voiceEnabled(iparams)) {
    return [];
  }

  const out = [];

  for (const summary of raised || []) {
    if (summary.band === 'critical') {
      out.push(await callAdminAboutAlert(summary.alertId, iparams));
    }
  }

  return out.filter((r) => r !== null);
}

// After an approval reaches Freshdesk, the head of the department that owns
// the article is told what changed.
async function callDeptHead(alertId, result, iparams) {
  if (!voice.voiceEnabled(iparams)) {
    return { placed: false, reason: 'phone calls are not set up' };
  }

  const alert = await store.getAlert(alertId);
  const article = (await store.getArticle(result.articleId)) || {};
  const head = voice.deptHeadFor(article, iparams.dept_heads);
  const call = head === null
    ? { placed: false, reason: 'no department head matches this article - add its folder or category to "Department heads"' }
    : Object.assign({ team: head.team }, await voice.placeCall(iparams, head.phone, voice.updateMessage(alert, head, result.published)));

  alert.deptCall = call;
  await store.saveAlert(alertId, alert);
  console.info(`[knowledgeops] department call for article ${result.articleId}: ${call.placed ? `placed to the ${call.team} lead` : `not placed - ${call.reason}`}`);

  return call;
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

// ---------- Freddy AI actions ---------------------------------------------
//
// actions.json exposes KnowledgeOps to Freddy AI Agent Studio as a freshness
// checker. checkTicketFreshness is meant to run as a ticket is resolved: it
// reuses whatever the onTicketUpdate pipeline already worked out for the
// ticket, and runs that pipeline itself only when the ticket has not been
// seen yet (the event and Freddy can fire in either order). The answer is
// written for an LLM to relay: a freshness word, a one-paragraph summary and
// the evidence behind it.

const FRESHNESS = { fresh: 'fresh', warning: 'emerging_drift', critical: 'high_drift' };

function actionError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Freddy may hand over "#1042" or " 1042 "; only that decoration is dropped.
function ticketIdOf(raw) {
  const id = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^#\s*/, '');

  if (id === '') {
    throw actionError(400, 'ticket_id must be a Freshdesk ticket number, e.g. 1042');
  }

  return id;
}

function joined(labels) {
  return labels && labels.length ? labels.join(` ${ARROW} `) : '';
}

function samePath(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function sharedPrefix(a, b) {
  let n = 0;

  while (n < a.length && n < b.length && a[n] === b[n]) {
    n += 1;
  }

  return n;
}

// Mirrors the board's "Step:" line.
function changedStep(before, after) {
  const head = sharedPrefix(before, after);
  const tail = sharedPrefix(before.slice(head).reverse(), after.slice(head).reverse());
  const removed = before.slice(head, before.length - tail).join(' / ');
  const added = after.slice(head, after.length - tail).join(' / ');

  return removed || added ? `${removed || '(none)'} ${ARROW} ${added || '(none)'}` : '';
}

function evidenceText(alert) {
  const agents = (alert.agents || []).length;
  const tickets = (alert.evidenceTicketIds || []).length;

  return `Confirmed by ${agents} agent(s) across ${tickets} ticket(s) (${Math.round((alert.share || 0) * 100)}% convergence)`;
}

function driftFields(alert) {
  if (alert === null) {
    return {};
  }

  return {
    changed_step: changedStep(alert.documentedPathLabels || [], alert.targetPathLabels || []),
    evidence: evidenceText(alert),
    alert_id: alert.alertId,
    admin_notified: (alert.adminCalls || []).some((c) => c.placed)
  };
}

const NEXT_STEP = {
  fresh: 'No action needed - the article matches how this is being resolved.',
  emerging_drift: 'Keep answering from the article; KnowledgeOps is collecting more evidence.',
  high_drift: 'Review and approve the proposed article update on the KnowledgeOps board.'
};

function freshnessSummary(freshness, article, alert) {
  const title = `"${article.title}"`;

  if (freshness === 'fresh') {
    return `Solution article ${title} is up to date.`;
  }

  const level = freshness === 'high_drift' ? 'High knowledge drift' : 'Emerging knowledge drift';

  return `${level} on article ${title}: agents now use ${joined(alert.targetPathLabels)} `
    + `instead of the published ${joined(alert.documentedPathLabels) || 'steps'}. ${evidenceText(alert)}.`;
}

async function articleVerdict(articleId, iparams) {
  const article = (await store.getArticle(articleId)) || { articleId, title: `Article ${articleId}`, documentedPath: [] };
  const answer = await checkFreshness(articleId, iparams.provision_hedging === true);
  const freshness = FRESHNESS[answer.status] || 'fresh';
  const alert = freshness === 'fresh' ? null : pickTopAlert(await store.listOpenAlerts(), articleId);

  return {
    article,
    fields: Object.assign({
      article_id: String(articleId),
      article_title: article.title,
      freshness,
      is_stale: freshness !== 'fresh',
      summary: freshnessSummary(freshness, article, alert),
      published_path: joined(tax.displayPath(article.documentedPath || [])),
      drift_confidence: answer.drift_confidence,
      recommended_action: NEXT_STEP[freshness],
      bot_message: answer.bot_message
    }, driftFields(alert))
  };
}

async function articleFreshness(rawArticleId, iparams) {
  const articleId = String(rawArticleId === undefined || rawArticleId === null ? '' : rawArticleId).trim();

  if (articleId === '' || (await store.getArticle(articleId)) === null) {
    throw actionError(404, `KnowledgeOps has no record of article ${articleId || '(blank)'} yet`);
  }

  return (await articleVerdict(articleId, iparams)).fields;
}

function gapVerdict(ticketId, gap, alert) {
  const drafted = alert
    ? `KnowledgeOps drafted a new article, "${alert.articleTitle}", for review.`
    : 'It is recorded as a knowledge gap.';

  return {
    ticket_id: ticketId,
    freshness: 'knowledge_gap',
    is_stale: true,
    summary: `No solution article describes how ticket ${ticketId} was resolved ("${gap.subject || 'no subject'}"). ${drafted}`,
    recommended_action: 'Review the drafted article on the KnowledgeOps board and approve it to publish.',
    alert_id: alert ? alert.alertId : '',
    admin_notified: false
  };
}

async function ticketVerdict(ticketId, record, iparams) {
  const verdict = await articleVerdict(record.articleId, iparams);
  const followed = samePath(record.canonicalPath, verdict.article.documentedPath);
  const agentPath = joined(tax.displayPath(record.canonicalPath || []));
  const note = followed
    ? ' This ticket followed the documented steps.'
    : ` This ticket was resolved via ${agentPath || 'steps KnowledgeOps could not map to a menu path'}.`;

  return Object.assign({ ticket_id: ticketId }, verdict.fields, {
    agent_path: agentPath,
    followed_article: followed,
    summary: verdict.fields.summary + note
  });
}

// Ticket not seen yet: run the same pipeline the onTicketUpdate event does.
async function analyseTicket(ticketId, iparams) {
  const outcome = await ingestTicketById(ticketId, scoringCfg(iparams), iparams);

  return outcome.skipped && !outcome.knowledgeGap ? outcome.skipped : null;
}

function notChecked(ticketId, reason) {
  return {
    ticket_id: ticketId,
    freshness: 'not_checked',
    is_stale: false,
    summary: `KnowledgeOps did not check ticket ${ticketId}: ${reason}.`,
    recommended_action: 'No action needed.'
  };
}

async function ticketFreshness(rawTicketId, iparams) {
  const ticketId = ticketIdOf(rawTicketId);
  const known = (await store.getTicket(ticketId)) || (await store.getKnowledgeGap(ticketId));
  const skipped = known === null ? await analyseTicket(ticketId, iparams) : null;

  if (skipped !== null) {
    return notChecked(ticketId, skipped);
  }

  const record = await store.getTicket(ticketId);

  if (record !== null) {
    return ticketVerdict(ticketId, record, iparams);
  }

  return gapVerdict(ticketId, (await store.getKnowledgeGap(ticketId)) || {}, await store.getAlert(gapAlertId(ticketId)));
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

function markApproved(alert, actor) {
  alert.state = 'approved';
  alert.approvedBy = actor;
  alert.approvedAt = new Date().toISOString();

  return store.saveAlert(alert.alertId, alert);
}

// A knowledge gap is approved into a brand-new Freshdesk article, filed in
// the folder named in the app settings, and joins the knowledge base so the
// next ticket like it matches instead of opening another gap.
async function approveGap(alert, statusCode, folderSetting, actor) {
  const folderId = String(folderSetting || '').trim();

  if (!folderId) {
    throw new Error('cannot publish a new article: set "Folder for new articles" in the app settings');
  }

  const title = validateGapArticle(alert.patch.markdown).title || alert.articleTitle;
  const created = await fdCreateArticle(folderId, title, md.markdownToHtml(alert.patch.markdown), statusCode);
  const articleId = String(created.id);

  await store.saveArticle(articleId, {
    articleId,
    source: 'freshdesk',
    title,
    category: '',
    subcategory: '',
    folderId,
    markdown: alert.patch.markdown,
    documentedPath: md.documentedPathOf(alert.patch.markdown),
    baselineReopenRate: 0.0
  });

  alert.articleId = articleId;
  alert.articleTitle = title;
  await markApproved(alert, actor);

  return {
    alertId: alert.alertId,
    articleId,
    created: true,
    publishedStatus: statusCode,
    published: statusCode === ARTICLE_PUBLISHED,
    approvedBy: actor
  };
}

async function approveAlert(alertId, publishMode, actor, folderId) {
  const alert = await store.getAlert(alertId);

  if (alert === null || !alert.patch || alert.patch.passed !== true) {
    throw new Error('cannot approve: no validated patch for this alert');
  }

  const statusCode = publishMode === 'demo' ? ARTICLE_PUBLISHED : ARTICLE_DRAFT;

  if (alert.finding === GAP_FINDING) {
    return approveGap(alert, statusCode, folderId, actor);
  }

  const article = (await store.getArticle(alert.articleId)) || {
    articleId: String(alert.articleId),
    title: alert.articleTitle,
    baselineReopenRate: 0.0
  };
  const published = md.restoreStepsHeading(alert.patch.markdown, article.stepsHeading);

  await fdUpdateArticle(alert.articleId, md.markdownToHtml(published), statusCode);

  article.markdown = alert.patch.markdown;
  article.documentedPath = alert.pathSignature;
  await store.saveArticle(alert.articleId, article);
  await markApproved(alert, actor);

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

  if (alert.finding === GAP_FINDING) {
    return updateGapDraft(alert, markdown, actor);
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

// A new article has no baseline to diff against, so an edited gap draft is
// checked for shape (title, numbered steps, verification) instead.
async function updateGapDraft(alert, markdown, actor) {
  const result = validateGapArticle(markdown);

  alert.patch = {
    markdown,
    mode: 'manual',
    passed: result.passed,
    errors: result.errors,
    attempts: 0,
    editedBy: actor
  };
  alert.articleTitle = result.title || alert.articleTitle;

  await store.saveAlert(alert.alertId, alert);

  return alert;
}

async function ingestTicketById(ticketId, cfg, iparams) {
  return ingestTicket(await fdGetTicket(ticketId), cfg, iparams);
}

// ---------- Freshdesk automation webhook ----------------------------------
//
// `fdk run` never receives real product events, so onTicketUpdate only fires
// once the app is installed in Freshdesk. For local development, a Freshdesk
// automation rule ("status changed to Resolved -> trigger webhook") can POST
// to the tunnel URL `fdk run --tunnel` prints, at /event/hook/common. The
// body only needs the ticket id; the ticket itself is re-read from Freshdesk,
// so a forged or stale body cannot claim a status the ticket does not have.

function webhookBody(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (err) {
      void err;
      return {};
    }
  }

  return data || {};
}

// Accepts {"ticket_id": 9}, {"ticket": {"id": 9}} and Freshdesk's default
// {"freshdesk_webhook": {"ticket_id": "9"}}; "#9" works too.
function webhookTicketId(data) {
  const body = webhookBody(data);
  const nested = body.freshdesk_webhook || {};
  const raw = [body.ticket_id, body.ticket && body.ticket.id, nested.ticket_id, body.id]
    .find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const digits = String(raw === undefined ? '' : raw).replace(/\D/g, '');

  return digits === '' ? null : digits;
}

async function handleExternalEvent(payload) {
  const ticketId = webhookTicketId(payload.data);

  if (ticketId === null) {
    return { skipped: 'webhook body carried no ticket id - send {"ticket_id": "{{ticket.id}}"}' };
  }

  const ticket = await fdGetTicket(ticketId);

  return handleTicketUpdate({ data: { ticket }, iparams: payload.iparams });
}

// ---------- Knowledge base and the match endpoint -------------------------

// Stored in the same shape syncArticle writes, so a KB article loaded here
// can go straight into drift analysis if a ticket matches it.
async function saveKbArticle(raw) {
  const a = normaliseKbArticle(raw);
  const known = (await store.getArticle(a.article_id)) || {};
  const markdown = md.normaliseArticleMarkdown(a.body, a.title);

  await store.saveArticle(a.article_id, Object.assign({}, known, {
    articleId: a.article_id,
    source: 'kb',
    title: a.title || known.title || `Article ${a.article_id}`,
    category: a.category,
    subcategory: a.subcategory,
    markdown,
    documentedPath: md.documentedPathOf(markdown),
    baselineReopenRate: known.baselineReopenRate || 0.0
  }));
}

// Loads (optional) articles into the knowledge base and embeds whatever is
// new or changed; unchanged articles keep their cached embedding.
async function indexKnowledgeBase(articles, iparams) {
  for (const raw of articles || []) {
    await saveKbArticle(raw);
  }

  const cfg = resolveMatchConfig(iparams);
  const index = await buildKnowledgeIndex(await store.listArticles(), createEmbedder(cfg), EMBEDDING_CACHE);

  return Object.assign({ provider: cfg.embeddingProvider, model: index.model }, index.stats);
}

const TICKET_FIELDS = [
  'ticket_id', 'id', 'subject', 'resolution_note', 'resolution', 'conversation', 'internal_notes',
  'notes', 'description', 'description_text', 'associated_solution_article_id', 'solution_article_id',
  'custom_fields', 'category', 'subcategory'
];

// Only ticket fields go to the matcher - never iparams or anything else the
// platform adds to a method's arguments.
function requestTicket(args) {
  return TICKET_FIELDS.reduce((t, k) => {
    if (args[k] !== undefined) {
      t[k] = args[k];
    }
    return t;
  }, {});
}

// Step extraction reads what the agent wrote: the resolution note plus the
// last few public agent replies, when the caller sent the conversation.
function requestReplyText(ticket) {
  const replies = Array.isArray(ticket.conversation) ? ticket.conversation.filter(isPublicAgentReply) : [];

  return [ticket.resolution_note || ticket.resolution || '', recentReplyText(replies)]
    .filter((t) => t !== '')
    .join('\n\n');
}

// POST /match-resolved-ticket, as a serverless method. Returns the matching
// decision, plus the drift analysis for a match or the gap record for a gap.
async function matchResolvedTicketRequest(args) {
  const iparams = args.iparams || {};
  const ticket = requestTicket(args);
  const match = await runMatcher(ticket, iparams);

  if (args.run_drift === false) {
    return matchSummary(match);
  }

  const evidence = {
    id: ticket.ticket_id || ticket.id,
    responder_id: args.agent_id || args.responder_id || 'unknown',
    replyText: requestReplyText(ticket)
  };
  const outcome = await afterMatch(match, ticket, evidence, scoringCfg(iparams), new Map(), iparams)
    .catch((err) => ({ driftError: errorText(err) }));

  return Object.assign(matchSummary(match), {
    drift: outcome.drift,
    drift_error: outcome.driftError,
    knowledge_gap: outcome.knowledgeGap
  });
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
      // A 4xx we raised on purpose (bad ticket id, unknown article) keeps its
      // status so the caller - the board or Freddy - can tell it from an outage.
      const status = Number(err && err.status);

      renderData({ status: status >= 400 && status < 500 ? status : 500, message: errorText(err) });
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

  onExternalEventHandler: function (payload) {
    return log('onExternalEvent', handleExternalEvent(payload || {}));
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
      .then((actor) => approveAlert(args.alertId, mode, actor, iparams.gap_folder_id))
      .then(async (result) => Object.assign(result, { deptCall: await callDeptHead(args.alertId, result, iparams) })));
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
    const iparams = args.iparams || {};

    return respond(ingestTicketById(args.ticketId, scoringCfg(iparams), iparams));
  },

  matchResolvedTicket: function (args) {
    return respond(matchResolvedTicketRequest(args || {}));
  },

  indexKnowledgeBase: function (args) {
    return respond(indexKnowledgeBase((args || {}).articles, (args || {}).iparams || {}));
  },

  listKnowledgeGaps: function () {
    return respond(store.listKnowledgeGaps());
  },

  getMatchMetrics: function () {
    return respond(store.getMatchMetrics());
  },

  // ---- Freddy AI actions (actions.json) ----
  // Flat arguments arrive as-is, e.g. { ticket_id: '1042', iparams }.

  checkTicketFreshness: function (args) {
    return respond(ticketFreshness((args || {}).ticket_id, (args || {}).iparams || {}));
  },

  getArticleFreshness: function (args) {
    return respond(articleFreshness((args || {}).article_id, (args || {}).iparams || {}));
  }
};
