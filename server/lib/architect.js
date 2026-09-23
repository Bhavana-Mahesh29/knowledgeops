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

const api = { draftAndValidate, templatePatch, stepsBodyRange };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
