// scripts/match-demo.js - run with `npm run demo:match`.
// Walks the beta dataset through the matchResolvedTicket serverless method,
// loaded in the same FDK sandbox stand-in the tests use, and prints each
// ticket's funnel.
//
//   ANTHROPIC_API_KEY set  -> stage 3 calls Claude for real
//   ANTHROPIC_API_KEY unset -> stage 3 uses an offline stand-in (title-word
//                              overlap), labelled as such in the output
//   VOYAGE_API_KEY set      -> embeddings come from Voyage instead of the
//                              local hashing provider
//
// Matcher settings can be overridden with the same environment variables the
// iparams mirror: SEMANTIC_MATCH_THRESHOLD, SEMANTIC_TOP_K, EMBEDDING_MODEL,
// RELEVANCE_MODEL, RELEVANCE_MIN_CONFIDENCE. Keys are only ever put in request
// headers; nothing here prints them.
'use strict';

const { loadServer, createRenderData } = require('../tests/sandbox');
const { envOverrides } = require('../server/lib/matchconfig');
const { tokens } = require('../server/lib/embeddings');

const ARTICLES = Object.values(require('../data/beta/articles.json'));
const TICKETS = require('../data/beta/resolved_tickets.json');

const LIVE_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY);
const LIVE_VOYAGE = Boolean(process.env.VOYAGE_API_KEY);

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();

  if (!res.ok) {
    throw { status: res.status, response: text.slice(0, 300) };
  }
  return { status: res.status, response: text };
}

// Offline stand-in for the relevance gate: MATCH the candidate whose title
// shares the most content words with the resolution, if it shares at least
// two; otherwise NO_MATCH. Crude, deterministic, and only for running the
// demo without a key.
function offlineGate(body) {
  const prompt = body.messages[0].content;
  const resolution = new Set(tokens((/^resolution: (.*)$/m.exec(prompt) || [])[1]));
  const blocks = [...prompt.matchAll(/^article_id: (\S+)\ntitle: (.*)$/gm)];
  const scored = blocks
    .map(([, id, title]) => ({ id, overlap: tokens(title).filter((t) => resolution.has(t)).length }))
    .sort((a, b) => b.overlap - a.overlap);
  const best = scored[0];
  const input = best && best.overlap >= 2
    ? { decision: 'MATCH', article_id: best.id, confidence: 0.9, reason: `offline stand-in: ${best.overlap} title words appear in the resolution` }
    : { decision: 'NO_MATCH', article_id: null, confidence: 0.2, reason: 'offline stand-in: no candidate title describes the resolution' };

  return { response: JSON.stringify({ content: [{ type: 'tool_use', name: 'record_relevance_decision', input }] }) };
}

const templates = {
  anthropicMessages(opts) {
    const body = JSON.parse(opts.body);
    const isGate = Boolean(body.tools && body.tools[0].name === 'record_relevance_decision');

    if (LIVE_CLAUDE) {
      return post('https://api.anthropic.com/v1/messages', {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }, opts.body);
    }
    // Without a key, extraction and drafting fall back exactly as the app does.
    return isGate ? Promise.resolve(offlineGate(body)) : Promise.reject({ status: 401, response: 'no key' });
  },
  voyageEmbeddings(opts) {
    return post('https://api.voyageai.com/v1/embeddings', {
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'content-type': 'application/json'
    }, opts.body);
  },
  // The dataset articles are not in any Freshdesk; drift runs on the stored copy.
  fdGetArticle: () => Promise.reject({ status: 404, response: 'not in Freshdesk' })
};

function brief(result) {
  const keys = ['ticket_id', 'classification', 'article_id', 'method', 'stage', 'semantic_score', 'confidence', 'candidates', 'reason'];

  return keys.reduce((o, k) => (result[k] === undefined ? o : Object.assign(o, { [k]: result[k] })), {});
}

async function main() {
  const renderData = createRenderData();
  const env = loadServer({
    renderData,
    console: { info() {}, error: console.error, log: console.log },
    $request: {
      invokeTemplate: (name, opts) => (templates[name] ? templates[name](opts) : Promise.reject(new Error(`no template ${name}`)))
    }
  });
  const iparams = Object.assign({ demo_mode: true, embedding_provider: LIVE_VOYAGE ? 'voyage' : 'local' }, toIparams(envOverrides(process.env)));
  const call = (method, args) => renderData.call(() => env.methods[method](Object.assign({ iparams }, args)));

  console.log(`Relevance gate: ${LIVE_CLAUDE ? 'Claude (live)' : 'OFFLINE STAND-IN (set ANTHROPIC_API_KEY for Claude)'}`);
  console.log(`Embeddings:     ${LIVE_VOYAGE ? 'Voyage (live)' : 'local hashing provider'}`);
  console.log('Indexed:       ', JSON.stringify(await call('indexKnowledgeBase', { articles: ARTICLES })));

  for (const ticket of TICKETS) {
    const result = await call('matchResolvedTicket', ticket);

    console.log(`\n${result.trace.join('\n  ')}`);
    console.log(`  => ${JSON.stringify(brief(result))}`);
    if (result.drift) {
      console.log(`  drift: article ${result.drift.articleId}, path walked ${JSON.stringify(result.drift.canonicalPath)}, alerts ${result.drift.alerts.length}`);
    }
    if (result.knowledge_gap) {
      console.log(`  knowledge gap recorded: ${result.knowledge_gap.recommendedAction}`);
    }
  }

  console.log(`\nFunnel totals: ${JSON.stringify(await call('getMatchMetrics', {}))}`);
}

// matchconfig override names -> the iparam keys the server reads.
function toIparams(overrides) {
  const keys = {
    semanticThreshold: 'semantic_match_threshold',
    topK: 'semantic_top_k',
    embeddingProvider: 'embedding_provider',
    embeddingModel: 'embedding_model',
    relevanceModel: 'relevance_model',
    relevanceMinConfidence: 'relevance_min_confidence'
  };

  return Object.fromEntries(Object.entries(overrides).map(([k, v]) => [keys[k], v]));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
