require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3002;

// Database configuration
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://freedeployment:mfXqfPHV2CB4jvZ5@cluster0.9nd6d9k.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = 'sarkar-md-deployer';
let dbClient;
let verifiedUsersCollection;
let deploymentLimitsCollection;

// Heroku configuration
const HEROKU_API_KEYS = [
  process.env.HEROKU_API_KEY_1 || 'HRKU-AAieqFOfx_JjX8_wWvk98JbDmKVvjISyGFGvVeYfJOyg_____wpSM74xGArB',
  process.env.HEROKU_API_KEY_2 || 'HRKU-AAieqFOfx_JjX8_wWvk98JbDmKVvjISyGFGvVeYfJOyg_____wpSM74xGArB'
];

// Initialize MongoDB connection
async function initializeMongoDB() {
  try {
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
    const db = dbClient.db(DB_NAME);
    verifiedUsersCollection = db.collection('verifiedUsers');
    deploymentLimitsCollection = db.collection('deploymentLimits');

    await verifiedUsersCollection.createIndex({ username: 1 }, { unique: true });
    await deploymentLimitsCollection.createIndex({ username: 1 }, { unique: true });

    console.log('Connected to MongoDB successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

initializeMongoDB().catch(console.error);

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.post('/deploy', handleDeployment);
app.post('/verify', handleVerification);
app.get('/', serveHomePage);
app.get('/fork', serveForkPage);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Route handlers
async function handleDeployment(req, res) {
  try {
    const { sessionId, appName, username, configOptions = {} } = req.body;
    const githubRepo = 'https://github.com/MRSHABAN45/SHABAN-MD';

    if (!sessionId || !username) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isVerified = await verifiedUsersCollection.findOne({ username });
    if (!isVerified) {
      return res.status(403).json({ error: 'Please verify your username first' });
    }

    const userLimit = await deploymentLimitsCollection.findOne({ username });
    const deploymentCount = userLimit ? userLimit.count : 0;

    if (deploymentCount >= 1) {
      return res.status(403).json({ 
        error: 'You have reached your limit of 1 bot deployment',
        limitReached: true
      });
    }

    let deploySuccess = false;
    let finalAppName = '';
    let usedKey = '';

    for (let i = 0; i < HEROKU_API_KEYS.length; i++) {
      const herokuApiKey = HEROKU_API_KEYS[i];
      const headers = {
        'Authorization': `Bearer ${herokuApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.heroku+json; version=3'
      };

      try {
        const appNameFinal = await createHerokuApp(appName, headers);
        await new Promise(resolve => setTimeout(resolve, 10000));
        await setConfigVars(appNameFinal, sessionId, headers, configOptions);
        await deployToHeroku(appNameFinal, githubRepo, headers);
        await new Promise(resolve => setTimeout(resolve, 15000));
        await setDynoToBasic(appNameFinal, headers);
        
        finalAppName = appNameFinal;
        usedKey = herokuApiKey;
        deploySuccess = true;
        break;
      } catch (err) {
        console.log(`API Key ${i + 1} failed. Trying next...`);
      }
    }

    if (!deploySuccess) {
      return res.status(500).json({ error: 'Deployment failed on all API keys' });
    }

    await updateDeploymentCount(username);

    res.json({ 
      success: true,
      message: `🎉 Bot deployed successfully!`,
      url: `https://${finalAppName}.herokuapp.com`,
      appName: finalAppName,
      usedKey,
      deploymentsLeft: 1 - (deploymentCount + 1)
    });

  } catch (error) {
    console.error('Deployment error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Deployment failed',
      details: error.response?.data || error.message
    });
  }
}

async function handleVerification(req, res) {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const existingUser = await verifiedUsersCollection.findOne({ username });
    if (existingUser) {
      return res.status(403).json({ 
        error: 'This username has already been used.',
        verified: false
      });
    }

    await verifiedUsersCollection.insertOne({ 
      username,
      verifiedAt: new Date()
    });

    await deploymentLimitsCollection.updateOne(
      { username },
      { $setOnInsert: { count: 0 } },
      { upsert: true }
    );

    res.json({ 
      success: true,
      message: 'Verification successful!',
      verified: true,
      username,
      deploymentsLeft: 1
    });

  } catch (error) {
    console.error('Verification error:', error.message);
    res.status(500).json({ 
      error: 'Verification failed.',
      details: error.message
    });
  }
}

// Static file serving
function serveHomePage(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
}

function serveForkPage(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'fork.html'));
}

