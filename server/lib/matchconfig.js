// server/lib/matchconfig.js
// Every tunable of the ticket-to-article matcher, in one place.
//
// Resolution order for each setting: explicit override -> installation
// parameter -> default. FDK serverless functions get their configuration
// through iparams and have no environment (the FDK linter rejects
// process.env under server/), so environment variables are read by the
// caller - a script or test running under plain node - and passed in as
// overrides with envOverrides(process.env).
'use strict';

// Claude only ever sees this many candidates, whatever the configuration.
const MAX_CANDIDATES = 3;

// Similarity scores are not comparable across embedding models. The local
// hashing embedder spreads related texts much lower on the cosine scale than
// a neural model does, so each provider carries its own default; an explicit
// SEMANTIC_MATCH_THRESHOLD always wins.
const PROVIDERS = {
  voyage: { model: 'voyage-3.5', threshold: 0.80 },
  local: { model: 'hash-512-v1', threshold: 0.30 }
};
const DEFAULT_PROVIDER = 'local';

const DEFAULTS = {
  topK: MAX_CANDIDATES,
  relevanceModel: 'claude-sonnet-5',
  relevanceMinConfidence: 0.70
};

// setting name -> [iparam key, environment variable]
const SOURCES = {
  semanticThreshold: ['semantic_match_threshold', 'SEMANTIC_MATCH_THRESHOLD'],
  topK: ['semantic_top_k', 'SEMANTIC_TOP_K'],
  embeddingProvider: ['embedding_provider', 'EMBEDDING_PROVIDER'],
  embeddingModel: ['embedding_model', 'EMBEDDING_MODEL'],
  relevanceModel: ['relevance_model', 'RELEVANCE_MODEL'],
  relevanceMinConfidence: ['relevance_min_confidence', 'RELEVANCE_MIN_CONFIDENCE']
};

function blank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function raw(name, overrides, iparams) {
  return [overrides[name], iparams[SOURCES[name][0]]].find((v) => !blank(v));
}

// { SEMANTIC_MATCH_THRESHOLD: '0.8', ... } -> { semanticThreshold: '0.8', ... }
function envOverrides(env) {
  const out = {};

  for (const [name, [, envKey]] of Object.entries(SOURCES)) {
    if (env && !blank(env[envKey])) {
      out[name] = env[envKey];
    }
  }

  return out;
}

function numberIn(value, min, max, fallback) {
  const n = Number(value);

  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function resolveMatchConfig(iparams, overrides) {
  const o = overrides || {};
  const ip = iparams || {};
  const get = (name) => raw(name, o, ip);

  const requested = String(get('embeddingProvider') || DEFAULT_PROVIDER).trim().toLowerCase();
  const provider = PROVIDERS[requested] ? requested : DEFAULT_PROVIDER;
  const defaults = PROVIDERS[provider];

  return {
    embeddingProvider: provider,
    embeddingModel: String(get('embeddingModel') || defaults.model),
    semanticThreshold: numberIn(get('semanticThreshold'), -1, 1, defaults.threshold),
    topK: Math.min(MAX_CANDIDATES, Math.floor(numberIn(get('topK'), 1, MAX_CANDIDATES, DEFAULTS.topK))),
    relevanceModel: String(get('relevanceModel') || DEFAULTS.relevanceModel),
    relevanceMinConfidence: numberIn(get('relevanceMinConfidence'), 0, 1, DEFAULTS.relevanceMinConfidence)
  };
}

const api = { resolveMatchConfig, envOverrides, MAX_CANDIDATES, PROVIDERS };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
