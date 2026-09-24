// server/lib/matcher.js
// Decides which knowledge-base article, if any, a resolved ticket was solved
// with. Three stages, cheapest and most certain first:
//
//   1  deterministic linkage   associated article / solution URL / category
//   2  semantic retrieval      subject + resolution vs. every article, top 3
//   3  relevance gate          Claude picks one of those <= 3, or none
//
// Outcomes:
//   ARTICLE_MATCH          hand the article to the drift pipeline
//   KNOWLEDGE_GAP          nothing in the KB describes what was done
//   INSUFFICIENT_EVIDENCE  the ticket carries no resolution to match on
//   MATCHING_UNAVAILABLE   a dependency failed; nothing can be concluded
//
// The last one matters: an embedding outage or a garbled model reply is not
// evidence that an article is missing, so it is never reported as a gap.
//
// All I/O is injected (see matchResolvedTicket), which is what lets the whole
// funnel run under plain node with a mock embedder and a scripted gate.
'use strict';

const { deterministicMatch } = require('./linkage');
const { buildResolutionQuery, articleProcedure, normaliseKbArticle } = require('./query');
const { buildKnowledgeIndex, searchKnowledge } = require('./vectorstore');

// ---- Funnel bookkeeping -------------------------------------------------

function newFunnel(ticketId) {
  return {
    ticketId,
    trace: [`Ticket ${ticketId}`],
    metrics: {
      stage_1_attempted: false,
      stage_1_matched: false,
      stage_2_executed: false,
      stage_2_top_score: null,
      stage_2_candidate_count: 0,
      stage_3_executed: false,
      stage_3_match: false,
      stage_3_no_match: false,
      knowledge_gap: false,
      matching_unavailable: false
    }
  };
}

function finish(funnel, result) {
  const m = funnel.metrics;

  m.knowledge_gap = result.classification === 'KNOWLEDGE_GAP';
  m.matching_unavailable = result.classification === 'MATCHING_UNAVAILABLE';
  funnel.trace.push(result.article_id ? `Article: ${result.article_id}` : `Outcome: ${result.classification} (${result.method})`);

  return Object.assign({ ticket_id: funnel.ticketId }, result, { metrics: m, trace: funnel.trace });
}

function unavailable(funnel, stage, method, err) {
  funnel.trace.push(`Stage ${stage}: unavailable - ${method}`);

  return finish(funnel, {
    classification: 'MATCHING_UNAVAILABLE',
    method,
    stage,
    error: String((err && err.message) || err || method).slice(0, 300)
  });
}

// Runs one dependency call; a throw becomes MATCHING_UNAVAILABLE.
async function attempt(funnel, stage, method, fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    return { failed: unavailable(funnel, stage, method, err) };
  }
}

// ---- Stage 1 ------------------------------------------------------------

function defaultExists(articles) {
  const ids = new Set(articles.map((a) => a.article_id));

  return (id) => Promise.resolve(ids.has(String(id)));
}

async function stageOne(ticket, deps, funnel) {
  funnel.metrics.stage_1_attempted = true;

  const exists = deps.articleExists || defaultExists(deps.articles);
  const run = await attempt(funnel, 1, 'deterministic_linkage_failed', () => deterministicMatch(ticket, deps.articles, exists));

  if (run.failed || run.value.classification !== 'ARTICLE_MATCH') {
    const notes = run.value && run.value.notes.length ? ` (${run.value.notes.join('; ')})` : '';

    if (!run.failed) {
      funnel.trace.push(`Stage 1: no explicit article${notes}`);
    }
    return run;
  }

  funnel.metrics.stage_1_matched = true;
  funnel.trace.push(`Stage 1: ${run.value.method} -> ${run.value.article_id}`);

  return { matched: finish(funnel, run.value) };
}

// ---- Stage 2 ------------------------------------------------------------

async function stageTwo(query, deps, funnel) {
  const { cfg, embedder } = deps;

  funnel.metrics.stage_2_executed = true;

  const q = await attempt(funnel, 2, 'embedding_failed', () => embedder.embedText(query.text, 'query'));
  if (q.failed) {
    return q;
  }

  const idx = await attempt(funnel, 2, 'vector_store_failed', () => buildKnowledgeIndex(deps.articles, embedder, deps.cache));
  if (idx.failed) {
    return idx;
  }

  const hit = await attempt(funnel, 2, 'vector_store_failed', () => searchKnowledge(idx.value, q.value, cfg.topK, cfg.semanticThreshold));
  if (hit.failed) {
    return hit;
  }

  funnel.metrics.stage_2_top_score = hit.value.topScore;
  funnel.metrics.stage_2_candidate_count = hit.value.candidates.length;
  funnel.trace.push(`Stage 2: ${hit.value.candidates.length} candidates at or above ${cfg.semanticThreshold} (top score ${hit.value.topScore}, ${idx.value.stats.indexed} articles indexed)`);

  return { value: { search: hit.value, index: idx.value } };
}

