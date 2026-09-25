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
  + '<ol><li>Go to <b>Settings</b> &rarr; <b>Security</b> &rarr; <b>Authentication</b>, then choose <i>Reset security token</i>.</li>'
  + '<li>Choose <i>Confirm reset</i>.</li></ol>'
  + '<h3>Troubleshooting</h3><p>Contact support if missing.</p>';

const TOKEN_KB_ARTICLE = {
  id: TOKEN_ARTICLE_ID,
  title: 'Reset your security token',
  category: 'Account',
  subcategory: 'API Access',
  description: TOKEN_ARTICLE_HTML
};

const RESET_REPLY = 'Go to Settings, click Security, then Two-Step Verification, then reset security token. '
  + 'Write to me at agent@example.com if it fails.';
const NEW_PATH = ['Settings', 'Security', 'Two-Step Verification'];

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
    fdCreateArticle: () => Promise.resolve({ status: 201, response: JSON.stringify({ id: 777 }) }),
    vobizMakeCall: () => Promise.resolve({ status: 200, response: JSON.stringify({ api_id: 'a', request_uuid: 'call-1', message: 'Call fired' }) }),
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

  describe('Freddy AI actions', () => {
    const action = (env, name, args) => renderData.call(() => env.methods[name](Object.assign({ iparams: IPARAMS }, args)));
    const ARTICLE_LINK = `https://x.freshdesk.com/support/solutions/articles/${TOKEN_ARTICLE_ID}`;
    const linkedConversation = {
      fdGetConversations: () => Promise.resolve({
        response: JSON.stringify([{ incoming: false, private: false, body: `<p>${RESET_REPLY} ${ARTICLE_LINK}</p>`, body_text: RESET_REPLY }])
      })
    };

    test('a resolved ticket nobody analysed yet is run through the pipeline and reported as high drift', async () => {
      const { env } = await serverWithKb({ overrides: linkedConversation });
      const result = await action(env, 'checkTicketFreshness', { ticket_id: '#1042' });

      expect(result).toMatchObject({
        ticket_id: '1042',
        freshness: 'high_drift',
        is_stale: true,
        article_id: TOKEN_ARTICLE_ID,
        article_title: 'Reset your security token',
        published_path: 'Settings → Security → Authentication',
        agent_path: 'Settings → Security → Two-Step Verification',
        followed_article: false,
        changed_step: 'Authentication → Two-Step Verification',
        evidence: 'Confirmed by 1 agent(s) across 1 ticket(s) (100% convergence)',
        admin_notified: false
      });
      expect(result.alert_id).toMatch(new RegExp(`^${TOKEN_ARTICLE_ID}-`));
      expect(result.summary).toContain('High knowledge drift on article "Reset your security token"');
      expect(result.recommended_action).toContain('KnowledgeOps board');
      expect(storedTicket(env, '1042')).toMatchObject({ articleId: TOKEN_ARTICLE_ID });
    });

    test('a ticket the resolve event already analysed is answered from the store', async () => {
      const { env, requests } = await serverWithKb({ overrides: linkedConversation });

      await action(env, 'checkTicketFreshness', { ticket_id: '1043' });
      const fetched = requests.calls.filter((c) => c.template === 'fdGetTicket').length;
      const again = await action(env, 'checkTicketFreshness', { ticket_id: '1043' });

      expect(requests.calls.filter((c) => c.template === 'fdGetTicket')).toHaveLength(fetched);
      expect(again.freshness).toBe('high_drift');
    });

    test('an unresolved ticket is not checked', async () => {
      const { env } = await serverWithKb({
        overrides: {
          fdGetTicket: (opts) => Promise.resolve({ response: JSON.stringify({ id: Number(opts.context.ticket_id), status: 2, responder_id: 320 }) })
        }
      });
      const result = await action(env, 'checkTicketFreshness', { ticket_id: '1044' });

      expect(result).toMatchObject({ freshness: 'not_checked', is_stale: false });
      expect(result.summary).toContain('not resolved or closed');
    });

    test('a resolution no article covers comes back as a knowledge gap with its draft', async () => {
      const { env } = await serverWithKb({ gate: () => ({ decision: 'NO_MATCH', article_id: null, confidence: 0.2, reason: 'x' }) });
      const result = await action(env, 'checkTicketFreshness', { ticket_id: '1045' });

      expect(result).toMatchObject({ ticket_id: '1045', freshness: 'knowledge_gap', is_stale: true, alert_id: 'gap-1045' });
      expect(result.summary).toContain('KnowledgeOps drafted a new article');
    });

    test('article freshness is a read-only lookup', async () => {
      const { env } = await serverWithKb({ overrides: linkedConversation });

      await action(env, 'checkTicketFreshness', { ticket_id: '1046' });

      const stale = await action(env, 'getArticleFreshness', { article_id: TOKEN_ARTICLE_ID });
      const fresh = await action(env, 'getArticleFreshness', { article_id: '9003' });

      expect(stale).toMatchObject({ freshness: 'high_drift', is_stale: true, article_id: TOKEN_ARTICLE_ID });
      expect(fresh).toMatchObject({ freshness: 'fresh', is_stale: false, recommended_action: expect.stringContaining('No action needed') });
      await expect(action(env, 'getArticleFreshness', { article_id: 'nope' })).rejects.toMatchObject({ status: 404 });
    });

    test('a missing ticket id is a 400, not a crash', async () => {
      const { env } = await serverWithKb();

      await expect(action(env, 'checkTicketFreshness', { ticket_id: ' ' })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('phone alerts through Vobiz', () => {
    const call = (env, name, args) => renderData.call(() => env.methods[name](Object.assign({ iparams: IPARAMS }, args)));
    const VOICE = Object.assign({
      vobiz_auth_id: 'MA_TEST',
      vobiz_auth_token: 'secret',
      vobiz_from_number: '+91 80642 61580',
      voice_relay_url: 'https://relay.example.com/',
      admin_phone: '+919800000001',
      dept_heads: 'default = Support Ops | +919800000009\nAccount = IT Support | +91 98000 00002'
    }, IPARAMS);
    const linked = (id) => ({
      ticket_id: id,
      subject: 'Token expired',
      resolution_note: RESET_REPLY,
      associated_solution_article_id: TOKEN_ARTICLE_ID,
      agent_id: 320,
      iparams: VOICE
    });
    const vobizCalls = (requests) => requests.calls.filter((c) => c.template === 'vobizMakeCall');
    const spokenText = (call) => new URL(JSON.parse(call.options.body).answer_url).searchParams.get('text');

    test('a high knowledge drift alert phones the admin with what changed', async () => {
      const { env, requests } = await serverWithKb();
      const result = await match(env, linked('T-2001'));
      const calls = vobizCalls(requests);

      expect(result.drift.alerts[0].band).toBe('critical');
      expect(calls).toHaveLength(1);
      expect(calls[0].options.context).toEqual({ auth_id: 'MA_TEST' });

      const body = JSON.parse(calls[0].options.body);

      expect(body).toMatchObject({ from: '918064261580', to: '+919800000001', answer_method: 'GET' });
      expect(body.answer_url.startsWith('https://relay.example.com/voice/answer?text=')).toBe(true);

      const said = spokenText(calls[0]);

      expect(said).toContain('high knowledge drift alert was raised for the article: Reset your security token');
      expect(said).toContain('The step Authentication has been replaced by Two-Step Verification.');
      expect(said).toContain('The article says: Settings, then Security, then Authentication');
      expect(said).toContain('Agents now use: Settings, then Security, then Two-Step Verification');
      expect(said).toContain('confirmed by 1 agent across 1 ticket');
      expect(said).toContain('review the proposed update');
      expect(said).not.toContain('agent@example.com');

      const alert = await call(env, 'getAlertDetail', { alertId: result.drift.alerts[0].alertId });

      expect(alert.adminCalls[0]).toMatchObject({ placed: true, to: '+919800000001', requestUuid: 'call-1' });
    });

    test('more tickets on the same drift do not ring the admin again', async () => {
      const { env, requests } = await serverWithKb();

      await match(env, linked('T-2002'));
      const second = await match(env, linked('T-2003'));

      expect(vobizCalls(requests)).toHaveLength(1);

      const alert = await call(env, 'getAlertDetail', { alertId: second.drift.alerts[0].alertId });

      expect(alert.adminCalls[0].placed).toBe(true);
    });

    test('no calls at all until Vobiz is configured', async () => {
      const { env, requests } = await serverWithKb();

      await match(env, Object.assign(linked('T-2004'), { iparams: IPARAMS }));
      expect(vobizCalls(requests)).toHaveLength(0);
    });

    test('approving an update phones the head of the department that owns the article', async () => {
      const { env, requests } = await serverWithKb();
      const result = await match(env, linked('T-2005'));
      const approved = await call(env, 'approveAlert', { alertId: result.drift.alerts[0].alertId, iparams: VOICE });
      const calls = vobizCalls(requests);

      expect(approved).toMatchObject({ published: true, deptCall: { placed: true, team: 'IT Support', to: '+919800000002' } });
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[1].options.body).to).toBe('+919800000002');

      const said = spokenText(calls[1]);

      expect(said).toContain('update for the IT Support team');
      expect(said).toContain('The solution article Reset your security token was updated and is now published');
      expect(said).toContain('The steps are now: Settings, then Security, then Two-Step Verification');
    });

    test('the Freshdesk folder id picks the department when it is listed', async () => {
      const { env, requests } = await serverWithKb({
        overrides: {
          fdGetArticle: () => Promise.resolve({
            response: JSON.stringify({ id: TOKEN_ARTICLE_ID, title: TOKEN_KB_ARTICLE.title, description: TOKEN_ARTICLE_HTML, folder_id: 68000075564, category_id: 5 })
          })
        }
      });
      const iparams = Object.assign({}, VOICE, { dept_heads: '68000075564 = Security Desk | +919800000003' });
      const result = await match(env, Object.assign(linked('T-2006'), { iparams }));
      const approved = await call(env, 'approveAlert', { alertId: result.drift.alerts[0].alertId, iparams });

      expect(approved.deptCall).toMatchObject({ placed: true, team: 'Security Desk', to: '+919800000003' });
      expect(vobizCalls(requests).map((c) => JSON.parse(c.options.body).to)).toEqual(['+919800000001', '+919800000003']);
    });

    test('a failed or unmatched call never blocks the approval', async () => {
      const { env } = await serverWithKb({
        overrides: { vobizMakeCall: () => Promise.reject({ status: 401, response: '{"error":"bad token"}' }) }
      });
      const iparams = Object.assign({}, VOICE, { dept_heads: 'Billing = Finance | +919800000004' });
      const result = await match(env, Object.assign(linked('T-2007'), { iparams }));
      const approved = await call(env, 'approveAlert', { alertId: result.drift.alerts[0].alertId, iparams });

      expect(result.drift.adminCalls[0].calls[0]).toMatchObject({ placed: false });
      expect(result.drift.adminCalls[0].calls[0].reason).toContain('HTTP 401');
      expect(approved).toMatchObject({ published: true, deptCall: { placed: false } });
      expect(approved.deptCall.reason).toContain('no department head matches');
    });
  });

  describe('knowledge-gap auto-drafting', () => {
    const noMatch = () => ({ decision: 'NO_MATCH', article_id: null, confidence: 0.31, reason: 'none fits' });
    const call = (env, name, args) => renderData.call(() => env.methods[name](Object.assign({ iparams: IPARAMS }, args)));

    test('a gap is stored as an alert carrying a drafted new article', async () => {
      const { env } = await serverWithKb({ gate: noMatch });
      const result = await match(env, Object.assign({ agent_id: 320 }, ticketById('R-210')));

      expect(result.knowledge_gap.alertId).toBe('gap-R-210');

      const alerts = await call(env, 'listAlerts', {});
      const gap = alerts.find((a) => a.alertId === 'gap-R-210');

      expect(gap).toMatchObject({
        finding: 'knowledge_gap',
        band: 'gap',
        ticketId: 'R-210',
        articleId: null,
        subject: 'Chargeback on a refund payment',
        agents: ['320'],
        state: 'open'
      });
      expect(gap.resolutionNote).toContain('signed contract');
      expect(gap.patch).toMatchObject({ mode: 'template', passed: true });
      expect(gap.patch.markdown).toMatch(/^# .+\n\n## Steps\n1\. /);
      expect(gap.patch.markdown).toContain('## Verification\n- ');
    });

    test('the drafter uses Claude when it answers with a usable article', async () => {
      const { env } = await serverWithKb({
        gate: noMatch,
        overrides: {
          anthropicMessages: (opts) => {
            const body = JSON.parse(opts.body);
            const tool = body.tools && body.tools[0].name;

            if (tool === 'record_relevance_decision') {
              return Promise.resolve({ response: JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: noMatch() }] }) });
            }
            if (tool === 'record_article') {
              const input = { title: 'How to answer a chargeback', steps: ['Open the **Payments** dashboard', 'Upload the contract'], verification: ['The dispute shows evidence'] };

              return Promise.resolve({ response: JSON.stringify({ content: [{ type: 'tool_use', name: tool, input }] }) });
            }
            return Promise.reject({ status: 401, response: 'no key' });
          }
        }
      });

      await match(env, ticketById('R-210'));

      const gap = await call(env, 'getAlertDetail', { alertId: 'gap-R-210' });

      expect(gap.articleTitle).toBe('How to answer a chargeback');
      expect(gap.patch).toMatchObject({ mode: 'llm', passed: true });
      expect(gap.patch.markdown).toBe('# How to answer a chargeback\n\n## Steps\n1. Open the **Payments** dashboard\n2. Upload the contract\n\n## Verification\n- The dispute shows evidence\n');
    });

    test('an edited draft is re-checked for title, steps and verification', async () => {
      const { env } = await serverWithKb({ gate: noMatch });

      await match(env, ticketById('R-210'));

      const bad = await call(env, 'updatePatch', { alertId: 'gap-R-210', markdown: '# Title only' });

      expect(bad.patch.passed).toBe(false);
      expect(bad.patch.errors.join(' ')).toContain('Steps');

      const good = await call(env, 'updatePatch', {
        alertId: 'gap-R-210',
        markdown: '# Respond to a chargeback\n\n## Steps\n1. Upload the contract.\n\n## Verification\n- Evidence is attached.'
      });

      expect(good.patch).toMatchObject({ passed: true, mode: 'manual' });
      expect(good.articleTitle).toBe('Respond to a chargeback');
    });

    test('approving creates a new Freshdesk article in the configured folder', async () => {
      const { env, requests } = await serverWithKb({ gate: noMatch });

      await match(env, ticketById('R-210'));

      const approved = await call(env, 'approveAlert', {
        alertId: 'gap-R-210',
        iparams: Object.assign({ gap_folder_id: ' 4200 ' }, IPARAMS)
      });
      const create = requests.calls.find((c) => c.template === 'fdCreateArticle');
      const body = JSON.parse(create.options.body);

      expect(approved).toMatchObject({ articleId: '777', created: true, published: true });
      expect(create.options.context.folder_id).toBe('4200');
      expect(body.status).toBe(2);
      expect(body.description).toContain('<ol><li>');
      expect(requests.calls.some((c) => c.template === 'fdUpdateArticle')).toBe(false);
      expect(await call(env, 'listAlerts', {})).toEqual([]);
      expect(JSON.parse(env.db.rows.get('articles:777').value)).toMatchObject({ articleId: '777', source: 'freshdesk' });

      // Re-ingesting the same ticket does not bring an approved gap back.
      await match(env, ticketById('R-210'));
      expect(await call(env, 'listAlerts', {})).toEqual([]);
    });

    test('approving a gap without a folder configured says what to set', async () => {
      const { env } = await serverWithKb({ gate: noMatch });

      await match(env, ticketById('R-210'));

      await expect(call(env, 'approveAlert', { alertId: 'gap-R-210' }))
        .rejects.toMatchObject({ message: expect.stringContaining('Folder for new articles') });
    });
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
          markdown: '## Steps\n\n1. Navigate to **Settings**.\n\n2. Click **Security**.\n\n3. Click **Two-Step Verification**, then reset the security token.',
          documentedPath: ['node_settings', 'node_security', 'node_two_step']
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
    expect(report).toContain('documented path : Settings → Security → Authentication');
    expect(report).toContain('agent\'s path    : Settings → Security → Two-Step Verification');
    expect(report).toContain('verdict         : PROCEDURAL DRIFT - critical alert raised (confidence 1.00), validated patch drafted');
  });

  test('the terminal says NO DRIFT when the agent followed the article', async () => {
    const followed = 'Go to Settings, then Security, then Two-Step Verification.';
    const html = '<h2>Reset</h2><h3>Steps</h3><ol><li>Go to <b>Settings</b> &rarr; <b>Security</b> &rarr; '
      + '<b>Two-Step Verification</b>.</li></ol>';
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
