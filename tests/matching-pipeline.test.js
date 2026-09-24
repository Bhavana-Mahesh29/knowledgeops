// tests/matching-pipeline.test.js
// The matcher wired into server/server.js, driven through the FDK sandbox:
// the matchResolvedTicket method and onTicketUpdate, with Freshdesk,
// Anthropic and Voyage stubbed. Asserts which tickets reach the existing
// drift pipeline, which become knowledge gaps, and that an outage is neither.
import { describe, test, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadServer, createRenderData } = require('./sandbox.js');
const { hashEmbed } = require('../server/lib/embeddings.js');
const eventPayload = require('../server/test_data/support_ticket/onTicketUpdate.json');

const DATASET_ARTICLES = Object.values(require('../data/beta/articles.json'));
const RESOLVED = require('../data/beta/resolved_tickets.json');
const ticketById = (id) => RESOLVED.find((t) => t.ticket_id === id);

const TOKEN_ARTICLE_ID = '5001';
const TOKEN_ARTICLE_HTML = '<h2>Reset your security token</h2>'
  + '<p>Use this guide if your security token expired.</p>'
  + '<h3>Steps</h3>'
  + '<ol><li>Go to <b>Profile Settings</b> &rarr; <b>API &amp; Security Details</b> &rarr; <b>Reset Security Token</b>.</li>'
  + '<li>Choose <i>Confirm reset</i>.</li></ol>'
  + '<h3>Troubleshooting</h3><p>Contact support if missing.</p>';

const TOKEN_KB_ARTICLE = {
  id: TOKEN_ARTICLE_ID,
  title: 'Reset your security token',
  category: 'Account',
  subcategory: 'API Access',
  description: TOKEN_ARTICLE_HTML
};

const RESET_REPLY = 'Go to your profile, click Authentication, then Security, then reset security token. '
  + 'Write to me at agent@example.com if it fails.';
const NEW_PATH = ['Profile', 'Authentication', 'Security', 'Reset Security Token'];

function gateCall(body) {
  return Boolean(body.tools && body.tools[0].name === 'record_relevance_decision');
}

function candidateIdsIn(prompt) {
  return [...prompt.matchAll(/^article_id: (\S+)$/gm)].map((m) => m[1]);
}

// `gate(prompt, ids)` scripts Claude's relevance decision. Step extraction
// (the other tool call) and drafting fail on purpose, so drift runs on the
// offline fallbacks exactly as it does with no Anthropic key.
function createRequestApi({ gate, overrides } = {}) {
  const calls = [];
  const article = { id: TOKEN_ARTICLE_ID, title: TOKEN_KB_ARTICLE.title, description: TOKEN_ARTICLE_HTML };

  const handlers = Object.assign({
    anthropicMessages: (opts) => {
      const body = JSON.parse(opts.body);

      if (!gateCall(body) || !gate) {
        return Promise.reject({ status: 401, response: '{"error":"no key"}' });
      }

      const prompt = body.messages[0].content;

      return Promise.resolve({
        response: JSON.stringify({
          content: [{ type: 'tool_use', name: 'record_relevance_decision', input: gate(prompt, candidateIdsIn(prompt)) }]
        })
      });
    },
    fdGetTicket: (opts) => Promise.resolve({
      response: JSON.stringify({ id: Number(opts.context.ticket_id), status: 4, responder_id: 320, subject: 'Security token expired' })
    }),
    fdGetConversations: () => Promise.resolve({
      response: JSON.stringify([
        { incoming: true, private: false, body: '<p>My token expired</p>', body_text: 'My token expired' },
        { incoming: false, private: false, user_id: 320, body: `<p>${RESET_REPLY}</p>`, body_text: RESET_REPLY }
      ])
    }),
    fdGetArticle: (opts) => (String(opts.context.article_id) === TOKEN_ARTICLE_ID
      ? Promise.resolve({ response: JSON.stringify(article) })
      : Promise.reject({ status: 404, response: '{"code":"not_found"}' })),
    fdUpdateArticle: () => Promise.resolve({ status: 200, response: '{}' }),
    voyageEmbeddings: (opts) => {
      const body = JSON.parse(opts.body);

      return Promise.resolve({ response: JSON.stringify({ data: body.input.map((t) => ({ embedding: hashEmbed(t) })) }) });
    }
  }, overrides);

  return {
    calls,
    gateCalls: () => calls.filter((c) => c.template === 'anthropicMessages' && gateCall(JSON.parse(c.options.body))),
    api: {
      invokeTemplate(template, options = {}) {
        calls.push({ template, options });

        if (!handlers[template]) {
          return Promise.reject(new Error(`unknown template ${template}`));
        }

        return handlers[template](options);
      }
    }
  };
}

