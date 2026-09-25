const axios = require('axios');

// Set the domain you are currently using
const FRESHDESK_DOMAIN = 'knowledgeopshack.freshdesk.com'; // Change to 'knowledgeopshack.freshdesk.com' if that's where you're working
const API_KEY = 'fwapi_1RY2zqkqfM3UjPf447qNK5_1022750354893064294_7b31579f';

const authHeader = {
  headers: {
    'Authorization': `Basic ${Buffer.from(`${API_KEY}:X`).toString('base64')}`
  }
};

async function listAllFolders() {
  try {
    console.log(`Checking categories on https://${FRESHDESK_DOMAIN}...`);
    const catRes = await axios.get(`https://${FRESHDESK_DOMAIN}/api/v2/solutions/categories`, authHeader);
    
    if (catRes.data.length === 0) {
      console.log('⚠️ No categories found! Please create a Category and a Folder first in Solutions.');
      return;
    }

    for (const cat of catRes.data) {
      console.log(`\n📂 Category: "${cat.name}" (ID: ${cat.id})`);
      const folderRes = await axios.get(`https://${FRESHDESK_DOMAIN}/api/v2/solutions/categories/${cat.id}/folders`, authHeader);
      
      if (folderRes.data.length === 0) {
        console.log(`   └── (No folders in this category)`);
      }

      for (const folder of folderRes.data) {
        console.log(`   └── 📁 Folder: "${folder.name}" -> USE THIS FOLDER_ID: '${folder.id}'`);
      }
    }
  } catch (err) {
    console.error('❌ Check failed:', err.response?.status, err.response?.data || err.message);
  }
}

listAllFolders();