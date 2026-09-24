// @vitest-environment node
// tests/matching.test.js
// The three-stage ticket-to-article matcher, stage by stage, then end to end
// over the beta dataset. No network: embeddings come from the deterministic
// local provider (or a scripted one) and Claude is a scripted judge.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deterministicMatch, articleIdsIn, categoryPath } = require('../server/lib/linkage.js');
const { buildResolutionQuery, cleanSupportText, articleEmbeddingText } = require('../server/lib/query.js');
const { createEmbedder, hashEmbed } = require('../server/lib/embeddings.js');
const { buildKnowledgeIndex, searchKnowledge, cosineSimilarity } = require('../server/lib/vectorstore.js');
const { resolveMatchConfig, envOverrides, MAX_CANDIDATES } = require('../server/lib/matchconfig.js');
const relevance = require('../server/lib/relevance.js');
const { matchResolvedTicket } = require('../server/lib/matcher.js');

const DATASET_ARTICLES = Object.values(require('../data/beta/articles.json'));
const RESOLVED = require('../data/beta/resolved_tickets.json');
const GROUND_TRUTH = require('../data/beta/ground_truth.json').matching;

const ticketById = (id) => RESOLVED.find((t) => t.ticket_id === id);

function memoryCache() {
  const rows = new Map();

  return {
    rows,
    get: vi.fn(async (id) => rows.get(id) || null),
    save: vi.fn(async (id, record) => {
      rows.set(id, record);
    })
  };
}

function localEmbedder(overrides) {
  return createEmbedder(resolveMatchConfig({}, overrides));
}

// A stand-in for Claude that already validated its answer.
function judgeReturning(decision) {
  return vi.fn(async () => Object.assign({ valid: true, reason: 'scripted' }, decision));
}

function mustNotRun(name) {
  return vi.fn(async () => {
    throw new Error(`${name} must not run`);
  });
}

function deps(overrides) {
  return Object.assign({
    cfg: resolveMatchConfig({}),
    articles: DATASET_ARTICLES,
    embedder: localEmbedder(),
    cache: memoryCache(),
    judge: mustNotRun('judge')
  }, overrides);
}

const exists = (ids) => async (id) => ids.includes(String(id));

// ---------------------------------------------------------------------------