const IPARAMS = { demo_mode: true, publish_mode: 'demo' };

// Dataset article 9001 covers the same topic as 5001, so retrieval offers
// both; the scripted gate picks 5001, as a relevance judge would for the
// article whose steps match the reply.
function picksTokenArticle(_prompt, ids) {
  return ids.includes(TOKEN_ARTICLE_ID)
    ? { decision: 'MATCH', article_id: TOKEN_ARTICLE_ID, confidence: 0.94, reason: 'resolution resets the security token' }
    : { decision: 'NO_MATCH', article_id: null, confidence: 0.1, reason: 'not offered' };
}

describe('ticket-to-article matching in the server', () => {
  let renderData;

  beforeEach(() => {
    renderData = createRenderData();
  });

  async function serverWithKb(requestOptions) {
    const requests = createRequestApi(requestOptions);
    const env = loadServer({ $request: requests.api, renderData });
    const indexed = await renderData.call(() => env.methods.indexKnowledgeBase({
      articles: [...DATASET_ARTICLES, TOKEN_KB_ARTICLE],
      iparams: IPARAMS
    }));

    return { env, requests, indexed };
  }

  const match = (env, args) => renderData.call(() => env.methods.matchResolvedTicket(Object.assign({ iparams: IPARAMS }, args)));
  const storedTicket = (env, id) => {
    const row = env.db.rows.get(`tickets:${id}`);

    return row ? JSON.parse(row.value) : null;
  };

  test('the knowledge base is indexed once and then served from the cache', async () => {
    const { env, indexed } = await serverWithKb();

    expect(indexed).toMatchObject({ provider: 'local', indexed: 9, embedded: 9, reused: 0 });

    const again = await renderData.call(() => env.methods.indexKnowledgeBase({ iparams: IPARAMS }));

    expect(again).toMatchObject({ indexed: 9, embedded: 0, reused: 9 });
    expect(JSON.parse(env.db.rows.get('embeddings:9005').value)).toMatchObject({ article_id: '9005', model: 'hash-512-v1' });
  });

  test('explicit article -> direct match -> drift pipeline', async () => {
    const { env, requests } = await serverWithKb();
    const result = await match(env, {
      ticket_id: 'T-1001',
      subject: 'Token expired',
      resolution_note: RESET_REPLY,
      associated_solution_article_id: TOKEN_ARTICLE_ID,
      agent_id: 320
    });

    expect(result).toMatchObject({
      ticket_id: 'T-1001',
      classification: 'ARTICLE_MATCH',
      article_id: TOKEN_ARTICLE_ID,
      method: 'associated_solution_article_id',
      stage: 1,
      confidence: 1
    });
    expect(requests.gateCalls()).toHaveLength(0);

    // The existing drift pipeline ran on the matched article and raised the
    // same alert a linked Freshdesk ticket raises.
    expect(result.drift.canonicalPath).toEqual(NEW_PATH);
    expect(result.drift.alerts).toHaveLength(1);
    expect(result.drift.alerts[0]).toMatchObject({ band: 'critical', patchPassed: true });
    expect(storedTicket(env, 'T-1001')).toMatchObject({ articleId: TOKEN_ARTICLE_ID, linkType: 'explicit', matchStage: 1 });
    expect(storedTicket(env, 'T-1001').redactedText).not.toContain('agent@example.com');
  });

  // Regression: stored articles carry `articleId`, dataset ones `article_id`.
  // The category mapping once returned article_id "undefined" in the server.
  test('a category mapping resolves against stored articles', async () => {
    const { env } = await serverWithKb();
    const result = await match(env, ticketById('R-203'));

    expect(result).toMatchObject({ classification: 'ARTICLE_MATCH', article_id: '9003', method: 'taxonomy_category_mapping', stage: 1 });
    expect(result.drift.articleId).toBe('9003');
    expect(storedTicket(env, 'R-203')).toMatchObject({ articleId: '9003', linkType: 'taxonomy' });
  });

  test('no explicit article -> vector search -> top 3 -> Claude MATCH -> drift pipeline', async () => {
    const { env, requests } = await serverWithKb({
      gate: picksTokenArticle
    });
    const result = await match(env, {
      ticket_id: 'T-1003',
      subject: 'Security token expired',
      resolution_note: RESET_REPLY,
      agent_id: 320
    });

    expect(result).toMatchObject({
      classification: 'ARTICLE_MATCH',
      article_id: TOKEN_ARTICLE_ID,
      method: 'semantic_llm_gate',
      stage: 3,
      confidence: 0.94
    });
    const chosen = result.candidates.find((c) => c.article_id === TOKEN_ARTICLE_ID);

    expect(result.candidates.map((c) => c.article_id)).toContain('9001');
    expect(result.semantic_score).toBe(chosen.score);

    // Claude saw the ticket and <= 3 retrieved candidates - not the KB.
    const gate = requests.gateCalls();

    expect(gate).toHaveLength(1);

    const prompt = JSON.parse(gate[0].options.body).messages[0].content;

    expect(candidateIdsIn(prompt).length).toBeLessThanOrEqual(3);
    expect(candidateIdsIn(prompt)).toEqual(result.candidates.map((c) => c.article_id));
    expect(prompt).not.toContain('How to update a billing address');
    expect(prompt).not.toContain('agent@example.com');
    expect(prompt).toContain('[ANONYMIZED_EMAIL]');

    // Drift analysis ran on the chosen article. A semantic link is not an
    // explicit one, so on its own it cannot clear the N gate.
    expect(result.drift.articleId).toBe(TOKEN_ARTICLE_ID);
    expect(result.drift.canonicalPath).toEqual(NEW_PATH);
    expect(result.drift.alerts).toEqual([]);
    expect(storedTicket(env, 'T-1003')).toMatchObject({ linkType: 'semantic', matchMethod: 'semantic_llm_gate', matchConfidence: 0.94 });
  });

  test('a KB-only article (not in Freshdesk) is drift-checked against its stored copy', async () => {
    const { env } = await serverWithKb({
      gate: (_prompt, ids) => ({ decision: 'MATCH', article_id: ids[0], confidence: 0.9, reason: 'partial refund' })
    });
    const result = await match(env, ticketById('R-204'));

    expect(result).toMatchObject({ classification: 'ARTICLE_MATCH', article_id: '9005', stage: 3 });
    expect(result.drift.articleId).toBe('9005');
    expect(result.drift_error).toBeUndefined();
  });

  test('no explicit article -> vector search -> top 3 -> Claude NO_MATCH -> KNOWLEDGE_GAP', async () => {
    const { env, requests } = await serverWithKb({
      gate: () => ({ decision: 'NO_MATCH', article_id: null, confidence: 0.31, reason: 'none describes a chargeback response' })
    });
    const result = await match(env, ticketById('R-210'));

    expect(result).toMatchObject({ classification: 'KNOWLEDGE_GAP', method: 'no_relevant_article', stage: 3 });
    expect(result.drift).toBeUndefined();
    expect(result.knowledge_gap).toMatchObject({ ticketId: 'R-210', recommendedAction: 'create_article', method: 'no_relevant_article' });
    expect(storedTicket(env, 'R-210')).toBeNull();
    expect(requests.calls.filter((c) => c.template === 'fdGetArticle')).toHaveLength(0);

    const gaps = await renderData.call(() => env.methods.listKnowledgeGaps({}));

    expect(gaps.map((g) => g.ticketId)).toEqual(['R-210']);
  });

  test('no explicit article -> vector search -> no candidates -> KNOWLEDGE_GAP, Claude never called', async () => {
    const { env, requests } = await serverWithKb({ gate: () => ({ decision: 'MATCH', article_id: '9005', confidence: 1, reason: 'x' }) });
    const result = await match(env, ticketById('R-208'));

    expect(result).toMatchObject({ classification: 'KNOWLEDGE_GAP', method: 'no_semantic_match', semantic_result: 'NO_SEMANTIC_MATCH', stage: 2 });
    expect(requests.gateCalls()).toHaveLength(0);
    expect(result.knowledge_gap.ruledOut).toHaveLength(3);
  });

  test('Claude being down is MATCHING_UNAVAILABLE - no gap, no drift', async () => {
    const { env } = await serverWithKb();
    const result = await match(env, ticketById('R-204'));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method: 'relevance_gate_failed', stage: 3 });
    expect(result.knowledge_gap).toBeUndefined();
    expect(result.drift).toBeUndefined();
    expect(await renderData.call(() => env.methods.listKnowledgeGaps({}))).toEqual([]);
  });

  test('Claude naming an article it was not offered is MATCHING_UNAVAILABLE', async () => {
    const { env } = await serverWithKb({ gate: () => ({ decision: 'MATCH', article_id: '9001', confidence: 0.99, reason: 'x' }) });
    const result = await match(env, ticketById('R-204'));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method: 'relevance_gate_invalid_output' });
    expect(result.article_id).toBeUndefined();
  });

  test('an embedding outage is MATCHING_UNAVAILABLE', async () => {
    const { env } = await serverWithKb({
      overrides: { voyageEmbeddings: () => Promise.reject({ status: 503, response: 'down' }) }
    });
    const result = await match(env, Object.assign({}, ticketById('R-204'), {
      iparams: Object.assign({ embedding_provider: 'voyage' }, IPARAMS)
    }));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method: 'embedding_failed', stage: 2 });
  });

  test('the voyage provider embeds through its template and caches per model', async () => {
    const { env, requests } = await serverWithKb({
      gate: (_p, ids) => ({ decision: 'MATCH', article_id: ids[0], confidence: 0.9, reason: 'x' })
    });
    const voyage = Object.assign({ embedding_provider: 'voyage', semantic_match_threshold: '0.3' }, IPARAMS);

    await renderData.call(() => env.methods.indexKnowledgeBase({ iparams: voyage }));

    const embeddedAfterIndex = requests.calls.filter((c) => c.template === 'voyageEmbeddings').length;
    const result = await match(env, Object.assign({}, ticketById('R-204'), { iparams: voyage }));
    const voyageCalls = requests.calls.filter((c) => c.template === 'voyageEmbeddings');

    expect(embeddedAfterIndex).toBe(9);
    expect(voyageCalls).toHaveLength(10);
    expect(JSON.parse(voyageCalls[9].options.body)).toMatchObject({ model: 'voyage-3.5', input_type: 'query' });
    expect(result).toMatchObject({ classification: 'ARTICLE_MATCH', article_id: '9005' });
  });

  test('the funnel is counted', async () => {
    const { env } = await serverWithKb({
      gate: (_p, ids) => ({ decision: 'MATCH', article_id: ids[0], confidence: 0.9, reason: 'x' })
    });

    await match(env, Object.assign({ run_drift: false }, ticketById('R-201')));
    await match(env, Object.assign({ run_drift: false }, ticketById('R-204')));
    await match(env, Object.assign({ run_drift: false }, ticketById('R-208')));

    const totals = await renderData.call(() => env.methods.getMatchMetrics({}));

    expect(totals).toMatchObject({
      tickets: 3,
      stage_1_attempted: 3,
      stage_1_matched: 1,
      stage_2_executed: 2,
      stage_3_executed: 1,
      stage_3_match: 1,
      knowledge_gap: 1,
      matching_unavailable: 0
    });
  });

  describe('onTicketUpdate', () => {
    function unlinkedEvent(id) {
      const payload = JSON.parse(JSON.stringify(eventPayload));

      payload.data.ticket.id = id;
      payload.data.ticket.status = 4;
      payload.data.ticket.responder_id = 320;
      payload.data.ticket.subject = 'Security token expired';
      payload.iparams = IPARAMS;

      return payload;
    }

    test('a resolved ticket with no article link is matched semantically and drift-checked', async () => {
      const { env } = await serverWithKb({ gate: picksTokenArticle });

      await env.methods.onTicketUpdateHandler(unlinkedEvent(305));

      expect(storedTicket(env, 305)).toMatchObject({ articleId: TOKEN_ARTICLE_ID, linkType: 'semantic', status: 'ok' });
    });

    test('with Claude unavailable it is skipped, not recorded as a gap', async () => {
      const { env } = await serverWithKb();

      await expect(env.methods.onTicketUpdateHandler(unlinkedEvent(306))).resolves.toBeUndefined();

      expect(storedTicket(env, 306)).toBeNull();
      expect(await renderData.call(() => env.methods.listKnowledgeGaps({}))).toEqual([]);
      expect((await renderData.call(() => env.methods.getMatchMetrics({}))).matching_unavailable).toBe(1);
    });

    test('a dead article link falls through to semantic matching', async () => {
      const { env, requests } = await serverWithKb({
        gate: picksTokenArticle,
        overrides: {
          fdGetConversations: () => Promise.resolve({
            response: JSON.stringify([{
              incoming: false,
              private: false,
              body: `<p>${RESET_REPLY} https://x.freshdesk.com/a/solutions/articles/424242</p>`,
              body_text: RESET_REPLY
            }])
          })
        }
      });

      await env.methods.onTicketUpdateHandler(unlinkedEvent(307));

      expect(requests.gateCalls()).toHaveLength(1);
      expect(storedTicket(env, 307)).toMatchObject({ articleId: TOKEN_ARTICLE_ID, linkType: 'semantic' });
    });

    // A copy synced from Freshdesk earlier (another helpdesk, or since
    // deleted) must not keep winning matches after Freshdesk stops having it.
    test('a stored article Freshdesk no longer has is dropped and the ticket re-matched', async () => {
      const GHOST = '1130000051335';
      const { env, requests } = await serverWithKb({
        gate: (_prompt, ids) => (ids.includes(GHOST)
          ? { decision: 'MATCH', article_id: GHOST, confidence: 0.75, reason: 'same topic' }
          : picksTokenArticle(_prompt, ids))
      });
      const index = () => JSON.parse(env.db.rows.get('index:articles').value);

      env.db.rows.set(`articles:${GHOST}`, {
        value: JSON.stringify({
          articleId: GHOST,
          title: 'How to Reset Your Account Security Token',
          markdown: '## Steps\n\n1. Navigate to your **Profile**.\n\n2. Click **Authentication**.\n\n3. Click **Security**.\n\n4. Click **Reset Security Token**.',
          documentedPath: ['node_profile', 'node_auth', 'node_security', 'node_reset']
        })
      });
      env.db.rows.set('index:articles', { value: JSON.stringify([...index(), GHOST]) });

      await env.methods.onTicketUpdateHandler(unlinkedEvent(308));

      expect(requests.calls.some((c) => c.template === 'fdGetArticle'
        && String(c.options.context.article_id) === GHOST)).toBe(true);
      expect(index()).not.toContain(GHOST);
      expect(storedTicket(env, 308)).toMatchObject({ articleId: TOKEN_ARTICLE_ID });
    });
  });
});

