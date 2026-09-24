// server/lib/embeddings.js
// The embedding provider abstraction. Nothing else in the app knows how a
// vector is produced - callers get an embedder with embedText / embedArticle
// and a model name to key the cache on.
//
// Providers:
//   local   deterministic feature-hashing embedder. No network, no key, same
//           vector for the same text on every run. The default, the offline
//           fallback, and what the tests use.
//   voyage  Voyage AI embeddings through the "voyageEmbeddings" request
//           template (Anthropic's recommended embedding provider). The API
//           key lives in the secure iparam the template reads, never here.
//
// A provider that fails throws. The matcher turns that into
// MATCHING_UNAVAILABLE; it must never look like "no similar article".
'use strict';

const { articleEmbeddingText } = require('./query');

// ---- local: feature hashing ---------------------------------------------

const DIM = 512;
const BIGRAM_WEIGHT = 0.5;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'from',
  'with', 'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
  'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'your', 'our',
  'my', 'me', 'us', 'they', 'their', 'he', 'she', 'his', 'her', 'them', 'so',
  'then', 'there', 'here', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'can', 'could', 'should', 'if', 'not', 'no', 'yes', 'please',
  'subject', 'resolution', 'title', 'category', 'procedure', 'how'
]);

// Crude suffix folding: "refunds", "refunded" and "refunding" should land on
// the same feature, as should "cancelled" and "cancel". Deliberately
// conservative - a wrong fold merges words.
function stripSuffix(token) {
  const rules = [[/ies$/, 'y'], [/(?:ing|ed)$/, ''], [/(?:es|s)$/, '']];

  for (const [re, sub] of rules) {
    if (re.test(token) && token.replace(re, sub).length >= 4) {
      return token.replace(re, sub);
    }
  }

  return token;
}

function stem(token) {
  return stripSuffix(token).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// 32-bit FNV-1a.
function fnv1a(str) {
  let h = 0x811c9dc5;

  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h;
}

function features(text) {
  const toks = tokens(text);
  const counts = new Map();
  const add = (f, w) => counts.set(f, (counts.get(f) || 0) + w);

  toks.forEach((t, i) => {
    add(t, 1);
    if (i > 0) {
      add(`${toks[i - 1]}_${t}`, BIGRAM_WEIGHT);
    }
  });

  return counts;
}

function normalised(vec) {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));

  return norm === 0 ? vec : vec.map((x) => x / norm);
}

// Signed hashing: the sign bit keeps colliding features from only ever adding
// up, which would bias every pair of texts towards similarity.
function hashEmbed(text) {
  const vec = new Array(DIM).fill(0);

  for (const [feature, count] of features(text)) {
    const h = fnv1a(feature);
    const sign = (h & 0x80000000) ? -1 : 1;

    vec[h % DIM] += sign * (1 + Math.log(count));
  }

  return normalised(vec);
}

function localProvider(model) {
  return {
    provider: 'local',
    model,
    embed: (text) => Promise.resolve(hashEmbed(text))
  };
}

// ---- voyage -------------------------------------------------------------

function voyageProvider(model) {
  return {
    provider: 'voyage',
    model,
    embed: async (text, kind) => {
      const response = await $request.invokeTemplate('voyageEmbeddings', {
        body: JSON.stringify({ input: [text], model, input_type: kind })
      });
      const data = JSON.parse(response.response);

      return data && data.data && data.data[0] ? data.data[0].embedding : null;
    }
  };
}

// ---- The abstraction ----------------------------------------------------

function assertVector(vec, provider) {
  const ok = Array.isArray(vec) && vec.length > 0 && vec.every(Number.isFinite);

  if (!ok) {
    throw new Error(`embedding provider "${provider}" returned no usable vector`);
  }

  return vec;
}

// `impl` lets tests supply a provider of their own ({ provider, model, embed }).
function createEmbedder(cfg, impl) {
  const backend = impl || (cfg.embeddingProvider === 'voyage'
    ? voyageProvider(cfg.embeddingModel)
    : localProvider(cfg.embeddingModel));

  async function embedText(text, kind) {
    return assertVector(await backend.embed(String(text || ''), kind || 'query'), backend.provider);
  }

  return {
    provider: backend.provider,
    model: backend.model,
    embedText,
    embedArticle: (article) => embedText(articleEmbeddingText(article), 'document')
  };
}

const api = { createEmbedder, hashEmbed, tokens, fnv1a, DIM };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
