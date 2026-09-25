// reslove_tickets.js
// Posts each demo ticket's agent resolution (see demo_scenarios.js) as a
// public reply from the assigned agent. The ticket status is NOT changed -
// every ticket stays Open until someone resolves it in Freshdesk, which is
// the moment KnowledgeOps analyses it.
//
//   node reslove_tickets.js
//
// Reads the ticket ids create_articles_tickets.js saved to
// data/demo_tickets.json, and records which ones have been answered so a
// second run does not post the same reply twice.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DOMAIN, SCENARIOS } = require('./demo_scenarios');

// ==================== CONFIGURATION ====================
const FRESHDESK_DOMAIN = DOMAIN;
const API_KEY = 'fwapi_1RY2zqkqfM3UjPf447qNK5_1022750354893064294_7b31579f'; // Replace with your Freshdesk API key
// =======================================================

const TICKETS_FILE = path.join(__dirname, 'data', 'demo_tickets.json');

const authHeader = {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`${process.env.FRESHDESK_API_KEY || API_KEY}:X`).toString('base64')}`
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPEN = 2;

// A Freddy AI Agent deployed on the helpdesk claims new tickets as they
// arrive ("Assigned to AI Agent"). Freshdesk refuses replies on those, and
// KnowledgeOps counts distinct agents by assignee, so each demo ticket is
// handed back to its human agent - still Open, never resolved.
async function reclaim(ticketId, scenario) {
  const url = `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}`;
  const { data } = await axios.get(url, authHeader);

  if (data.status === OPEN && data.responder_id === scenario.responder) {
    return false;
  }

  await axios.put(url, { status: OPEN, responder_id: scenario.responder }, authHeader);
  return true;
}

function cannotActAs(err) {
  const status = err.response?.status;

  return status === 400 || (status === 403 && err.response?.data?.code === 'invalid_user');
}

// Posts as the assigned agent when the API key is allowed to, otherwise as
// the key's owner. KnowledgeOps counts agents by the ticket's assignee, so
// either way the evidence is attributed correctly.
async function postReply(ticketId, scenario) {
  const url = `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}/reply`;

  try {
    await axios.post(url, { body: scenario.resolution, user_id: scenario.responder }, authHeader);
    return 'as the assigned agent';
  } catch (err) {
    if (!cannotActAs(err)) {
      throw err;
    }
    await axios.post(url, { body: scenario.resolution }, authHeader);
    return 'as the API key owner';
  }
}

async function postResolutions() {
  if (!fs.existsSync(TICKETS_FILE)) {
    console.log('data/demo_tickets.json not found. Run "node create_articles_tickets.js" first.');
    return;
  }

  const tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));

  for (const ticket of tickets) {
    const scenario = SCENARIOS.find((s) => s.key === ticket.key);

    if (!scenario || ticket.repliedAt) {
      continue;
    }

    try {
      const reclaimed = await reclaim(ticket.ticketId, scenario);
      const who = await postReply(ticket.ticketId, scenario);

      ticket.repliedAt = new Date().toISOString();
      console.log(`Ticket #${ticket.ticketId}: ${reclaimed ? 'taken back from the AI agent, ' : ''}resolution posted ${who} - status left Open (${scenario.group})`);
    } catch (err) {
      console.error(`Ticket #${ticket.ticketId}: reply failed:`, err.response?.status, JSON.stringify(err.response?.data || err.message));
    }

    fs.writeFileSync(TICKETS_FILE, `${JSON.stringify(tickets, null, 2)}\n`);
    await sleep(1000);
  }

  console.log('\nDone. All tickets are still Open. Resolve them in Freshdesk in this order to see each alert form cleanly:');
  for (const group of ['Emerging drift - follows the article', 'High drift - new route', 'Emerging drift - new route', 'Knowledge gap']) {
    const ids = tickets.filter((t) => t.group === group).map((t) => `#${t.ticketId}`);

    console.log(`  ${group.padEnd(38)} ${ids.join(', ')}`);
  }
}

postResolutions();