// The Freshdesk automation webhook (local development under `fdk run
// --tunnel`) and the drift verdict printed to the terminal.
describe('automatic ingestion via webhook, and the terminal verdict', () => {
  const ARTICLE_LINK = `https://x.freshdesk.com/support/solutions/articles/${TOKEN_ARTICLE_ID}`;

  function linkedRequests(ticketStatus) {
    return createRequestApi({
      overrides: {
        fdGetTicket: (opts) => Promise.resolve({
          response: JSON.stringify({ id: Number(opts.context.ticket_id), status: ticketStatus, responder_id: 320, subject: 'Token expired' })
        }),
        fdGetConversations: () => Promise.resolve({
          response: JSON.stringify([{ incoming: false, private: false, body: `<p>${RESET_REPLY} ${ARTICLE_LINK}</p>`, body_text: RESET_REPLY }])
        })
      }
    });
  }

  function captureConsole(env) {
    const lines = [];

    env.sandbox.console = {
      info: (m) => lines.push(String(m)),
      error: (m) => lines.push(String(m)),
      log: (m) => lines.push(String(m))
    };
    return lines;
  }

  test.each([
    [{ ticket_id: '#9' }],
    [{ ticket: { id: 9 } }],
    [{ freshdesk_webhook: { ticket_id: '9' } }],
    [JSON.stringify({ ticket_id: 9 })]
  ])('a resolved-ticket webhook %j ingests the ticket', async (data) => {
    const requests = linkedRequests(4);
    const env = loadServer({ $request: requests.api, renderData: createRenderData() });

    await env.methods.onExternalEventHandler({ data, iparams: IPARAMS });

    const got = requests.calls.find((c) => c.template === 'fdGetTicket');

    expect(got.options.context.ticket_id).toBe('9');
    expect(env.db.rows.get('tickets:9')).toBeDefined();
  });

  test('the ticket status is re-read from Freshdesk, not trusted from the body', async () => {
    const requests = linkedRequests(2);
    const env = loadServer({ $request: requests.api, renderData: createRenderData() });

    await env.methods.onExternalEventHandler({ data: { ticket_id: 9, status: 'Resolved' }, iparams: IPARAMS });

    expect(env.db.rows.get('tickets:9')).toBeUndefined();
    expect(requests.calls.some((c) => c.template === 'fdGetConversations')).toBe(false);
  });

  test('a webhook without a ticket id is skipped, not thrown', async () => {
    const requests = linkedRequests(4);
    const env = loadServer({ $request: requests.api, renderData: createRenderData() });
    const lines = captureConsole(env);

    await expect(env.methods.onExternalEventHandler({ data: { hello: 1 } })).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('webhook body carried no ticket id');
  });

  test('the terminal says PROCEDURAL DRIFT, with both paths, when an alert is raised', async () => {
    const requests = linkedRequests(4);
    const env = loadServer({ $request: requests.api, renderData: createRenderData() });
    const lines = captureConsole(env);

    await env.methods.onExternalEventHandler({ data: { ticket_id: 9 }, iparams: IPARAMS });

    const report = lines.find((l) => l.startsWith('[knowledgeops] drift: ticket 9'));

    expect(report).toContain(`article ${TOKEN_ARTICLE_ID} "Reset your security token"`);
    expect(report).toContain('documented path : Profile Settings → API & Security Details → Reset Security Token');
    expect(report).toContain('agent\'s path    : Profile → Authentication → Security → Reset Security Token');
    expect(report).toContain('verdict         : PROCEDURAL DRIFT - critical alert raised (confidence 1.00), validated patch drafted');
  });

  test('the terminal says NO DRIFT when the agent followed the article', async () => {
    const followed = 'Go to Profile, then Authentication, then Security, then Reset Security Token.';
    const html = '<h2>Reset</h2><h3>Steps</h3><ol><li>Go to <b>Profile</b> &rarr; <b>Authentication</b> &rarr; '
      + '<b>Security</b> &rarr; <b>Reset Security Token</b>.</li></ol>';
    const requests = createRequestApi({
      overrides: {
        fdGetArticle: () => Promise.resolve({ response: JSON.stringify({ id: TOKEN_ARTICLE_ID, title: 'Reset', description: html }) }),
        fdGetConversations: () => Promise.resolve({
          response: JSON.stringify([{ incoming: false, private: false, body: `<p>${followed} ${ARTICLE_LINK}</p>`, body_text: followed }])
        })
      }
    });
    const env = loadServer({ $request: requests.api, renderData: createRenderData() });
    const lines = captureConsole(env);

    await env.methods.onExternalEventHandler({ data: { ticket_id: 9 }, iparams: IPARAMS });

    expect(lines.find((l) => l.startsWith('[knowledgeops] drift: ticket 9'))).toContain('verdict         : NO DRIFT');
  });

  test('a knowledge gap says there was no drift check', async () => {
    const requests = createRequestApi({ gate: () => ({ decision: 'NO_MATCH', article_id: null, confidence: 0.2, reason: 'x' }) });
    const renderData = createRenderData();
    const env = loadServer({ $request: requests.api, renderData });

    await renderData.call(() => env.methods.indexKnowledgeBase({ articles: DATASET_ARTICLES, iparams: IPARAMS }));

    const lines = captureConsole(env);

    await renderData.call(() => env.methods.matchResolvedTicket(Object.assign({ iparams: IPARAMS }, ticketById('R-210'))));

    expect(lines.find((l) => l.startsWith('[knowledgeops] drift: ticket R-210'))).toContain('no drift check: knowledge gap');
  });
});
