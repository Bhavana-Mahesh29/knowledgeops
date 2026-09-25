// scripts/voice-relay.js
// The answer_url Vobiz fetches when a KnowledgeOps phone alert connects.
//
//   GET /voice/answer?text=<message>   ->   <Response><Speak>message</Speak>...</Response>
//
// Stateless and credential-free: the FDK app puts the whole message in the
// query string, this turns it into Vobiz XML and says it twice so the person
// who picked up mid-sentence still hears all of it. Run it anywhere Vobiz can
// reach over https, e.g.
//
//   node scripts/voice-relay.js        (listens on PORT, default 3000)
//   ngrok http 3000                    (paste the https URL into "Voice relay URL")
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT) || 3000;
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

function handle(req, res) {
  const url = new URL(req.url, 'http://relay.local');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname !== '/voice/answer') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  // The message rides in the query string whichever method Vobiz uses; the
  // POST body only carries Vobiz's own call details, which are not needed.
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(answerXml(url.searchParams.get('text')));
  });
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`KnowledgeOps voice relay on http://localhost:${PORT}/voice/answer`);
  });
}

module.exports = { answerXml, handle };
