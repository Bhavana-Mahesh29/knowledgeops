// server/lib/architect.js
// Stage 4: draft a patch. Two modes, both go through the SAME validator:
//   'llm'      Sonnet drafts it, retries with validator errors fed back
//   'template' deterministic string substitution - used if the LLM keeps
//              failing validation or the API call throws
'use strict';
const tax = require('./taxonomy');
const { validatePatch, STEPS } = require('./validator');

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1200;
const ARROW = '\u2192';
const STEPS_HEADING = /(?:^|\n)## Steps[ \t]*(?:\n|$)/;

const SYSTEM = `You edit a support knowledge-base article's ${STEPS} section only.
Hard rules:
- Change ONLY the content under the '## ${STEPS}' heading. Return every other
  section byte-for-byte identical to the original.
- In the ${STEPS} section, bold is reserved for navigation menu items ONLY.
  Write each UI element exactly as given in the target path, in order,
  wrapped in **bold**. Buttons/fields/confirmations go in *italics*, never bold.
- Include EVERY level of the given path. Never omit an intermediate step.
- Return the FULL updated article markdown, nothing else.`;

function buildPrompt(articleMd, targetLabels, evidence, priorErrors) {
  const evidenceList = evidence.slice(0, 3).map((e) => `- ${e}`).join('\n');
  let prompt = `Current article:\n---\n${articleMd}\n---\n\n`
    + `The correct navigation path, based on how support agents now resolve this, is: ${targetLabels.join(` ${ARROW} `)}\n\n`
    + `Evidence from recent tickets:\n${evidenceList}\n\n`
    + 'Return the full corrected article markdown.';

  if (priorErrors) {
    prompt += `\n\nYour previous attempt failed validation:\n${priorErrors.join('\n')}`
      + '\nFix these issues and return the full corrected markdown again.';
  }

  return prompt;
}

async function callLLM(articleMd, targetLabels, evidence, priorErrors) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [
      { role: 'user', content: buildPrompt(articleMd, targetLabels, evidence, priorErrors) }
    ]
  };

  const response = await $request.invokeTemplate('anthropicMessages', {
    body: JSON.stringify(body)
  });

  const data = JSON.parse(response.response);

  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// ---- Deterministic fallback --------------------------------------------

// Locates the body of the Steps section as a [start, end) span of the raw
// markdown. Patching in place is what keeps every other section byte-for-byte
// identical, which is check 2 of the validator.
function stepsBodyRange(md) {
  const match = STEPS_HEADING.exec(md);

  if (match === null) {
    return null;
  }

  const start = match.index + match[0].length;
  const next = md.indexOf('\n## ', start);

  return { start, end: next === -1 ? md.length : next };
}

// Bold is reserved for the navigation path, so any bold left on the other
// step lines is demoted to italics - otherwise it would show up as an extra
// node in check 4.
function demoteBold(line) {
  return line.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

function rewriteStepsBody(oldBody, targetLabels) {
  const navLine = `1. Go to ${targetLabels.map((l) => `**${l}**`).join(` ${ARROW} `)}.`;
  const lines = oldBody.split('\n');
  const navIndex = lines.findIndex((l) => /^\s*\d+\.\s/.test(l));

  if (navIndex === -1) {
    const kept = lines.filter((l) => l.trim() !== '').map(demoteBold);

    return [navLine, ...kept].join('\n');
  }

  return lines.map((l, i) => (i === navIndex ? navLine : demoteBold(l))).join('\n');
}

function templatePatch(articleMd, targetLabels) {
  const range = stepsBodyRange(articleMd);

  if (range === null) {
    return articleMd;
  }

  const oldBody = articleMd.slice(range.start, range.end);

  return articleMd.slice(0, range.start)
    + rewriteStepsBody(oldBody, targetLabels)
    + articleMd.slice(range.end);
}

// ---- Orchestration ------------------------------------------------------

async function draftAndValidate(articleMd, targetPathNodes, evidence, maxLlmAttempts = 3) {
  const targetLabels = tax.displayPath(targetPathNodes);
  let errors = null;

  for (let attempt = 1; attempt <= maxLlmAttempts; attempt++) {
    const candidate = await callLLM(articleMd, targetLabels, evidence, errors)
      .catch(() => null);

    if (candidate === null) {
      break; // API unreachable -> fall through to the template
    }

    const result = validatePatch(articleMd, candidate, targetPathNodes);

    if (result.passed) {
      return { markdown: candidate, mode: 'llm', passed: true, errors: [], attempts: attempt };
    }

    errors = result.errors;
  }

  const templateMd = templatePatch(articleMd, targetLabels);
  const result = validatePatch(articleMd, templateMd, targetPathNodes);

  return {
    markdown: templateMd,
    mode: 'template',
    passed: result.passed,
    errors: result.errors,
    attempts: maxLlmAttempts
  };
}

// ---- Knowledge gaps: a new article from one resolution ------------------
//
// A gap has no baseline article, so there is nothing for validatePatch to
// diff against. The draft is instead held to a fixed shape - a title, a
// numbered Steps section and a Verification section - which is what the
// reviewer edits and what gets published as a new Freshdesk article.

const GAP_TOOL_NAME = 'record_article';
const VERIFICATION = 'Verification';

const GAP_SYSTEM = `You turn one resolved support ticket into a short, new knowledge-base article.
Rules:
- Use ONLY what the resolution says was done. Do not invent menus, settings or policies.
- title: an imperative "How to ..." title, under 70 characters.
- steps: the procedure in order, one action per step, written to the customer or agent doing it.
  Wrap navigation menu items in **bold**; buttons and fields in *italics*.
- verification: how to confirm the procedure worked (1-3 short items).`;

const GAP_TOOL = {
  name: GAP_TOOL_NAME,
  description: 'Record the drafted knowledge-base article.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
      verification: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'steps', 'verification']
  }
};

