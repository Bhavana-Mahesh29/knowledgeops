const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const FRESHDESK_DOMAIN = 'knowledgeopshack.freshdesk.com';
const API_KEY = 'fwapi_1RY2zqkqfM3UjPf447qNK5_1022750354893064294_7b31579f'; // Replace with your API key from Profile Settings
const FOLDER_ID = '68000075564';       // Replace with your numerical Folder ID from Solutions URL
// =======================================================

async function importArticles(csvFilePath) {
  const rows = [];

  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => rows.push(row))
    .on('end', async () => {
      console.log(`Found ${rows.length} articles to upload...\n`);

      for (const row of rows) {
        const title = row.title;
        const description = row.content_html;
        const tags = row.tags ? row.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

        if (!title) {
          console.error('❌ Skipping row: title is missing or empty.');
          continue;
        }

        try {
          const payload = {
            title: title,
            description: description || '<p>No content provided</p>',
            status: 1 // 1 = Draft, 2 = Published
          };

          if (tags.length > 0) {
            payload.tags = tags;
          }

          const res = await axios.post(
            `https://${FRESHDESK_DOMAIN}/api/v2/solutions/folders/${FOLDER_ID}/articles`,
            payload,
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${API_KEY}:X`).toString('base64')}`
              }
            }
          );
          console.log(`✅ Uploaded: ${res.data.title}`);
        } catch (err) {
          const errorMsg = err.response?.data?.errors
            ? JSON.stringify(err.response.data.errors)
            : err.response?.data?.message || err.message;

          console.error(`❌ Failed to upload "${title}": HTTP ${err.response?.status || 'ERR'} - ${errorMsg}`);
        }
      }
    });
}

importArticles('./knowledgeops_solution_articles.csv');