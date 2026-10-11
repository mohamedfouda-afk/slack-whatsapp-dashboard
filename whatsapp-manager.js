const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let client = null;
let isReady = false;
let groupCache = {};

// Initialize WhatsApp client
function initialize() {
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  // QR Code event
  client.on('qr', (qr) => {
    console.log('\n📱 QR Code received. Scan with WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  // Ready event
  client.on('ready', async () => {
    console.log('✅ WhatsApp client is ready!');
    isReady = true;

    // Cache all groups
    await cacheGroups();
  });

  // Disconnected event
  client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp disconnected:', reason);
    isReady = false;
  });

  // Error handling
  client.on('error', (error) => {
    console.error('❌ WhatsApp Error:', error);
  });

  client.initialize();
}

// Cache all groups for quick lookup
async function cacheGroups() {
  if (!client) return;
  try {
    const chats = await client.getChats();
    chats.forEach((chat) => {
      if (chat.isGroup) {
        groupCache[chat.name.toLowerCase()] = chat.id._serialized;
        console.log(`✅ Cached group: ${chat.name}`);
      }
    });
  } catch (error) {
    console.error('Error caching groups:', error);
  }
}

// Send message to WhatsApp group
async function sendToGroup(groupName, message) {
  if (!isReady) {
    console.log('⏳ WhatsApp not ready yet');
    return false;
  }

  try {
    const groupId = groupCache[groupName.toLowerCase()];

    if (!groupId) {
      console.error(`❌ Group "${groupName}" not found in cache`);
      return false;
    }

    // Send message (WhatsApp has a 4096 char limit)
    const truncatedMessage = message.substring(0, 4096);
    await client.sendMessage(groupId, truncatedMessage);

    console.log(`✅ Message sent to ${groupName}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send to ${groupName}:`, error);
    return false;
  }
}

// Check if ready
function isReady_fn() {
  return isReady && Object.keys(groupCache).length > 0;
}

// Get client
function getClient() {
  return client;
}

// Get groups list
function getGroups() {
  return Object.keys(groupCache).map((name) => ({
    name,
    id: groupCache[name],
  }));
}

module.exports = {
  initialize,
  sendToGroup,
  isReady: isReady_fn,
  getClient,
  getGroups,
  cacheGroups,
};