// Heroku helper functions
async function setDynoToBasic(appName, headers) {
  try {
    const response = await axios.patch(
      `https://api.heroku.com/apps/${appName}/formation`, 
      { 
        updates: [ 
          { 
            type: 'web', 
            quantity: 1, 
            size: 'basic' 
          } 
        ] 
      }, 
      { headers }
    );
    console.log('Dyno set to Basic successfully:', response.data);
  } catch (error) {
    console.error('Error setting dyno:', error.response?.data || error.message);
    if (error.response?.data?.id === 'not_found') {
      await new Promise(resolve => setTimeout(resolve, 10000));
      return setDynoToBasic(appName, headers);
    }
    throw error;
  }
}

async function createHerokuApp(appName, headers) {
  const response = await axios.post(
    'https://api.heroku.com/apps', 
    { 
      name: appName || `shaban-md-${Math.floor(Math.random() * 9000) + 1000}` 
    }, 
    { headers }
  );
  return response.data.name;
}

async function setConfigVars(appName, sessionId, headers, extraConfigs = {}) {
  const configVars = {
    SESSION_ID: sessionId,
    STICKER_NAME: "SHABAN-MD︎",
    MENU_IMAGE_URL: "https://ik.imagekit.io/mrshaban/Picsart_25-02-01_22-47-44-239.jpg",
    PREFIX: ".",
    MODE: "public",
    ALWAYS_ONLINE: "false",
    AUTO_STATUS_SEEN: "true",
    AUTO_STATUS_REACT: "true",
    AUTO_STATUS_REPLY: "false",
    AUTO_STATUS_MSG: "SᴇᴇN YᴏᴜʀE SᴛᴀᴛᴜS JᴜsT NᴏW Sʜᴀʙᴀɴ-Mᴅ 𓅓",
    BOT_NAME: "SHABAN-MD",
    ANTI_LINK: "false",
    ADMIN_EVENTS: "false",
    WELCOME: "false",
    ANTI_CALL: "false",
    AUTO_RECORDING: "false",
    AUTO_TYPING: "false",
    AUTO_REACT: "false",
    CUSTOM_REACT: "false",
    CUSTOM_REACT_EMOJIS: "💝,💖,💗,❤️‍🩹,❤️,🧡,💛,💚,💙,💜,🤎,🖤,🤍",
    ANTI_DEL_PATH: "inbox",
    ANTI_DELETE: "false",
    READ_MESSAGE: "false",
    ...Object.fromEntries(
      Object.entries(extraConfigs).map(([key, val]) => [
        key, 
        typeof val === 'boolean' ? String(val) : val
      ])
    )
  };

  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`, 
    configVars, 
    { headers }
  );
}

async function deployToHeroku(appName, repoUrl, headers) {
  const sourceBlobUrl = repoUrl.endsWith('.git') 
    ? `${repoUrl.replace('.git', '')}/archive/main.tar.gz` 
    : `${repoUrl}/archive/main.tar.gz`;

  await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    {
      source_blob: { url: sourceBlobUrl }
    }, 
    { headers }
  );
}

// Database helper functions
async function updateDeploymentCount(username) {
  await deploymentLimitsCollection.updateOne(
    { username },
    { $inc: { count: 1 } },
    { upsert: true }
  );
}

// Cleanup on exit
process.on('SIGINT', async () => {
  if (dbClient) {
    await dbClient.close();
  }
  process.exit(0);
});
  
