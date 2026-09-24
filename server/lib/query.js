// server/lib/query.js
// Builds the two texts semantic matching compares: the resolution query for a
// ticket, and the embedding text for a knowledge-base article.
//
// Both sides are cut down to what describes the procedure. A ticket's query is
// its subject plus the final resolution note - never the whole conversation -
// and an article's text is its title, category and instructions. Greetings,
// sign-offs, quoted email history and helpdesk boilerplate are stripped from
// both, because in an embedding they read as similarity between texts that
// share nothing but politeness.
'use strict';

const { redact } = require('./redact');
const { htmlToMarkdown } = require('./markdown');
const { splitSections, STEPS } = require('./validator');

const LOOKS_LIKE_HTML = /<\/?[a-z][^>]*>/i;

// Everything from the first of these lines onwards is history or signature.
const CUT_FROM = [
  /^on .{1,200} wrote:?\s*$/i,
  /^-{2,}\s*(?:original message|forwarded message)/i,
  /^(?:from|sent|to|cc|date):\s.+$/i,
  /^sent from my\b/i,
  /^--\s*$/,
  /^(?:thanks|thank you|many thanks|regards|best regards|kind regards|warm regards|best|cheers|sincerely)[,!.]?\s*(?:\S+\s*)?$/i
];

const GREETING_LINE = /^(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))\b[^\n.!?]{0,40}[,!.]?\s*$/i;
const GREETING_PREFIX = /^(?:hi|hello|hey|dear)\s+[^,\n]{0,30},\s*/i;
const SUBJECT_PREFIX = /^(?:(?:re|fw|fwd)\s*:\s*)+/i;

// Sentences that carry no procedure. Matched per sentence, so a useful
// sentence that happens to share a line with one of these survives.
const BOILERPLATE = [
  /\bhope (?:this|that) helps\b/i,
  /\blet (?:me|us) know if\b/i,
  /\bdon'?t hesitate to\b/i,
  /\bthank(?:s| you) for (?:contacting|reaching out|your patience|writing)\b/i,
  /\b(?:we )?apologi[sz]e for (?:the|any) inconvenience\b/i,
  /\bthis is an automated\b/i,
  /\bticket #?\w+ has been (?:resolved|closed|updated)\b/i,
  /\bplease rate\b/i,
  /\bhave a (?:great|good|nice) day\b/i
];

function stripHistory(lines) {
  const cut = lines.findIndex((line) => CUT_FROM.some((re) => re.test(line.trim())));

  return cut === -1 ? lines : lines.slice(0, cut);
}

function stripGreetings(lines) {
  return lines
    .filter((line) => !GREETING_LINE.test(line.trim()) && !/^\s*>/.test(line))
    .map((line) => line.replace(GREETING_PREFIX, ''));
}

function stripBoilerplate(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !BOILERPLATE.some((re) => re.test(sentence)))
    .join(' ');
}

function cleanSupportText(text) {
  const raw = String(text || '');
  const plain = LOOKS_LIKE_HTML.test(raw) ? htmlToMarkdown(raw) : raw;
  const lines = stripGreetings(stripHistory(plain.replace(/\r\n?/g, '\n').split('\n')));

  return stripBoilerplate(lines.join('\n'))
    .replace(/\*\*|__|[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Resolution query ---------------------------------------------------

function isPublicAgentMessage(c) {
  return c && typeof c === 'object' && !c.incoming && !c.private;
}

function lastAgentReply(conversation) {
  if (!Array.isArray(conversation)) {
    return '';
  }

  const replies = conversation.filter(isPublicAgentMessage);
  const last = replies[replies.length - 1];

  return last ? (last.body_text || last.body || '') : '';
}

// The resolution note is authoritative. Only when there is none does the
// last public agent reply stand in for it - never the whole thread.
function resolutionSource(ticket) {
  return ticket.resolution_note || ticket.resolution || lastAgentReply(ticket.conversation);
}

// Redacted here, once, because this text leaves the app twice: to the
// embedding provider and to the relevance gate.
function buildResolutionQuery(ticket) {
  const subject = redact(cleanSupportText(String(ticket.subject || '').replace(SUBJECT_PREFIX, ''))).redactedText;
  const resolution = redact(cleanSupportText(resolutionSource(ticket))).redactedText;

  return {
    subject,
    resolution,
    text: `Subject: ${subject}\nResolution: ${resolution}`,
    empty: resolution === ''
  };
}

// ---- Article side -------------------------------------------------------

function firstPresent(...values) {
  return values.find((v) => v !== null && v !== undefined && String(v) !== '');
}

// Freshdesk-synced articles ({ articleId, markdown }), dataset articles
// ({ article_id, body }) and raw API payloads ({ id, description }) all come
// out in one shape.
function normaliseKbArticle(a) {
  const body = firstPresent(a.body, a.markdown, a.description ? htmlToMarkdown(a.description) : '') || '';

  return {
    article_id: String(firstPresent(a.article_id, a.articleId, a.id)),
    title: String(a.title || ''),
    category: String(a.category || ''),
    subcategory: String(a.subcategory || ''),
    body: String(body)
  };
}

// An article with a Steps section is embedded on its Overview and Steps; the
// rest (troubleshooting, related links) describes other situations.
function articleProcedure(body) {
  const sections = splitSections(body);

  if (sections[STEPS] === undefined) {
    return cleanSupportText(body);
  }

  return cleanSupportText(`${sections.Overview || ''}\n${sections[STEPS]}`);
}

function articleEmbeddingText(article) {
  const a = normaliseKbArticle(article);
  const category = [a.category, a.subcategory].filter((c) => c !== '').join(' > ');

  return `Title: ${a.title}\nCategory: ${category}\nProcedure: ${articleProcedure(a.body)}`;
}

const api = {
  cleanSupportText,
  buildResolutionQuery,
  normaliseKbArticle,
  articleProcedure,
  articleEmbeddingText
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
