// server/lib/vectorstore.js
// Matching stage 2's knowledge index: every KB article with its embedding,
// searched by cosine similarity.
//
// Brute force over an in-memory array, on purpose. A support knowledge base
// is hundreds to low thousands of articles, which a linear scan handles in
// milliseconds, and the FDK serverless runtime cannot load a native vector
// database anyway. Embeddings persist through an injected cache (the app's
// $db in production) keyed by article, and are only regenerated when the
// embedded text or the model changes.
'use strict';

const { normaliseKbArticle, articleEmbeddingText } = require('./query');
const { fnv1a } = require('./embeddings');

const STORED_PRECISION = 1e6;
const SCORE_PRECISION = 1e4;

// 64 bits from two differently-seeded FNV passes. This detects edits, it is
// not a security hash.
function contentHash(text) {
  const s = String(text);
  const a = fnv1a(s).toString(16).padStart(8, '0');
  const b = fnv1a(`${s.length}:${s}`).toString(16).padStart(8, '0');

  return `${a}${b}`;
}

// ---- Similarity ---------------------------------------------------------

// similarity(A, B) = (A . B) / (||A|| x ||B||). A zero vector is similar to
// nothing. Mismatched lengths mean the index and the query came from
// different models - an infrastructure fault, so it throws.
function assertComparable(a, b) {
  const ok = Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length > 0;

  if (!ok) {
    throw new Error(`cannot compare vectors of length ${(a || []).length} and ${(b || []).length}`);
  }
}

function cosineSimilarity(a, b) {
  assertComparable(a, b);

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- Indexing -----------------------------------------------------------

function compact(vec) {
  return vec.map((x) => Math.round(x * STORED_PRECISION) / STORED_PRECISION);
}

function reusable(cached, hash, model) {
  return cached !== null && cached !== undefined
    && cached.content_hash === hash
    && cached.model === model
    && Array.isArray(cached.embedding);
}

async function embeddingFor(article, embedder, cache, stats) {
  const hash = contentHash(articleEmbeddingText(article));
  const cached = await cache.get(article.article_id);

  if (reusable(cached, hash, embedder.model)) {
    stats.reused += 1;
    return { hash, embedding: cached.embedding };
  }

  const embedding = compact(await embedder.embedArticle(article));

  await cache.save(article.article_id, {
    article_id: article.article_id,
    content_hash: hash,
    model: embedder.model,
    embedding,
    updated_at: new Date().toISOString()
  });
  stats.embedded += 1;

  return { hash, embedding };
}

function uniqueArticles(articles) {
  const seen = new Set();

  return articles.map(normaliseKbArticle).filter((a) => {
    const fresh = a.article_id !== 'undefined' && !seen.has(a.article_id);

    seen.add(a.article_id);
    return fresh;
  });
}

// cache: { get(articleId) -> record | null, save(articleId, record) }
async function buildKnowledgeIndex(articles, embedder, cache) {
  const stats = { indexed: 0, reused: 0, embedded: 0 };
  const entries = [];

  for (const article of uniqueArticles(articles || [])) {
    const { hash, embedding } = await embeddingFor(article, embedder, cache, stats);

    entries.push(Object.assign({}, article, { embedding, content_hash: hash }));
    stats.indexed += 1;
  }

  return { entries, model: embedder.model, stats };
}

// ---- Search -------------------------------------------------------------

function byScore(a, b) {
  return b.score - a.score || (a.article_id < b.article_id ? -1 : 1);
}

// Two articles with identical content would otherwise take two of the three
// slots Claude gets to see. The first by score (then id) represents both.
function withoutDuplicates(ranked) {
  const seen = new Set();

  return ranked.filter((r) => {
    const fresh = !seen.has(r.content_hash);

    seen.add(r.content_hash);
    return fresh;
  });
}

function rounded(score) {
  return Math.round(score * SCORE_PRECISION) / SCORE_PRECISION;
}

// Returns the top K by similarity, and separately the ones that clear the
// threshold. Only `candidates` go on to the relevance gate; `top` exists so
// the funnel can report how close a miss was.
function searchKnowledge(index, queryEmbedding, topK, threshold) {
  const ranked = withoutDuplicates(index.entries
    .map((e) => ({ article_id: e.article_id, content_hash: e.content_hash, score: cosineSimilarity(queryEmbedding, e.embedding) }))
    .sort(byScore));

  const top = ranked.slice(0, topK).map((r) => ({ article_id: r.article_id, score: rounded(r.score) }));

  return {
    top,
    candidates: top.filter((r) => r.score >= threshold),
    topScore: top.length ? top[0].score : null
  };
}

const api = { buildKnowledgeIndex, searchKnowledge, cosineSimilarity, contentHash };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
