// server/lib/relevance.js
// Matching stage 3: Claude as a relevance gate over at most three retrieved
// candidates. Claude is not the search engine - it never sees the knowledge
// base, only the resolved ticket and the candidates stage 2 produced.
//
// The decision comes back through a forced tool call, so the shape is
// enforced by the API, and is then validated here anyway. Anything that does
// not validate - malformed output, an article id that was not offered - is
// reported as invalid. It is never read as a match, and the matcher does not
// read it as a knowledge gap either: a model that failed to answer has not
// told us the knowledge base lacks the article.
'use strict';

const { MAX_CANDIDATES } = require('./matchconfig');

const MAX_TOKENS = 400;
const MAX_BODY_CHARS = 2500;
const TOOL_NAME = 'record_relevance_decision';

const SYSTEM = `You are a knowledge-base relevance classifier.

Given a resolved support ticket and up to three candidate knowledge-base articles, determine whether one candidate is the article for the task that was performed to resolve the ticket - the same goal with the same outcome for the customer.

Do not select an article merely because it discusses the same topic. For example, "How to process a partial refund" and "How to cancel a subscription" may both relate to billing but are different tasks.

Do select an article for the same task even when the agent's steps differ from it: different menus, a different order, missing, extra or reworded steps. The article may be out of date, and comparing its steps with the agent's is done later, by a separate check. Rejecting an article because its steps differ hides exactly the drift that check exists to find.

Rules:
1. Select an article only if it covers the task that resolved the ticket.
2. Judge the task and its outcome, never whether the steps agree.
3. If no candidate covers that task, return NO_MATCH.
4. Never invent an article ID.
5. The selected article ID must be one of the supplied candidates.
6. Respond only by calling the ${TOOL_NAME} tool.`;

const TOOL = {
  name: TOOL_NAME,
  description: 'Record whether one candidate article covers the task that resolved the ticket.',
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['MATCH', 'NO_MATCH'] },
      article_id: { type: ['string', 'null'], description: 'One of the supplied candidate ids, or null for NO_MATCH.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' }
    },
    required: ['decision', 'article_id', 'confidence', 'reason']
  }
};

// ---- Prompt -------------------------------------------------------------

function candidateBlock(c, i) {
  return [
    `Candidate ${i + 1}`,
    `article_id: ${c.article_id}`,
    `title: ${c.title}`,
    `category: ${c.category || '-'}`,
    `subcategory: ${c.subcategory || '-'}`,
    `semantic_score: ${c.score}`,
    `procedure:\n${String(c.procedure || '').slice(0, MAX_BODY_CHARS)}`
  ].join('\n');
}

// The cap is enforced here as well as in stage 2, so no caller can hand the
// gate a larger slice of the knowledge base by mistake.
function buildRelevancePrompt(query, candidates) {
  const shown = candidates.slice(0, MAX_CANDIDATES);

  return `Resolved ticket\nsubject: ${query.subject}\nresolution: ${query.resolution}\n\n`
    + `${shown.map(candidateBlock).join('\n\n')}\n\n`
    + 'Which candidate, if any, is the article for the task performed?';
}

function requestBody(query, candidates, model) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: buildRelevancePrompt(query, candidates) }]
  };
}

// ---- Validation ---------------------------------------------------------

function invalid(error) {
  return { valid: false, decision: 'NO_MATCH', article_id: null, confidence: 0, reason: null, error };
}

function decisionOf(raw) {
  return raw && typeof raw === 'object' && ['MATCH', 'NO_MATCH'].includes(raw.decision) ? raw.decision : null;
}

function confidenceOf(raw) {
  const n = Number(raw.confidence);

  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function articleIdOf(raw) {
  return raw.article_id === null || raw.article_id === undefined ? null : String(raw.article_id);
}

// Keeps exactly the four expected fields; anything extra the model adds is
// dropped rather than passed along.
function validateRelevanceDecision(raw, candidateIds) {
  const decision = decisionOf(raw);

  if (decision === null) {
    return invalid('decision is missing or not MATCH/NO_MATCH');
  }

  const confidence = confidenceOf(raw);

  if (confidence === null) {
    return invalid('confidence is missing or outside 0..1');
  }

  const articleId = articleIdOf(raw);

  if (decision === 'MATCH' && !candidateIds.includes(articleId)) {
    return invalid(`article_id ${articleId} was not one of the candidates`);
  }

  return {
    valid: true,
    decision,
    article_id: decision === 'MATCH' ? articleId : null,
    confidence,
    reason: String(raw.reason || '')
  };
}

// Tool input normally; a text block holding JSON is accepted as a fallback.
function decisionPayload(data) {
  const blocks = (data && data.content) || [];
  const tool = blocks.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);

  if (tool) {
    return tool.input;
  }

  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

function parseRelevanceResponse(responseText, candidateIds) {
  let payload;

  try {
    payload = decisionPayload(JSON.parse(responseText));
  } catch (err) {
    return invalid(`malformed response: ${String(err.message || err).slice(0, 120)}`);
  }

  return validateRelevanceDecision(payload, candidateIds);
}

// ---- Entry point --------------------------------------------------------

// Transport failures (no key, rate limit, network) throw; the matcher reports
// them as MATCHING_UNAVAILABLE. A response that arrives but does not validate
// comes back as { valid: false }.
async function judgeRelevance(query, candidates, model) {
  const shown = candidates.slice(0, MAX_CANDIDATES);
  const response = await $request.invokeTemplate('anthropicMessages', {
    body: JSON.stringify(requestBody(query, shown, model))
  });

  return parseRelevanceResponse(response.response, shown.map((c) => String(c.article_id)));
}

const api = {
  judgeRelevance,
  buildRelevancePrompt,
  parseRelevanceResponse,
  validateRelevanceDecision,
  TOOL_NAME,
  SYSTEM
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
