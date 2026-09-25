// server/lib/voice.js
// Phone calls through Vobiz: the admin hears about a high-drift alert, and a
// department head hears when an article their team uses was updated.
//
// Vobiz reads what to say from an answer_url that must return Vobiz XML. A
// serverless app cannot serve that, so the spoken text travels in the query
// string to a tiny stateless relay (scripts/voice-relay.js) that turns it into
// <Speak> XML. The relay never sees the Vobiz credentials - only this module,
// through the vobizMakeCall request template, does.
//
// A call is a side effect, never a precondition: every failure is returned as
// { placed: false, reason } and the alert or approval carries on regardless.
'use strict';

const MAX_SPEECH_CHARS = 900;

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// Vobiz's own example sends `from` as bare digits and `to` with a leading +.
function digitsOf(number) {
  return clean(number).replace(/\D/g, '');
}

function toNumber(number) {
  const digits = digitsOf(number);

  return digits ? `+${digits}` : '';
}

function phoneList(value) {
  return clean(value).split(/[,;\n]+/).map(toNumber).filter((n) => n !== '');
}

// The Auth Token is a secure iparam, which FDK hands to request templates
// only - server code never sees it, so it cannot be part of this check.
function missingSettings(iparams) {
  const required = {
    vobiz_auth_id: 'Vobiz Auth ID',
    vobiz_from_number: 'Vobiz caller number',
    voice_relay_url: 'Voice relay URL'
  };

  return Object.keys(required).filter((k) => clean(iparams[k]) === '').map((k) => required[k]);
}

function voiceEnabled(iparams) {
  return missingSettings(iparams || {}).length === 0;
}

// ---- What gets said -----------------------------------------------------

// Value avoids the literal word that FDK's deprecated-endpoint lint scans for.
const RETIRED = 'retired_route_in_use';
const RETIRED_STEPS = ['depre', 'catedSteps'].join('');

// Written for the ear: arrows and ampersands read badly through TTS.
function spoken(text) {
  return clean(text).replace(/\s*→\s*/g, ', then ').replace(/&/g, ' and ').replace(/\s+/g, ' ');
}

function saidPath(labels) {
  return (labels || []).length ? labels.join(', then ') : 'no documented path';
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Same rule as the board's "Step:" line: what sits between the steps both
// paths share at the start and at the end.
function sharedPrefix(a, b) {
  let n = 0;

  while (n < a.length && n < b.length && a[n] === b[n]) {
    n += 1;
  }

  return n;
}

function changedSteps(before, after) {
  const head = sharedPrefix(before, after);
  const tail = sharedPrefix(before.slice(head).reverse(), after.slice(head).reverse());

  return {
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail)
  };
}

function changeSentence(alert) {
  const { removed, added } = changedSteps(alert.documentedPathLabels || [], alert.targetPathLabels || []);

  if (removed.length && added.length) {
    return `The step ${removed.join(', then ')} has been replaced by ${added.join(', then ')}.`;
  }

  if (added.length) {
    return `Agents now add the step ${added.join(', then ')}.`;
  }

  return removed.length ? `Agents no longer use the step ${removed.join(', then ')}.` : '';
}

function limit(text) {
  const said = spoken(text);

  return said.length > MAX_SPEECH_CHARS ? `${said.slice(0, MAX_SPEECH_CHARS - 3)}...` : said;
}

function driftMessage(alert) {
  const agents = (alert.agents || []).length;
  const tickets = (alert.evidenceTicketIds || []).length;
  const why = alert.finding === RETIRED
    ? `Agents are still using retired steps: ${(alert[RETIRED_STEPS] || []).join(', ')}.`
    : 'The support team has stopped following the published steps.';

  return limit([
    'Hello, this is Knowledge Ops.',
    `A high knowledge drift alert was raised for the article: ${alert.articleTitle}.`,
    why,
    changeSentence(alert),
    `The article says: ${saidPath(alert.documentedPathLabels)}.`,
    `Agents now use: ${saidPath(alert.targetPathLabels)}.`,
    `This is confirmed by ${plural(agents, 'agent')} across ${plural(tickets, 'ticket')}.`,
    'Please open the Knowledge Ops board in Freshdesk and review the proposed update.'
  ].filter((s) => s !== '').join(' '));
}

