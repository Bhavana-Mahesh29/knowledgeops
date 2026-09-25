// scripts/vobiz-test-call.js
// Places one real test call with the credentials in .env, through the same
// relay the app uses. Checks the Vobiz account, the caller number and the
// relay end to end before relying on them for alerts.
//
//   node scripts/vobiz-test-call.js +91XXXXXXXXXX https://<relay-host>
//
// .env needs VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN and VOBIZ_NUMBER. The FDK app
// cannot read .env - enter the same values on the app's settings page.
'use strict';

const fs = require('fs');
const path = require('path');

function readEnv() {
  const file = path.resolve(__dirname, '..', '.env');
  const env = {};

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);

    if (m) {
      env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }

  return env;
}

async function main() {
  const [to, relay] = process.argv.slice(2);

  if (!to || !relay) {
    console.error('usage: node scripts/vobiz-test-call.js <to-number> <relay-https-url>');
    process.exit(1);
  }

  // Vobiz only answers "answer_url parameter is not valid" for a relay it
  // cannot use, so check it here first and say what is actually wrong.
  const base = relay.replace(/\/+$/, '');
  const health = await fetch(`${base}/health`).catch((err) => ({ ok: false, status: err.cause ? err.cause.code : err.message }));

  if (!/^https:\/\//.test(base) || !health.ok) {
    console.error(`The relay at ${base} is not reachable (${health.status}). Check the URL - ngrok's free domains end in .ngrok-free.app or .ngrok-free.dev - and that "node scripts/voice-relay.js" and ngrok are running.`);
    process.exit(1);
  }

  const env = readEnv();
  const text = 'Hello, this is Knowledge Ops. This is a test call. Phone alerts are working.';
  const response = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}/Call/`, {
    method: 'POST',
    headers: {
      'X-Auth-ID': env.VOBIZ_AUTH_ID,
      'X-Auth-Token': env.VOBIZ_AUTH_TOKEN,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: String(env.VOBIZ_NUMBER || '').replace(/\D/g, ''),
      to: `+${to.replace(/\D/g, '')}`,
      answer_url: `${relay.replace(/\/+$/, '')}/voice/answer?text=${encodeURIComponent(text)}`,
      answer_method: 'GET'
    })
  });

  console.log(`HTTP ${response.status}: ${await response.text()}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