function noSemanticMatch(funnel, search) {
  return finish(funnel, {
    classification: 'KNOWLEDGE_GAP',
    method: 'no_semantic_match',
    semantic_result: 'NO_SEMANTIC_MATCH',
    stage: 2,
    nearest: search.top
  });
}

// ---- Stage 3 ------------------------------------------------------------

// Only what the gate needs to judge the procedure - never the whole article
// record, never an article that was not retrieved.
function gateCandidates(search, index) {
  const byId = new Map(index.entries.map((e) => [e.article_id, e]));

  return search.candidates.map((c) => {
    const e = byId.get(c.article_id);

    return {
      article_id: c.article_id,
      title: e.title,
      category: e.category,
      subcategory: e.subcategory,
      procedure: articleProcedure(e.body),
      score: c.score
    };
  });
}

function gateOutcome(decision, search, cfg) {
  const base = { stage: 3, candidates: search.candidates, reason: decision.reason, confidence: decision.confidence };

  if (decision.decision === 'MATCH' && decision.confidence >= cfg.relevanceMinConfidence) {
    const chosen = search.candidates.find((c) => c.article_id === decision.article_id);

    return Object.assign(base, {
      classification: 'ARTICLE_MATCH',
      article_id: decision.article_id,
      method: 'semantic_llm_gate',
      semantic_score: chosen.score
    });
  }

  const method = decision.decision === 'MATCH' ? 'low_confidence_llm_gate' : 'no_relevant_article';

  return Object.assign(base, { classification: 'KNOWLEDGE_GAP', method });
}

async function stageThree(query, stage2, deps, funnel) {
  const { search, index } = stage2;
  const candidates = gateCandidates(search, index);

  funnel.metrics.stage_3_executed = true;

  const run = await attempt(funnel, 3, 'relevance_gate_failed', () => deps.judge(query, candidates, deps.cfg.relevanceModel));
  if (run.failed) {
    return run.failed;
  }

  if (!run.value.valid) {
    return unavailable(funnel, 3, 'relevance_gate_invalid_output', run.value.error);
  }

  const outcome = gateOutcome(run.value, search, deps.cfg);

  funnel.metrics.stage_3_match = outcome.classification === 'ARTICLE_MATCH';
  funnel.metrics.stage_3_no_match = !funnel.metrics.stage_3_match;
  funnel.trace.push(`Stage 3: Claude ${run.value.decision} (confidence ${run.value.confidence})`);

  return finish(funnel, outcome);
}

// ---- Orchestrator -------------------------------------------------------

function insufficient(funnel) {
  funnel.trace.push('Stage 2: not run - nothing to embed');

  return finish(funnel, { classification: 'INSUFFICIENT_EVIDENCE', method: 'empty_resolution', stage: 2 });
}

function ticketIdOf(ticket) {
  return String(ticket.ticket_id || ticket.id || 'unknown');
}

// deps:
//   cfg            resolveMatchConfig(...) output
//   articles       the knowledge base, any article shape normaliseKbArticle accepts
//   embedder       createEmbedder(...) output
//   cache          { get(id), save(id, record) } for article embeddings
//   judge          (query, candidates, model) -> validated gate decision
//   articleExists  optional async (id) -> boolean for stage 1
async function matchResolvedTicket(ticket, deps) {
  const funnel = newFunnel(ticketIdOf(ticket));

  // Stored, synced and dataset articles name their fields differently; every
  // stage below sees one shape.
  const kb = Object.assign({}, deps, { articles: (deps.articles || []).map(normaliseKbArticle) });

  const one = await stageOne(ticket, kb, funnel);
  const decided = one.failed || one.matched;
  if (decided) {
    return decided;
  }

  return semanticStages(ticket, kb, funnel);
}

async function semanticStages(ticket, deps, funnel) {
  const query = buildResolutionQuery(ticket);
  if (query.empty) {
    return insufficient(funnel);
  }

  const two = await stageTwo(query, deps, funnel);
  if (two.failed) {
    return two.failed;
  }

  if (two.value.search.candidates.length === 0) {
    return noSemanticMatch(funnel, two.value.search);
  }

  return stageThree(query, two.value, deps, funnel);
}

const api = { matchResolvedTicket };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