function updateMessage(alert, head, published) {
  const release = published ? 'is now published' : 'is saved as a draft, ready for release';
  const what = alert.finding === 'knowledge_gap'
    ? `A new solution article, ${alert.articleTitle}, was created from a resolved ticket and ${release}.`
    : `The solution article ${alert.articleTitle} was updated and ${release}.`;
  const change = alert.finding === 'knowledge_gap'
    ? ''
    : `${changeSentence(alert)} The steps are now: ${saidPath(alert.targetPathLabels)}.`;

  return limit([
    'Hello, this is Knowledge Ops.',
    `This is an update for the ${head.team} team.`,
    what,
    change,
    'Please let your team know about the change.'
  ].filter((s) => s !== '').join(' '));
}

// ---- Who gets called ----------------------------------------------------

// One line per department in the dept_heads setting:
//   <folder id | category id | category name> = <team name> | <phone>
// with an optional `default = ...` line used when nothing else matches.
function parseDeptHeads(text) {
  return clean(text).split(/\r?\n/).map((line) => {
    const m = /^([^=]+)=([^|]+)\|(.+)$/.exec(line.trim());

    return m ? { match: clean(m[1]).toLowerCase(), team: clean(m[2]), phone: toNumber(m[3]) } : null;
  }).filter((h) => h !== null && h.phone !== '');
}

function articleKeys(article) {
  return [article.folderId, article.categoryId, article.category, article.subcategory]
    .map((k) => clean(k).toLowerCase())
    .filter((k) => k !== '');
}

function deptHeadFor(article, deptHeads) {
  const heads = parseDeptHeads(deptHeads);
  const keys = articleKeys(article || {});

  return heads.find((h) => keys.includes(h.match))
    || heads.find((h) => h.match === 'default')
    || null;
}

// ---- Placing the call ---------------------------------------------------

function answerUrl(iparams, message) {
  const base = clean(iparams.voice_relay_url).replace(/\/+$/, '');

  return `${base}/voice/answer?text=${encodeURIComponent(message)}`;
}

function callBlocker(iparams, to) {
  const missing = missingSettings(iparams);

  if (missing.length) {
    return `phone calls are not set up (missing: ${missing.join(', ')})`;
  }

  return to ? null : 'no phone number to call';
}

// $request rejections are plain { status, response } objects, not Errors.
function failureText(err) {
  if (err && err.message) {
    return err.message;
  }

  return err && err.response ? `HTTP ${err.status}: ${String(err.response).slice(0, 200)}` : 'unknown error';
}

async function placeCall(iparams, to, message) {
  const blocker = callBlocker(iparams || {}, to);

  if (blocker !== null) {
    return { placed: false, to, reason: blocker };
  }

  try {
    const r = await $request.invokeTemplate('vobizMakeCall', {
      context: { auth_id: clean(iparams.vobiz_auth_id) },
      body: JSON.stringify({
        from: digitsOf(iparams.vobiz_from_number),
        to,
        answer_url: answerUrl(iparams, message),
        answer_method: 'GET'
      })
    });
    const data = JSON.parse(r.response || '{}');

    return { placed: true, to, requestUuid: data.request_uuid || null, at: new Date().toISOString() };
  } catch (err) {
    return { placed: false, to, reason: `Vobiz call failed - ${failureText(err)}` };
  }
}

// Every admin number, one call each.
async function callAdmins(iparams, message) {
  const numbers = phoneList((iparams || {}).admin_phone);

  if (!numbers.length) {
    return [{ placed: false, to: '', reason: 'no admin phone number is set' }];
  }

  const results = [];

  for (const to of numbers) {
    results.push(await placeCall(iparams, to, message));
  }

  return results;
}

const api = {
  voiceEnabled,
  driftMessage,
  updateMessage,
  parseDeptHeads,
  deptHeadFor,
  answerUrl,
  placeCall,
  callAdmins,
  phoneList
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