describe('stage 1 - deterministic linkage', () => {
  test('an associated solution article matches outright', async () => {
    const d = deps({ embedder: { embedText: mustNotRun('embedder'), embedArticle: mustNotRun('embedder') } });
    const result = await matchResolvedTicket(ticketById('R-201'), d);

    expect(result).toMatchObject({
      ticket_id: 'R-201',
      classification: 'ARTICLE_MATCH',
      article_id: '9002',
      method: 'associated_solution_article_id',
      stage: 1,
      confidence: 1
    });
    expect(result.metrics.stage_1_matched).toBe(true);
    expect(result.metrics.stage_2_executed).toBe(false);
    expect(d.judge).not.toHaveBeenCalled();
  });

  test('an associated article that is not in the KB is not trusted', async () => {
    const r = await deterministicMatch({ associated_solution_article_id: '424242' }, [], exists(['9001']));

    expect(r.classification).toBeNull();
    expect(r.notes.join(' ')).toContain('not in the knowledge base');
  });

  test('the custom-field form of the associated article is read too', async () => {
    const r = await deterministicMatch({ custom_fields: { cf_solution_article_id: 9003 } }, [], exists(['9003']));

    expect(r).toMatchObject({ article_id: '9003', method: 'associated_solution_article_id' });
  });

  test('a direct Freshdesk article URL matches', async () => {
    const result = await matchResolvedTicket(ticketById('R-202'), deps());

    expect(result).toMatchObject({
      classification: 'ARTICLE_MATCH',
      article_id: '9007',
      method: 'direct_solution_url',
      stage: 1,
      confidence: 1
    });
  });

  test.each([
    ['https://acme.freshdesk.com/a/solutions/articles/9007', '9007'],
    ['https://acme.freshdesk.com/support/solutions/articles/9007-update-billing-address', '9007'],
    ['http://acme.freshdesk.com/support/solutions/articles/9007?lang=fr', '9007'],
    ['https://it.acme.freshservice.com/support/solutions/9007', '9007'],
    ['see /helpdesk/solutions/articles/9007#steps', '9007'],
    ['<a href="https://acme.freshdesk.com/a/solutions/articles/9007">guide</a>', '9007']
  ])('URL variant %s', (text, id) => {
    expect(articleIdsIn(text)).toEqual([id]);
  });

  test('URLs are found in conversation arrays and internal notes', async () => {
    const ticket = {
      conversation: [{ body: '<p>Try <a href="/support/solutions/articles/9006-cancel">this</a></p>' }],
      internal_notes: [{ body_text: 'n/a' }]
    };

    expect(await deterministicMatch(ticket, [], exists(['9006']))).toMatchObject({ article_id: '9006', method: 'direct_solution_url' });
  });

  test('the same article linked twice is still one article', async () => {
    const ticket = { resolution_note: 'https://a.freshdesk.com/a/solutions/articles/9005 and again /support/solutions/articles/9005' };

    expect((await deterministicMatch(ticket, [], exists(['9005']))).article_id).toBe('9005');
  });

  test('links to several different articles are ambiguous and fall through', async () => {
    const ticket = { resolution_note: 'Used /a/solutions/articles/9005 and /a/solutions/articles/9006' };
    const r = await deterministicMatch(ticket, [], exists(['9005', '9006']));

    expect(r.classification).toBeNull();
    expect(r.notes.join(' ')).toContain('2 different articles');
  });

  test('invalid or unknown URLs never match', async () => {
    const ticket = {
      resolution_note: 'See /solutions/articles/abc, /solutions/folders/12, and https://x.freshdesk.com/a/solutions/articles/777'
    };

    expect(articleIdsIn('solutions/articles/abc and solutions/folders/12')).toEqual([]);
    expect((await deterministicMatch(ticket, [], exists(['9001']))).classification).toBeNull();
  });

  test('a unique category mapping matches through the taxonomy', async () => {
    const result = await matchResolvedTicket(ticketById('R-203'), deps());

    expect(result).toMatchObject({ classification: 'ARTICLE_MATCH', article_id: '9003', method: 'taxonomy_category_mapping', stage: 1 });
  });

  test('KB category paths are normalised with the taxonomy rules', () => {
    expect(categoryPath('Solutions > Billing > Refunds')).toEqual(['billing', 'refunds']);
    expect(categoryPath('  BILLING ', 'Refunds!')).toEqual(['billing', 'refunds']);
    expect(categoryPath('Billing → Refunds')).toEqual(['billing', 'refunds']);
  });

  test('a KB category written as one path still maps', async () => {
    const kb = [{ article_id: '1', category: 'Solutions > Billing > Refunds', subcategory: '' }];

    expect(await deterministicMatch({ category: 'Billing', subcategory: 'Refunds' }, kb, exists([])))
      .toMatchObject({ article_id: '1', method: 'taxonomy_category_mapping' });
  });

  test('an ambiguous category does not pick one - it goes to stage 2', async () => {
    const d = deps({ judge: judgeReturning({ decision: 'MATCH', article_id: '9008', confidence: 0.93 }) });
    const result = await matchResolvedTicket(ticketById('R-205'), d);

    expect(result.metrics.stage_1_matched).toBe(false);
    expect(result.trace.join('\n')).toContain('2 articles share the ticket\'s category');
    expect(result.stage).toBe(3);
    expect(result.article_id).toBe('9008');
  });

  test('a single category level is too broad to map', async () => {
    const kb = [{ article_id: '1', category: 'Billing', subcategory: 'Refunds' }];

    expect((await deterministicMatch({ category: 'Billing' }, kb, exists([]))).classification).toBeNull();
  });

  test('no evidence at all is no deterministic match', async () => {
    const r = await deterministicMatch({ subject: 'x', resolution_note: 'did a thing' }, DATASET_ARTICLES, exists([]));

    expect(r).toEqual({ classification: null, stage: 1, notes: [] });
  });
});

// ---------------------------------------------------------------------------

