// server/lib/extractor.js
// Stage 2: extract the ordered UI steps an agent described, using Haiku with a
// forced tool call. Requires the "anthropicMessages" request template declared
// in config/requests.json.
//
// If the API call fails (no key configured, rate limit, network) the module
// degrades to a deterministic scan of the text against the taxonomy's own
// aliases rather than throwing - a ticket ingest must never die because the
// extraction model was unreachable.
'use strict';

const tax = require('./taxonomy');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;
const TOOL_NAME = 'record_steps';

const SYSTEM = `You extract the navigation steps a support agent described to a customer.
Rules:
- Return ONLY menu or UI element labels the agent EXPLICITLY mentions, in the order mentioned.
- Do NOT infer or add missing levels - if the agent skipped a step, leave it out.
- Describe only the PRIMARY resolution path. Ignore greetings, apologies, and failed attempts.
- If no menu/navigation path is described, return an empty array.
- Keep each label short (1-3 words), as written, lower-cased.`;

const TOOL = {
  name: TOOL_NAME,
  description: 'Record the ordered UI navigation steps mentioned in the ticket text.',
  input_schema: {
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'string' } } },
    required: ['steps']
  }
};

async function callHaiku(redactedText) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: redactedText }]
  };

  const response = await $request.invokeTemplate('anthropicMessages', {
    body: JSON.stringify(body)
  });

  const data = JSON.parse(response.response);

  for (const block of data.content || []) {
    if (block.type === 'tool_use' && block.name === TOOL_NAME) {
      return block.input.steps || [];
    }
  }

  return [];
}

// ---- Offline fallback ---------------------------------------------------

// tax.normalise already strips everything outside [\w\s], so an alias can only
// ever be word characters and single spaces - safe to drop straight into a
// word-boundary regex without further escaping.
function termRegExp(term) {
  return new RegExp(`\\b${tax.normalise(term)}\\b`);
}

// First position at which any of a node's aliases appears, or -1.
function firstHit(haystack, terms) {
  let best = -1;

  for (const term of terms) {
    const at = haystack.search(termRegExp(term));

    if (at !== -1 && (best === -1 || at < best)) {
      best = at;
    }
  }

  return best;
}

function aliasScan(text) {
  const haystack = tax.normalise(text);
  const hits = [];

  for (const [nodeId, node] of Object.entries(tax.TAXONOMY.nodes)) {
    const at = firstHit(haystack, [node.label, ...node.aliases]);

    if (at !== -1) {
      hits.push({ at, label: node.label, nodeId });
    }
  }

  return hits.sort((a, b) => a.at - b.at).map((h) => h.label);
}

// ---- Entry point --------------------------------------------------------

async function extractSteps(redactedText) {
  const viaModel = await callHaiku(redactedText).catch(() => null);

  if (viaModel !== null) {
    return viaModel;
  }

  return aliasScan(redactedText);
}

const api = { extractSteps, aliasScan };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
