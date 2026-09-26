// tests/voice.test.js
// The pure parts of phone alerting: who gets called, what is said, and the
// relay's XML.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const voice = require('../server/lib/voice.js');
const relay = require('../scripts/voice-relay.js');

describe('department heads', () => {
  const HEADS = [
    '68000075564 = IT Support | +91 98000 00002',
    'Billing = Finance | 919800000004',
    'not a valid line',
    'default = Support Ops | +919800000009'
  ].join('\n');

  test('lines parse into team and phone, junk lines are ignored', () => {
    expect(voice.parseDeptHeads(HEADS)).toEqual([
      { match: '68000075564', team: 'IT Support', phone: '+919800000002' },
      { match: 'billing', team: 'Finance', phone: '+919800000004' },
      { match: 'default', team: 'Support Ops', phone: '+919800000009' }
    ]);
  });

  test('folder id, then category name, then the default', () => {
    expect(voice.deptHeadFor({ folderId: '68000075564' }, HEADS).team).toBe('IT Support');
    expect(voice.deptHeadFor({ category: 'BILLING' }, HEADS).team).toBe('Finance');
    expect(voice.deptHeadFor({ category: 'Account' }, HEADS).team).toBe('Support Ops');
    expect(voice.deptHeadFor({ category: 'Account' }, 'Billing = Finance | +1')).toBeNull();
  });

  test('admin phone numbers accept commas and spaces', () => {
    expect(voice.phoneList('+91 98000 00001, 919800000002')).toEqual(['+919800000001', '+919800000002']);
  });
});

describe('what is said', () => {
  const ALERT = {
    articleTitle: 'Update billing address',
    finding: 'article_stale',
    documentedPathLabels: ['Settings', 'Billing', 'Address'],
    targetPathLabels: ['Settings', 'Payments', 'Address'],
    evidenceTicketIds: ['1', '2', '3', '4'],
    agents: ['a', 'b', 'c']
  };

  test('the admin hears the article, the changed step and the evidence', () => {
    const said = voice.driftMessage(ALERT);

    expect(said).toContain('for the article: Update billing address');
    expect(said).toContain('The step Billing has been replaced by Payments.');
    expect(said).toContain('confirmed by 3 agents across 4 tickets');
  });

  test('the department head hears which article changed and how', () => {
    const said = voice.updateMessage(ALERT, { team: 'Finance' }, false);

    expect(said).toContain('update for the Finance team');
    expect(said).toContain('Update billing address was updated and is saved as a draft');
    expect(said).toContain('The steps are now: Settings, then Payments, then Address');
  });

  test('the answer url carries the message for the relay', () => {
    const url = new URL(voice.answerUrl({ voice_relay_url: 'https://r.example.com/' }, 'Hi & bye'));

    expect(url.origin + url.pathname).toBe('https://r.example.com/voice/answer');
    expect(url.searchParams.get('text')).toBe('Hi & bye');
  });
});

describe('voice relay', () => {
  test('speaks the message twice, XML-escaped', () => {
    const xml = relay.answerXml('Profile <Security> & "Reset"');

    expect(xml).toContain('<Response>');
    expect(xml.match(/Profile &lt;Security&gt; &amp; &quot;Reset&quot;/g)).toHaveLength(2);
    expect(xml).not.toContain('<Security>');
  });

  test('an empty message falls back to a generic prompt', () => {
    expect(relay.answerXml('')).toContain('Please open the Knowledge Ops board');
  });
});

// One ngrok URL serves Vobiz and the Freshdesk webhook: everything that is not
// the call script is passed through to `fdk run`.
describe('voice relay forwarding', () => {
  const http = require('node:http');
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, () => resolve(server));
  });
  const post = (port, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';

      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.end(body);
  });

  test('the Freshdesk webhook reaches the FDK server unchanged', async () => {
    const seen = [];
    const fdk = await listen((req, res) => {
      let body = '';

      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const front = await listen(relay.createHandler(`http://localhost:${fdk.address().port}`));

    const answer = await post(front.address().port, '/event/hook/common', '{"ticket_id":"42"}');

    expect(answer).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seen).toEqual([{ method: 'POST', url: '/event/hook/common', body: '{"ticket_id":"42"}' }]);
    fdk.close();
    front.close();
  });

  test('a stopped FDK server is reported as a 502 that says what to start', async () => {
    const front = await listen(relay.createHandler('http://localhost:9'));
    const answer = await post(front.address().port, '/event/hook/common', '{}');

    expect(answer.status).toBe(502);
    expect(answer.body).toContain('fdk run');
    front.close();
  });
});
