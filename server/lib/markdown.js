// server/lib/markdown.js
// Freshdesk stores article bodies as HTML; every stage after ingest (the
// validator, the architect, the diff shown on the board) works on markdown.
// This module is the only place that conversion happens, in both directions.
'use strict';

const tax = require('./taxonomy');
const { splitSections, STEPS } = require('./validator');

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': '\'',
  '&rarr;': '\u2192'
};

function decodeEntities(text) {
  return text.replace(/&(?:nbsp|amp|lt|gt|quot|#39|rarr);/g, (m) => ENTITIES[m] || m);
}

// <ol> items keep their numbering so the Steps section survives a round trip.
function numberOrderedItems(html) {
  return html.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, inner) => {
    let n = 0;

    return inner.replace(/<li[^>]*>/gi, () => {
      n += 1;
      return `\n${n}. `;
    });
  });
}

function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html) {
  const stripped = String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const withLists = numberOrderedItems(stripped).replace(/<li[^>]*>/gi, '\n- ');

  const text = withLists
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/gi, '\n## $1\n')
    .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(p|div|ul|ol|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return tidy(decodeEntities(text));
}

function inlineHtml(line) {
  return line
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>');
}

// Heading levels round-trip exactly: htmlToMarkdown maps <h1> to '# ' and
// everything below it to '## ', so emitting <h2>/<h3> here quietly demoted
// an article's title one level on every publish.
function lineToHtml(line) {
  const html = inlineHtml(line);

  if (html.startsWith('## ')) {
    return `<h2>${html.slice(3)}</h2>`;
  }

  if (html.startsWith('# ')) {
    return `<h1>${html.slice(2)}</h1>`;
  }

  return html.trim() ? `<p>${html.trim()}</p>` : '';
}

const ORDERED_ITEM = /^\s*\d+\.\s+/;

// Numbered steps go back to Freshdesk as a real <ol>. Rendering them as
// paragraphs published a visibly worse article each time, and the numbering
// is dropped here because htmlToMarkdown restores it from the list itself.
function listHtml(items) {
  return items.length ? [`<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>`] : [];
}

function markdownToHtml(md) {
  const out = [];
  let items = [];

  for (const line of String(md || '').split('\n')) {
    if (ORDERED_ITEM.test(line)) {
      items.push(inlineHtml(line.replace(ORDERED_ITEM, '')));
      continue;
    }

    out.push(...listHtml(items));
    items = [];

    const html = lineToHtml(line);

    if (html !== '') {
      out.push(html);
    }
  }

  return [...out, ...listHtml(items)].join('\n');
}

function splitTitleLine(head) {
  const lines = head.split('\n');

  if (lines[0].startsWith('# ')) {
    return { title: lines[0], rest: lines.slice(1).join('\n').trim() };
  }

  return { title: '', rest: head.trim() };
}

// Headings authors use for the procedure itself: "Step-by-Step Instructions",
// "Steps to reset", "Instructions", "Procedure".
const STEPS_LIKE = /^(?:step[- ]by[- ]step\b.*|steps?\b.*|instructions|procedure)$/i;

// The heading an article really uses for its procedure, when that is not
// already "Steps". Kept so a published patch can put the author's heading
// back instead of renaming it.
function stepsHeadingOf(md) {
  const sections = splitSections(String(md || '').trim());

  if (sections[STEPS] !== undefined) {
    return null;
  }

  return Object.keys(sections).find((h) => h !== '_head' && STEPS_LIKE.test(h)) || null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
}

function renameHeading(md, from, to) {
  const heading = new RegExp('(^|\\n)## ' + escapeRegExp(from) + '[ \\t]*(?=\\n|$)');

  return md.replace(heading, `$1## ${to}`);
}

// Publishing side of stepsHeadingOf: the stored copy calls the section
// "Steps"; Freshdesk gets the author's heading back.
function restoreStepsHeading(md, heading) {
  return heading ? renameHeading(String(md || ''), STEPS, heading) : md;
}

// The strict validator compares section headings between the original and the
// patch, and only lets the Steps section change. A Freshdesk article authored
// without a "Steps" heading would therefore be unpatchable, so the stored
// baseline always gets one - the author's own procedure heading when there is
// one, a new empty section otherwise.
function normaliseArticleMarkdown(md, articleTitle) {
  const body = String(md || '').trim();
  const sections = splitSections(body);

  if (sections[STEPS] !== undefined) {
    return body;
  }

  const authored = stepsHeadingOf(body);

  if (authored !== null) {
    return renameHeading(body, authored, STEPS);
  }

  if (Object.keys(sections).length > 1) {
    return `${body}\n\n## ${STEPS}\n`;
  }

  const { title, rest } = splitTitleLine(sections._head);
  const heading = title || `# ${articleTitle || 'Untitled article'}`;

  return `${heading}\n\n## ${STEPS}\n${rest}\n`;
}

// The path the article currently documents = the bold spans in its Steps
// section, resolved against the taxonomy. Unlike the validator's own
// extraction this keeps deprecated nodes, because a stale article documenting
// a deprecated menu item is exactly the case drift detection exists for.
function documentedPathOf(md) {
  const stepsBody = splitSections(md)[STEPS] || '';
  const nodes = [];
  const bold = /\*\*(.+?)\*\*/g;
  let m;

  // A menu named again later ("the change shows on the **Profile** page") is
  // a mention, not a second visit, so only its first appearance counts.
  while ((m = bold.exec(stepsBody)) !== null) {
    const node = tax.lookup(m[1]);

    if (node !== null && !nodes.includes(node)) {
      nodes.push(node);
    }
  }

  return nodes;
}

const api = {
  htmlToMarkdown,
  markdownToHtml,
  normaliseArticleMarkdown,
  documentedPathOf,
  stepsHeadingOf,
  restoreStepsHeading
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
