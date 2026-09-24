// server/lib/validator.js
// Stage 5: Strict Validator. Plain JS, no LLM. Direct port of
// engine/validator.py's four checks.
'use strict';
const tax = require('./taxonomy');

const BOLD = /\*\*(.+?)\*\*/g;
const SECTION_SPLIT = /(?:^|\n)## /;
const STEPS = 'Steps';

function splitSections(md) {
  const parts = String(md === undefined || md === null ? '' : md).split(SECTION_SPLIT);
  const out = { _head: parts[0] };

  for (const p of parts.slice(1)) {
    const idx = p.indexOf('\n');
    const title = (idx === -1 ? p : p.slice(0, idx)).trim();
    const body = idx === -1 ? '' : p.slice(idx + 1);

    out[title] = body;
  }

  return out;
}

// Check 1 + 2: the set of headings is untouched and nothing outside Steps moved.
function sectionErrors(oldSec, newSec) {
  const errors = [];
  const oldKeys = Object.keys(oldSec).sort().join(',');
  const newKeys = Object.keys(newSec).sort().join(',');

  if (oldKeys !== newKeys) {
    errors.push(`section headings changed: ${oldKeys} vs ${newKeys}`);
    return errors;
  }

  for (const heading of Object.keys(oldSec)) {
    if (heading !== STEPS && oldSec[heading] !== newSec[heading]) {
      errors.push(`section '${heading}' was modified outside ${STEPS}`);
    }
  }

  return errors;
}

// Check 3: every bold span in Steps must be a live (non-deprecated) taxonomy node.
function boldNodes(stepsBody) {
  const errors = [];
  const nodes = [];
  let m;

  BOLD.lastIndex = 0;
  while ((m = BOLD.exec(stepsBody)) !== null) {
    const span = m[1];
    const node = tax.lookup(span);

    if (node === null) {
      errors.push(`unmapped UI label in bold: '${span}'`);
    } else if (tax.isDeprecated(node)) {
      errors.push(`deprecated step used in patch: '${span}'`);
    } else {
      nodes.push(node);
    }
  }

  return { nodes, errors };
}

function validatePatch(originalMd, patchedMd, expectedNodes) {
  const oldSec = splitSections(originalMd);
  const newSec = splitSections(patchedMd);
  const { nodes, errors: labelErrors } = boldNodes(newSec[STEPS] || '');
  const errors = [...sectionErrors(oldSec, newSec), ...labelErrors];

  // Check 4: the bold spans must spell out the target path exactly, in order.
  if (JSON.stringify(nodes) !== JSON.stringify(expectedNodes)) {
    errors.push(`path mismatch: got [${nodes}], expected [${expectedNodes}]`);
  }

  return { passed: errors.length === 0, errors, extractedNodes: nodes };
}

// A brand-new article has no original to compare sections against, so checks
// 1 and 2 become "there is a title and a non-empty Steps section". Checks 3
// and 4 are unchanged: bold in Steps is reserved for live taxonomy nodes, and
// they must spell out the path the agent walked, in order.
function validateNewArticle(md, expectedNodes) {
  const sections = splitSections(md);
  const errors = [];

  if (!/^# \S/m.test(sections._head || '')) {
    errors.push('missing a "# Title" line at the top');
  }

  if (!String(sections[STEPS] || '').trim()) {
    errors.push(`missing a non-empty '## ${STEPS}' section`);
  }

  const { nodes, errors: labelErrors } = boldNodes(sections[STEPS] || '');

  errors.push(...labelErrors);

  if (JSON.stringify(nodes) !== JSON.stringify(expectedNodes)) {
    errors.push(`path mismatch: got [${nodes}], expected [${expectedNodes}]`);
  }

  return { passed: errors.length === 0, errors, extractedNodes: nodes };
}

const api = { validatePatch, validateNewArticle, splitSections, boldNodes, STEPS };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