describe('stage 2 - semantic retrieval', () => {
  test('cosine similarity is (A.B) / (|A||B|)', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(32 / (Math.sqrt(14) * Math.sqrt(77)), 10);
    expect(cosineSimilarity([2, 0], [5, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });

  test('the local embedder is deterministic and unit length', () => {
    const a = hashEmbed('process a partial refund');

    expect(hashEmbed('process a partial refund')).toEqual(a);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
  });

  test('the resolution query is subject + resolution, cleaned and redacted', () => {
    const q = buildResolutionQuery({
      subject: 'RE: Fwd: Customer charged twice',
      resolution_note: 'Hi Sam,\n\nProcessed a partial refund for the duplicate charge. Mail me at sam@example.com.\nHope this helps!\n\nRegards,\nPriya\n\nOn Mon, Sam wrote:\n> I was charged twice',
      conversation: [{ incoming: true, body_text: 'long customer history that must not be embedded' }]
    });

    expect(q.subject).toBe('Customer charged twice');
    expect(q.resolution).toBe('Processed a partial refund for the duplicate charge. Mail me at [ANONYMIZED_EMAIL].');
    expect(q.text).toBe(`Subject: ${q.subject}\nResolution: ${q.resolution}`);
    expect(q.text).not.toContain('history');
  });

  test('with no resolution note, the last public agent reply stands in', () => {
    const q = buildResolutionQuery(ticketById('R-204'));
    const noNote = buildResolutionQuery(Object.assign({}, ticketById('R-204'), { resolution_note: '' }));

    expect(q.resolution).toBe('Processed a partial refund for the duplicate charge.');
    expect(noNote.resolution).toBe('Sorry about that. I have processed a partial refund for the duplicate charge.');
  });

  test('HTML and email headers are stripped', () => {
    expect(cleanSupportText('<p>Hello,</p><p>Reset the <b>token</b>.</p><p>From: a@b.c</p><p>old stuff</p>')).toBe('Reset the token.');
  });

  test('article embedding text keeps title, category and procedure only', () => {
    const text = articleEmbeddingText(DATASET_ARTICLES.find((a) => a.article_id === '9005'));

    expect(text).toContain('Title: How to process a partial refund');
    expect(text).toContain('Category: Billing > Refunds');
    expect(text).toContain('partial refund amount');
    expect(text).not.toContain('greyed out');
  });

  test('the right article ranks first, top 3, sorted descending', async () => {
    const embedder = localEmbedder();
    const index = await buildKnowledgeIndex(DATASET_ARTICLES, embedder, memoryCache());
    const q = await embedder.embedText(buildResolutionQuery(ticketById('R-204')).text);
    const r = searchKnowledge(index, q, 3, -1);

    expect(r.top).toHaveLength(3);
    expect(r.top[0].article_id).toBe('9005');
    expect(r.top.map((c) => c.score)).toEqual([...r.top.map((c) => c.score)].sort((a, b) => b - a));
  });

  test('only candidates at or above the threshold go forward', async () => {
    const embedder = localEmbedder();
    const index = await buildKnowledgeIndex(DATASET_ARTICLES, embedder, memoryCache());
    const q = await embedder.embedText(buildResolutionQuery(ticketById('R-204')).text);
    const strict = searchKnowledge(index, q, 3, 0.5);
    const open = searchKnowledge(index, q, 3, -1);

    expect(open.candidates).toHaveLength(3);
    expect(strict.candidates.every((c) => c.score >= 0.5)).toBe(true);
    expect(strict.candidates.length).toBeLessThan(3);
    expect(strict.top).toHaveLength(3);
  });

  test('the threshold and top K come from configuration, top K capped at 3', () => {
    expect(resolveMatchConfig({}).semanticThreshold).toBe(0.30);
    expect(resolveMatchConfig({ embedding_provider: 'voyage' }).semanticThreshold).toBe(0.80);
    expect(resolveMatchConfig({ semantic_match_threshold: '0.65' }).semanticThreshold).toBe(0.65);
    expect(resolveMatchConfig({ semantic_match_threshold: 'nonsense' }).semanticThreshold).toBe(0.30);
    expect(resolveMatchConfig({ semantic_top_k: '10' }).topK).toBe(MAX_CANDIDATES);
    expect(resolveMatchConfig({}, { semanticThreshold: 0.9 }).semanticThreshold).toBe(0.9);
  });

  test('environment variables map onto the same settings', () => {
    const env = { SEMANTIC_MATCH_THRESHOLD: '0.8', EMBEDDING_PROVIDER: 'voyage', SEMANTIC_TOP_K: '2', UNRELATED: 'x' };

    expect(envOverrides(env)).toEqual({ semanticThreshold: '0.8', embeddingProvider: 'voyage', topK: '2' });
    expect(resolveMatchConfig({}, envOverrides(env))).toMatchObject({ semanticThreshold: 0.8, embeddingProvider: 'voyage', topK: 2 });
  });

  test('an empty resolution is not embedded and is not a knowledge gap', async () => {
    const embedder = { embedText: mustNotRun('embedder'), embedArticle: mustNotRun('embedder'), model: 'x' };
    const result = await matchResolvedTicket(ticketById('R-209'), deps({ embedder }));

    expect(result).toMatchObject({ classification: 'INSUFFICIENT_EVIDENCE', method: 'empty_resolution' });
    expect(result.metrics.knowledge_gap).toBe(false);
  });

  test('duplicate articles do not take two of the three slots', async () => {
    const original = DATASET_ARTICLES.find((a) => a.article_id === '9005');
    const copy = Object.assign({}, original, { article_id: '9105' });
    const embedder = localEmbedder();
    const index = await buildKnowledgeIndex([...DATASET_ARTICLES, copy, original], embedder, memoryCache());
    const q = await embedder.embedText(buildResolutionQuery(ticketById('R-204')).text);
    const ids = searchKnowledge(index, q, 3, -1).top.map((c) => c.article_id);

    expect(index.stats.indexed).toBe(DATASET_ARTICLES.length + 1);
    expect(ids).toContain('9005');
    expect(ids).not.toContain('9105');
    expect(new Set(ids).size).toBe(3);
  });

  test('unchanged articles reuse their cached embedding', async () => {
    const cache = memoryCache();
    const embedder = localEmbedder();
    const spy = vi.spyOn(embedder, 'embedArticle');

    const first = await buildKnowledgeIndex(DATASET_ARTICLES, embedder, cache);
    const second = await buildKnowledgeIndex(DATASET_ARTICLES, embedder, cache);

    expect(first.stats).toEqual({ indexed: 8, reused: 0, embedded: 8 });
    expect(second.stats).toEqual({ indexed: 8, reused: 8, embedded: 0 });
    expect(spy).toHaveBeenCalledTimes(8);

    const record = cache.rows.get('9005');

    expect(Object.keys(record).sort()).toEqual(['article_id', 'content_hash', 'embedding', 'model', 'updated_at']);
  });

  test('a changed article, or a new model, is re-embedded', async () => {
    const cache = memoryCache();

    await buildKnowledgeIndex(DATASET_ARTICLES, localEmbedder(), cache);

    const edited = DATASET_ARTICLES.map((a) => (a.article_id === '9006'
      ? Object.assign({}, a, { markdown: a.markdown.replace('Cancel subscription', 'End plan') })
      : a));
    const oldHash = cache.rows.get('9006').content_hash;
    const afterEdit = await buildKnowledgeIndex(edited, localEmbedder(), cache);

    expect(afterEdit.stats).toEqual({ indexed: 8, reused: 7, embedded: 1 });
    expect(cache.rows.get('9006').content_hash).not.toBe(oldHash);

    const newModel = await buildKnowledgeIndex(edited, localEmbedder({ embeddingModel: 'hash-512-v2' }), cache);

    expect(newModel.stats.embedded).toBe(8);
  });
});

// ---------------------------------------------------------------------------

describe('stage 3 - relevance gate', () => {
  const IDS = ['9005', '9008', '9006'];

  function toolResponse(input) {
    return JSON.stringify({ content: [{ type: 'tool_use', name: relevance.TOOL_NAME, input }] });
  }

  afterEach(() => {
    delete globalThis.$request;
  });

  test('a valid MATCH on a supplied candidate is accepted', () => {
    const r = relevance.parseRelevanceResponse(toolResponse({
      decision: 'MATCH', article_id: '9005', confidence: 0.94, reason: 'partial refund performed'
    }), IDS);

    expect(r).toEqual({ valid: true, decision: 'MATCH', article_id: '9005', confidence: 0.94, reason: 'partial refund performed' });
  });

  test('NO_MATCH is accepted and carries no article', () => {
    const r = relevance.parseRelevanceResponse(toolResponse({
      decision: 'NO_MATCH', article_id: '9005', confidence: 0.31, reason: 'none describe it'
    }), IDS);

    expect(r).toMatchObject({ valid: true, decision: 'NO_MATCH', article_id: null });
  });

  test('an article id that was not a candidate is invalid, never a match', () => {
    const r = relevance.parseRelevanceResponse(toolResponse({
      decision: 'MATCH', article_id: '9007', confidence: 0.99, reason: 'invented'
    }), IDS);

    expect(r.valid).toBe(false);
    expect(r.decision).toBe('NO_MATCH');
    expect(r.article_id).toBeNull();
    expect(r.error).toContain('not one of the candidates');
  });

  test.each([
    ['not json at all', 'malformed'],
    [JSON.stringify({ content: [{ type: 'text', text: 'I think it is 9005' }] }), 'malformed'],
    [toolResponse({ decision: 'YES', article_id: '9005', confidence: 0.9 }), 'decision'],
    [toolResponse({ decision: 'MATCH', article_id: '9005', confidence: 7 }), 'confidence'],
    [toolResponse({ decision: 'MATCH', article_id: '9005' }), 'confidence']
  ])('malformed output is invalid: %s', (body, error) => {
    const r = relevance.parseRelevanceResponse(body, IDS);

    expect(r.valid).toBe(false);
    expect(r.error).toContain(error);
  });

  test('a JSON text block is accepted when there is no tool call', () => {
    const body = JSON.stringify({ content: [{ type: 'text', text: '```json\n{"decision":"NO_MATCH","article_id":null,"confidence":0.2,"reason":"x"}\n```' }] });

    expect(relevance.parseRelevanceResponse(body, IDS)).toMatchObject({ valid: true, decision: 'NO_MATCH' });
  });

  test('unexpected fields are dropped', () => {
    const r = relevance.parseRelevanceResponse(toolResponse({
      decision: 'MATCH', article_id: 9005, confidence: 0.9, reason: 'ok', secret_plan: 'x', article_body: 'y'
    }), IDS);

    expect(Object.keys(r).sort()).toEqual(['article_id', 'confidence', 'decision', 'reason', 'valid']);
    expect(r.article_id).toBe('9005');
  });

  test('the request carries the ticket and at most three candidates', async () => {
    const sent = [];

    globalThis.$request = {
      invokeTemplate: vi.fn(async (name, opts) => {
        sent.push({ name, body: JSON.parse(opts.body) });
        return { response: toolResponse({ decision: 'MATCH', article_id: 'c2', confidence: 0.9, reason: 'r' }) };
      })
    };

    const five = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ article_id: id, title: `T ${id}`, procedure: `P ${id}`, score: 0.9 }));
    const r = await relevance.judgeRelevance({ subject: 'S', resolution: 'R' }, five, 'claude-sonnet-5');

    expect(r.article_id).toBe('c2');
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('anthropicMessages');
    expect(sent[0].body.model).toBe('claude-sonnet-5');
    expect(sent[0].body.tool_choice).toEqual({ type: 'tool', name: relevance.TOOL_NAME });

    const prompt = sent[0].body.messages[0].content;

    expect(prompt).toContain('subject: S');
    expect(prompt).toContain('article_id: c3');
    expect(prompt).not.toContain('c4');
    expect(prompt).not.toContain('c5');
  });

  test('an id beyond the third candidate is not accepted even if the model names it', async () => {
    globalThis.$request = {
      invokeTemplate: async () => ({ response: toolResponse({ decision: 'MATCH', article_id: 'c4', confidence: 0.9, reason: 'r' }) })
    };

    const four = ['c1', 'c2', 'c3', 'c4'].map((id) => ({ article_id: id, title: id, procedure: id, score: 0.9 }));

    expect((await relevance.judgeRelevance({ subject: 'S', resolution: 'R' }, four, 'm')).valid).toBe(false);
  });

  test('the system prompt states the relevance rules', () => {
    expect(relevance.SYSTEM).toContain('Judge the task and its outcome, never whether the steps agree');
    expect(relevance.SYSTEM).toContain('different tasks');
    expect(relevance.SYSTEM).toContain('Never invent an article ID');
    expect(relevance.SYSTEM).toContain('NO_MATCH');
  });
});

