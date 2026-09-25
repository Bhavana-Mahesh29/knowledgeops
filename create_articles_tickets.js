// create_articles_tickets.js
// Creates the KnowledgeOps demo tickets (see demo_scenarios.js) in Freshdesk
// and leaves every one of them Open. Run reslove_tickets.js next to post the
// agents' resolutions; resolving a ticket in Freshdesk is what makes
// KnowledgeOps analyse it.
//
//   node create_articles_tickets.js
//
// Created ids are written to data/demo_tickets.json. Running again refuses
// to create duplicates unless you pass --force.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DOMAIN, TAG, SCENARIOS } = require('./demo_scenarios');

// ==================== CONFIGURATION ====================
const FRESHDESK_DOMAIN = DOMAIN;
const API_KEY = 'fwapi_1RY2zqkqfM3UjPf447qNK5_1022750354893064294_7b31579f'; // Replace with your Freshdesk API key
// =======================================================

const OUT_FILE = path.join(__dirname, 'data', 'demo_tickets.json');
const OPEN = 2;
const MEDIUM = 2;

const authHeader = {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`${process.env.FRESHDESK_API_KEY || API_KEY}:X`).toString('base64')}`
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alreadyCreated() {
  if (!fs.existsSync(OUT_FILE) || process.argv.includes('--force')) {
    return false;
  }

  const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));

  console.log(`data/demo_tickets.json already lists ${existing.length} demo tickets (${existing.map((t) => `#${t.ticketId}`).join(', ')}).`);
  console.log('Not creating duplicates. Pass --force to create a fresh set anyway.');
  return true;
}

async function createTicket(scenario) {
  const res = await axios.post(
    `https://${FRESHDESK_DOMAIN}/api/v2/tickets`,
    {
      subject: scenario.subject,
      description: scenario.description,
      email: scenario.requester,
      responder_id: scenario.responder,
      priority: MEDIUM,
      status: OPEN,
      tags: [TAG]
    },
    authHeader
  );

  return res.data.id;
}

async function createTickets() {
  if (alreadyCreated()) {
    return;
  }

  console.log(`Creating ${SCENARIOS.length} open demo tickets on ${FRESHDESK_DOMAIN}...\n`);

  const created = [];

  for (const [index, scenario] of SCENARIOS.entries()) {
    try {
      const ticketId = await createTicket(scenario);

      created.push({ key: scenario.key, ticketId, group: scenario.group, articleId: scenario.article ? scenario.article.id : null });
      console.log(`[${index + 1}/${SCENARIOS.length}] Ticket #${ticketId} created (Open) - ${scenario.group}`);
      console.log(`   Subject: "${scenario.subject}"\n`);
    } catch (err) {
      console.error(`Failed to create "${scenario.subject}":`, err.response?.status, JSON.stringify(err.response?.data || err.message));
    }

    await sleep(1000);
  }

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(created, null, 2)}\n`);
  console.log(`${created.length} tickets created and left Open. Ids saved to data/demo_tickets.json.`);
  console.log('Next: node reslove_tickets.js  (posts the agent resolutions, status stays Open)');
}

createTickets();