function gapPrompt(gap) {
  const menus = (gap.steps || []).length ? `\nMenu items the agent mentioned, in order: ${gap.steps.join(` ${ARROW} `)}` : '';

  return `Ticket subject: ${gap.subject || '(none)'}\n`
    + `Resolution note:\n${gap.resolution || '(none)'}${menus}\n\n`
    + 'Draft the article.';
}

async function callGapLLM(gap) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: GAP_SYSTEM,
    tools: [GAP_TOOL],
    tool_choice: { type: 'tool', name: GAP_TOOL_NAME },
    messages: [{ role: 'user', content: gapPrompt(gap) }]
  };

  const response = await $request.invokeTemplate('anthropicMessages', {
    body: JSON.stringify(body)
  });
  const data = JSON.parse(response.response);
  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === GAP_TOOL_NAME);

  return block ? block.input : null;
}

function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/[.!?]+$/, ''))
    .filter((s) => s !== '');
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Deterministic fallback: the resolution's sentences become the steps, with
// any menu path the extractor found as the first one.
function templateGapArticle(gap) {
  const steps = sentencesOf(gap.resolution).map(capitalise);
  const menus = gap.steps || [];

  if (menus.length) {
    steps.unshift(`Go to ${menus.map((l) => `**${l}**`).join(` ${ARROW} `)}`);
  }

  return {
    title: `How to resolve: ${String(gap.subject || 'untitled issue').trim()}`,
    steps,
    verification: ['Confirm with the customer that the issue is resolved.']
  };
}

function gapMarkdown(article) {
  const steps = article.steps.map((s, i) => `${i + 1}. ${String(s).trim().replace(/^\d+\.\s*/, '')}`);
  const checks = article.verification.map((v) => `- ${String(v).trim().replace(/^[-*]\s*/, '')}`);

  return `# ${String(article.title).trim()}\n\n## ${STEPS}\n${steps.join('\n')}\n\n## ${VERIFICATION}\n${checks.join('\n')}\n`;
}

// Parses a (possibly hand-edited) gap draft back into its parts and says what
// is missing. A draft that fails cannot be approved.
function validateGapArticle(markdown) {
  const text = String(markdown || '');
  const titleLine = text.split('\n').find((l) => /^#\s+\S/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : '';
  const section = (name) => {
    const m = new RegExp(`(?:^|\\n)## ${name}[ \\t]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text);

    return m ? m[1] : '';
  };
  const steps = section(STEPS).split('\n').filter((l) => /^\s*\d+\.\s+\S/.test(l));
  const verification = section(VERIFICATION).split('\n').filter((l) => l.trim() !== '');
  const errors = [];

  if (!title) {
    errors.push('missing a "# Title" line');
  }
  if (!steps.length) {
    errors.push(`the "## ${STEPS}" section needs at least one numbered step`);
  }
  if (!verification.length) {
    errors.push(`the "## ${VERIFICATION}" section is empty or missing`);
  }

  return { passed: errors.length === 0, errors, title };
}

function usableDraft(draft) {
  return draft !== null && typeof draft.title === 'string' && draft.title.trim() !== ''
    && Array.isArray(draft.steps) && draft.steps.length > 0
    && Array.isArray(draft.verification) && draft.verification.length > 0;
}

// gap: { subject, resolution, steps } - resolution already redacted.
async function draftGapArticle(gap) {
  const viaModel = await callGapLLM(gap).catch(() => null);
  const mode = usableDraft(viaModel) ? 'llm' : 'template';
  const article = mode === 'llm' ? viaModel : templateGapArticle(gap);
  const markdown = gapMarkdown(article);
  const result = validateGapArticle(markdown);

  return {
    title: result.title,
    markdown,
    mode,
    passed: result.passed,
    errors: result.errors,
    attempts: mode === 'llm' ? 1 : 0
  };
}

const api = {
  draftAndValidate,
  templatePatch,
  stepsBodyRange,
  draftGapArticle,
  templateGapArticle,
  validateGapArticle,
  gapMarkdown
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
