// lib/redact.js
// Stage 1: strip PII before any text reaches Claude or is stored.
// Regex-based (no Python/Presidio available inside a Node serverless
// function). State this limitation plainly in the pitch: this catches
// common patterns (names via a simple heuristic, phone, email, Aadhaar
// with checksum, PAN) but is not NER-grade. Runs BEFORE any translation
// or extraction call — that order is a hard rule.
'use strict';

// Verhoeff checksum, used to validate Aadhaar-shaped numbers
const D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
];
const P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
function verhoeffValid(digits) {
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c][P[i % 8][parseInt(reversed[i], 10)]];
  }
  return c === 0;
}

const PATTERNS = [
  { type: 'IN_AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    validate: (m) => verhoeffValid(m.replace(/\D/g, '')) },
  { type: 'IN_PAN', re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, validate: () => true },
  { type: 'EMAIL', re: /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g, validate: () => true },
  { type: 'PHONE', re: /\b(?:\+?\d{1,3}[-\s]?)?\d{5}[-\s]?\d{5}\b/g, validate: () => true },
  // Simple name heuristic: "- FirstName" or ", FirstName" sign-offs common in agent replies.
  // This is deliberately narrow to avoid false positives; NER is the production upgrade.
  { type: 'PERSON_SIGNOFF', re: /[,-]\s*([A-Z][a-z]+)\s*$/gm, validate: () => true },
];

function redact(text) {
  let redacted = text;
  const counts = {};
  for (const { type, re, validate } of PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      if (!validate(match)) return match;
      counts[type] = (counts[type] || 0) + 1;
      return `[ANONYMIZED_${type}]`;
    });
  }
  return { redactedText: redacted, entityCounts: counts };
}

const api = { redact };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}

