// scripts/legacy-vobiz-prototype.js
// Moved verbatim out of server/server.js: FDK loads server.js in a sandbox where
// a second `exports =` replaced every handler and express/dotenv/axios cannot be
// required. The call flow now lives in server/lib/voice.js and
// scripts/voice-relay.js. Nothing loads this file; kept for reference.
// runProceduralCheck is superseded by the checkTicketFreshness AI action
// (actions.json), which receives flat args rather than input_variables.

exports = {
  // Your serverless custom action handler
  runProceduralCheck: async function(payload) {
    try {
      const { ticket_id, resolution_notes } = payload.input_variables;

      // Execute your drift logic / LLM comparison here
      console.log(`Processing AI Action for Ticket #${ticket_id}`);

      // Return JSON back to Freddy AI
      renderData(null, {
        status: "success",
        drift_detected: true,
        severity: "CRITICAL",
        recommendation: "Verify 2FA pin before executing reset."
      });
    } catch (error) {
      renderData({ status: "error", message: error.message });
    }
  }
}
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Vobiz fetches this endpoint when the call connects
app.post('/voice/answer', (req, res) => {
  res.set('Content-Type', 'text/xml');
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="WOMAN">Attention. Critical procedural drift detected in Freshdesk. Please review ticket 102 immediately.</Speak>
</Response>`;
  res.send(xmlResponse);
});

// Endpoint to trigger outbound call via Vobiz REST API
app.post('/trigger-alert', async (req, res) => {
  const { ticket_id, admin_phone } = req.body;
  const authId = process.env.VOBIZ_AUTH_ID;
  const authToken = process.env.VOBIZ_AUTH_TOKEN;

  try {
    const response = await axios.post(
      `https://api.vobiz.ai/api/v1/Account/${authId}/Call/`,
      {
        from: process.env.VOBIZ_PHONE_NUMBER,
        to: admin_phone || process.env.ADMIN_PHONE_NUMBER,
        answer_url: `${process.env.NGROK_URL}/voice/answer`,
        answer_method: 'POST'
      },
      {
        headers: {
          'X-Auth-ID': authId,
          'X-Auth-Token': authToken,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ success: true, message: 'Outbound call initiated', data: response.data });
  } catch (error) {
    console.error('Call Trigger Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.listen(3000, () => {
  console.log('KnowledgeOps Server running on http://localhost:3000');
});
