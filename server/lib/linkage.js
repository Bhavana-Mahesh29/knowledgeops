// server/lib/linkage.js
// Matching stage 1: deterministic linkage. Looks for evidence already on the
// resolved ticket of which knowledge-base article was used - an associated
// article field, a solution-article URL, or an unambiguous category mapping.
//
// Nothing here guesses. Two different articles linked from one ticket, or two
// articles filed under the same category, is ambiguity, and ambiguity is
// handed on to semantic retrieval rather than resolved by picking one.
'use strict';

const tax = require('./taxonomy');

// Freshdesk / Freshservice solution-article URLs, absolute or relative:
//   https://acme.freshdesk.com/a/solutions/articles/12345
//   https://acme.freshdesk.com/support/solutions/articles/12345-reset-token
//   https://acme.freshservice.com/support/solutions/12345
//   /helpdesk/solutions/articles/12345?lang=en
const ARTICLE_URL_RE = /(?:^|[^\w])(?:a\/|support\/|helpdesk\/)?solutions\/(?:articles\/)?(\d{1,20})(?!\d)/gi;

// Field names Freshdesk, Freshservice and this app's own payloads use for
// "the article that resolved this ticket", in priority order.
const ARTICLE_ID_FIELDS = [
  'associated_solution_article_id',
  'solution_article_id',
  'associated_article_id',
  'article_id'
];
const CUSTOM_ARTICLE_ID_FIELDS = ['cf_solution_article_id', 'cf_associated_solution_article_id'];

// Where a resolving agent leaves links. Order does not matter - every field
// is scanned and the distinct ids pooled.
const LINK_TEXT_FIELDS = ['resolution_note', 'resolution', 'internal_notes', 'notes', 'conversation', 'description', 'description_text'];

// Knowledge-base roots that carry no meaning of their own.
const KB_ROOTS = new Set(['solutions', 'solution', 'knowledge base', 'kb']);

const STAGE = 1;
const TAXONOMY_CONFIDENCE = 0.9;

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function articleIdsIn(text) {
  const ids = [];
  const re = new RegExp(ARTICLE_URL_RE.source, 'gi');
  let m = re.exec(String(text || ''));

  while (m !== null) {
    ids.push(m[1]);
    m = re.exec(String(text || ''));
  }

  return ids;
}

// A field may be a string, a conversation array, or a single note object.
function textsOf(value) {
  if (!present(value) && !Array.isArray(value)) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(textsOf);
  }

  if (typeof value === 'object') {
    return [value.body, value.body_text, value.text].filter(present).map(String);
  }

  return [String(value)];
}

function explicitArticleId(ticket) {
  const custom = ticket.custom_fields || {};
  const direct = ARTICLE_ID_FIELDS.find((f) => present(ticket[f]));

  if (direct) {
    return { id: String(ticket[direct]).trim(), field: direct };
  }

  const nested = CUSTOM_ARTICLE_ID_FIELDS.find((f) => present(custom[f]));

  return nested ? { id: String(custom[nested]).trim(), field: nested } : null;
}

function linkedArticleIds(ticket) {
  const texts = LINK_TEXT_FIELDS.flatMap((f) => textsOf(ticket[f]));

  return [...new Set(texts.flatMap(articleIdsIn))];
}

// ---- Category mapping ---------------------------------------------------

// "Solutions > Billing > Refunds" and { category: 'Billing', subcategory:
// 'Refunds' } both become ['billing', 'refunds']. Normalisation is the
// taxonomy's own, so wording is compared the same way everywhere.
function categoryPath(category, subcategory) {
  const parts = [category, subcategory]
    .filter(present)
    .flatMap((p) => String(p).split(/\s*(?:>|→|\/)\s*/))
    .map(tax.normalise)
    .filter((p) => p !== '');

  while (parts.length && KB_ROOTS.has(parts[0])) {
    parts.shift();
  }

  return parts;
}

function sameCategory(ticketPath, article) {
  const articlePath = categoryPath(article.category, article.subcategory);

  return articlePath.length === ticketPath.length
    && articlePath.every((p, i) => p === ticketPath[i]);
}

// Needs both levels: a bare category ("Billing") covers too many procedures
// for a structural match to mean anything.
function taxonomyCandidates(ticket, articles) {
  const ticketPath = categoryPath(ticket.category, ticket.subcategory);

  if (ticketPath.length < 2) {
    return [];
  }

  return articles.filter((a) => sameCategory(ticketPath, a));
}

// ---- Stage 1 ------------------------------------------------------------

function matched(articleId, method, confidence) {
  return { classification: 'ARTICLE_MATCH', article_id: String(articleId), method, stage: STAGE, confidence };
}

function unmatched(notes) {
  return { classification: null, stage: STAGE, notes };
}

async function existingIds(ids, articleExists) {
  const found = [];

  for (const id of ids) {
    if (await articleExists(id)) {
      found.push(id);
    }
  }

  return found;
}

// `articleExists(id)` is async so the Freshdesk ingest path can fall back to
// fetching an article it has not indexed yet; `articles` is the local KB used
// for the category mapping.
async function deterministicMatch(ticket, articles, articleExists) {
  const notes = [];
  const explicit = explicitArticleId(ticket);

  if (explicit !== null && await articleExists(explicit.id)) {
    return matched(explicit.id, 'associated_solution_article_id', 1);
  }
  if (explicit !== null) {
    notes.push(`${explicit.field}=${explicit.id} is not in the knowledge base`);
  }

  const linked = await existingIds(linkedArticleIds(ticket), articleExists);

  if (linked.length === 1) {
    return matched(linked[0], 'direct_solution_url', 1);
  }
  if (linked.length > 1) {
    notes.push(`ticket links ${linked.length} different articles: ${linked.join(', ')}`);
  }

  return taxonomyStep(ticket, articles, notes);
}

function taxonomyStep(ticket, articles, notes) {
  const byCategory = taxonomyCandidates(ticket, articles);

  if (byCategory.length === 1) {
    return matched(byCategory[0].article_id, 'taxonomy_category_mapping', TAXONOMY_CONFIDENCE);
  }
  if (byCategory.length > 1) {
    notes.push(`${byCategory.length} articles share the ticket's category`);
  }

  return unmatched(notes);
}

const api = {
  deterministicMatch,
  articleIdsIn,
  explicitArticleId,
  linkedArticleIds,
  categoryPath,
  ARTICLE_URL_RE
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
