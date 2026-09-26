// scripts/voice-relay.js
// The one public entry point KnowledgeOps needs while developing locally.
//
//   GET /voice/answer?text=<message>  ->  Vobiz <Speak> XML (phone alerts)
//   anything else, e.g. POST /event/hook/common
//                                     ->  forwarded to `fdk run` (FDK_URL)
//
// Free ngrok gives one URL. Vobiz needs it for the call script and the
// Freshdesk "ticket resolved" automation needs it for the webhook, so this
// serves the first and passes the second through to the local FDK server.
//
//   fdk run                            (FDK on http://localhost:10001)
//   node scripts/voice-relay.js        (listens on PORT, default 3000)
//   ngrok http 3000
//
// Then use the ngrok URL both as "Voice relay URL" in the app settings and,
// with /event/hook/common appended, as the Freshdesk automation webhook.
//
// The voice side is stateless and credential-free: the FDK app puts the whole
// message in the query string, and it is said twice so whoever picked up
// mid-sentence still hears all of it.
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT) || 3000;
const FDK_URL = process.env.FDK_URL || 'http://localhost:10001';
const MAX_CHARS = 1000;
const FALLBACK = 'Hello, this is Knowledge Ops. Please open the Knowledge Ops board in Freshdesk.';

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function answerXml(text) {
  const said = escapeXml(String(text || '').trim().slice(0, MAX_CHARS) || FALLBACK);

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Response>\n'
    + `  <Speak voice="WOMAN" language="en-US">${said}</Speak>\n`
    + '  <Speak voice="WOMAN" language="en-US">I will repeat that.</Speak>\n'
    + `  <Speak voice="WOMAN" language="en-US">${said}</Speak>\n`
    + '</Response>\n';
}

function speak(req, res, url) {
  // The message rides in the query string whichever method Vobiz uses; the
  // POST body only carries Vobiz's own call details, which are not needed.
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(answerXml(url.searchParams.get('text')));
  });
}

// Streams the request to the FDK server unchanged and its answer back. The
// Host header is rewritten so FDK sees a request for itself, not for ngrok.
function forward(req, res, upstream) {
  const target = new URL(req.url, upstream);
  const headers = Object.assign({}, req.headers, { host: target.host });
  const proxied = http.request(target, { method: req.method, headers }, (answer) => {
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });

  proxied.on('error', (err) => {
    console.error(`[relay] ${req.method} ${req.url} -> ${upstream} failed: ${err.message} (is "fdk run" running?)`);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`FDK server not reachable at ${upstream} - start it with "fdk run"`);
  });

  req.pipe(proxied);
}

function createHandler(upstream = FDK_URL) {
  return function handle(req, res) {
    const url = new URL(req.url, 'http://relay.local');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/voice/answer') {
      speak(req, res, url);
      return;
    }

    console.log(`[relay] ${req.method} ${url.pathname} -> ${upstream}`);
    forward(req, res, upstream);
  };
}

const handle = createHandler();

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`KnowledgeOps relay on http://localhost:${PORT}`);
    console.log(`  /voice/answer        -> Vobiz call script`);
    console.log(`  everything else      -> ${FDK_URL} (fdk run)`);
  });
}

module.exports = { answerXml, handle, createHandler };