// ---------------------------------------------------------------------------

describe('matchResolvedTicket - the funnel', () => {
  test('semantic retrieval + Claude MATCH is an explainable stage-3 match', async () => {
    const judge = judgeReturning({ decision: 'MATCH', article_id: '9005', confidence: 0.94 });
    const result = await matchResolvedTicket(ticketById('R-204'), deps({ judge }));

    expect(result).toMatchObject({
      ticket_id: 'R-204',
      classification: 'ARTICLE_MATCH',
      article_id: '9005',
      method: 'semantic_llm_gate',
      stage: 3,
      confidence: 0.94
    });
    expect(result.semantic_score).toBe(result.candidates[0].score);
    expect(result.candidates.map((c) => c.article_id)).toEqual(['9005', '9008']);
    expect(result.metrics).toMatchObject({
      stage_1_attempted: true,
      stage_1_matched: false,
      stage_2_executed: true,
      stage_2_candidate_count: 2,
      stage_3_executed: true,
      stage_3_match: true,
      stage_3_no_match: false,
      knowledge_gap: false
    });
    expect(result.trace).toEqual([
      'Ticket R-204',
      'Stage 1: no explicit article',
      expect.stringMatching(/^Stage 2: 2 candidates at or above 0.3 \(top score 0\.\d+, 8 articles indexed\)$/),
      'Stage 3: Claude MATCH (confidence 0.94)',
      'Article: 9005'
    ]);
  });

  test('Claude sees only the retrieved candidates - never the knowledge base', async () => {
    const judge = judgeReturning({ decision: 'NO_MATCH', article_id: null, confidence: 0.2 });
    const cfg = resolveMatchConfig({}, { semanticThreshold: -1 });

    await matchResolvedTicket(ticketById('R-204'), deps({ judge, cfg }));

    const [query, candidates] = judge.mock.calls[0];

    expect(candidates).toHaveLength(3);
    expect(Object.keys(candidates[0]).sort()).toEqual(['article_id', 'category', 'procedure', 'score', 'subcategory', 'title']);
    expect(Object.keys(query).sort()).toEqual(['empty', 'resolution', 'subject', 'text']);
    expect(JSON.stringify(judge.mock.calls[0]).length).toBeLessThan(JSON.stringify(DATASET_ARTICLES).length / 2);
  });

  test('Claude NO_MATCH is a knowledge gap, not a match on the nearest article', async () => {
    const judge = judgeReturning({ decision: 'NO_MATCH', article_id: null, confidence: 0.31 });
    const result = await matchResolvedTicket(ticketById('R-210'), deps({ judge }));

    expect(result).toMatchObject({ classification: 'KNOWLEDGE_GAP', method: 'no_relevant_article', stage: 3 });
    expect(result.article_id).toBeUndefined();
    expect(result.metrics).toMatchObject({ stage_3_executed: true, stage_3_no_match: true, knowledge_gap: true });
  });

  test('a low-confidence MATCH is treated as no match', async () => {
    const judge = judgeReturning({ decision: 'MATCH', article_id: '9005', confidence: 0.55 });
    const result = await matchResolvedTicket(ticketById('R-204'), deps({ judge }));

    expect(result).toMatchObject({ classification: 'KNOWLEDGE_GAP', method: 'low_confidence_llm_gate', confidence: 0.55 });
    expect(result.article_id).toBeUndefined();
  });

  test('no candidate over the threshold is a gap without calling Claude', async () => {
    const d = deps();
    const result = await matchResolvedTicket(ticketById('R-208'), d);

    expect(result).toMatchObject({ classification: 'KNOWLEDGE_GAP', method: 'no_semantic_match', semantic_result: 'NO_SEMANTIC_MATCH', stage: 2 });
    expect(result.nearest).toHaveLength(3);
    expect(result.metrics.stage_3_executed).toBe(false);
    expect(d.judge).not.toHaveBeenCalled();
  });

  test.each([
    ['embedding service', { embedder: { model: 'm', embedText: mustNotRun('x'), embedArticle: mustNotRun('x') } }, 'embedding_failed', 2],
    ['vector store', { cache: { get: mustNotRun('cache'), save: mustNotRun('cache') } }, 'vector_store_failed', 2],
    ['Claude', { judge: mustNotRun('claude') }, 'relevance_gate_failed', 3],
    ['Claude output', { judge: vi.fn(async () => ({ valid: false, error: 'malformed response' })) }, 'relevance_gate_invalid_output', 3]
  ])('a %s failure is MATCHING_UNAVAILABLE, never a gap', async (_name, override, method, stage) => {
    const result = await matchResolvedTicket(ticketById('R-204'), deps(Object.assign({
      articleExists: async () => false
    }, override)));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method, stage });
    expect(result.article_id).toBeUndefined();
    expect(result.metrics.knowledge_gap).toBe(false);
    expect(result.metrics.matching_unavailable).toBe(true);
  });

  test('a stage 1 lookup failure is MATCHING_UNAVAILABLE', async () => {
    const result = await matchResolvedTicket(ticketById('R-202'), deps({ articleExists: mustNotRun('lookup') }));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method: 'deterministic_linkage_failed', stage: 1 });
    expect(result.metrics.stage_2_executed).toBe(false);
  });

  test('an embedder returning garbage is unavailable too', async () => {
    const embedder = createEmbedder(resolveMatchConfig({}), { provider: 'fake', model: 'f', embed: async () => [NaN] });
    const result = await matchResolvedTicket(ticketById('R-204'), deps({ embedder }));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method: 'embedding_failed' });
  });

  test('a query vector from a different model is a vector-store fault', async () => {
    const small = createEmbedder(resolveMatchConfig({}), { provider: 'fake', model: 'f', embed: async () => [1, 0, 0] });
    const cache = memoryCache();

    await buildKnowledgeIndex(DATASET_ARTICLES, localEmbedder({ embeddingModel: 'f' }), cache);

    const result = await matchResolvedTicket(ticketById('R-204'), deps({ embedder: small, cache }));

    expect(result).toMatchObject({ classification: 'MATCHING_UNAVAILABLE', method: 'vector_store_failed' });
  });
});

// ---------------------------------------------------------------------------

// The beta dataset through the whole funnel. Claude is scripted to answer
// the way the ground truth says it should - but only if retrieval actually
// put that article in front of it. A retrieval miss therefore fails here.
describe('the beta dataset against ground_truth.json', () => {
  function groundTruthJudge(ticketId) {
    const truth = GROUND_TRUTH[ticketId];

    return vi.fn(async (_query, candidates) => {
      const offered = candidates.some((c) => c.article_id === truth.article_id);

      return offered
        ? { valid: true, decision: 'MATCH', article_id: truth.article_id, confidence: 0.92, reason: 'gt' }
        : { valid: true, decision: 'NO_MATCH', article_id: null, confidence: 0.2, reason: 'gt' };
    });
  }

  test.each(Object.keys(GROUND_TRUTH))('%s', async (ticketId) => {
    const truth = GROUND_TRUTH[ticketId];
    const judge = groundTruthJudge(ticketId);
    const result = await matchResolvedTicket(ticketById(ticketId), deps({ judge }));

    expect(result.classification).toBe(truth.classification);
    expect(result.article_id || null).toBe(truth.article_id);

    if (truth.method) {
      expect(result.method).toBe(truth.method);
    }
    if (truth.stage) {
      expect(result.stage).toBe(truth.stage);
    }
    for (const call of judge.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(3);
    }
  });
});
