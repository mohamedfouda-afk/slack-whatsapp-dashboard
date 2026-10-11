require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { App } = require('@slack/bolt');
const whatsappManager = require('./whatsapp-manager');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const DB_FILE = process.env.DB_FILE || 'slack_whatsapp.db';
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('❌ Database error:', err);
  else console.log('✅ Database connected:', DB_FILE);
});

// Initialize database tables
db.serialize(() => {
  // Users table for authentication
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Forwarding rules
  db.run(`
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_channel_id TEXT NOT NULL,
      slack_channel_name TEXT NOT NULL,
      whatsapp_group_name TEXT NOT NULL,
      whatsapp_group_id TEXT,
      is_active INTEGER DEFAULT 1,
      include_sender INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Message logs
  db.run(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      slack_user TEXT,
      slack_message TEXT,
      whatsapp_status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (rule_id) REFERENCES rules(id)
    )
  `);

  // Connection status
  db.run(`
    CREATE TABLE IF NOT EXISTS connection_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT UNIQUE,
      is_connected INTEGER DEFAULT 0,
      last_check DATETIME DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT
    )
  `);

  // Create default admin user if not exists
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'password';
  const hashedPassword = bcrypt.hashSync(adminPass, 10);

  db.run(
    `INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)`,
    [adminUser, hashedPassword],
    (err) => {
      if (err) console.error('Admin user error:', err);
      else console.log('✅ Admin user ready');
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '24h',
    });

    res.json({ token, username: user.username });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RULES API
// ═══════════════════════════════════════════════════════════════════════════════

// Get all rules
app.get('/api/rules', authenticateToken, (req, res) => {
  db.all('SELECT * FROM rules ORDER BY created_at DESC', (err, rules) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rules || []);
  });
});

// Create new rule
app.post('/api/rules', authenticateToken, (req, res) => {
  const { slack_channel_id, slack_channel_name, whatsapp_group_name } = req.body;

  if (!slack_channel_id || !whatsapp_group_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  db.run(
    `INSERT INTO rules (slack_channel_id, slack_channel_name, whatsapp_group_name, is_active)
     VALUES (?, ?, ?, 1)`,
    [slack_channel_id, slack_channel_name, whatsapp_group_name],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Rule created' });
    }
  );
});

// Update rule
app.put('/api/rules/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { is_active, whatsapp_group_name } = req.body;

  db.run(
    `UPDATE rules SET is_active = ?, whatsapp_group_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [is_active ? 1 : 0, whatsapp_group_name, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Rule updated' });
    }
  );
});

// Delete rule
app.delete('/api/rules/:id', authenticateToken, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM rules WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Rule deleted' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE LOGS API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/logs', authenticateToken, (req, res) => {
  const limit = req.query.limit || 100;
  db.all(
    `SELECT * FROM message_logs ORDER BY created_at DESC LIMIT ?`,
    [limit],
    (err, logs) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(logs || []);
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/status', authenticateToken, (req, res) => {
  db.all('SELECT * FROM connection_status', (err, status) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(status || []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    slack: process.env.SLACK_BOT_TOKEN ? '✅' : '❌',
    whatsapp: whatsappManager.isReady() ? '✅' : '⏳',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SLACK SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Listen to messages in all channels where rules exist
slackApp.message(async ({ message, client }) => {
  if (message.bot_id || !message.text) return;

  try {
    // Get all active rules
    db.all(
      'SELECT * FROM rules WHERE is_active = 1',
      async (err, rules) => {
        if (err || !rules) return;

        for (const rule of rules) {
          if (message.channel !== rule.slack_channel_id) continue;

          // Get user info
          const user = await client.users.info({ user: message.user });
          const senderName = user.user?.real_name || user.user?.name || 'Unknown';

          // Format message
          let messageText = message.text
            .replace(/<@U[A-Z0-9]+>/g, '@user')
            .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
            .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
            .trim();

          // Add sender if configured
          if (process.env.INCLUDE_SENDER_NAME === 'true') {
            messageText = `**${senderName}**: ${messageText}`;
          }

          // Send to WhatsApp
          const success = await whatsappManager.sendToGroup(
            rule.whatsapp_group_name,
            messageText
          );

          // Log message
          db.run(
            `INSERT INTO message_logs (rule_id, slack_user, slack_message, whatsapp_status)
             VALUES (?, ?, ?, ?)`,
            [
              rule.id,
              senderName,
              message.text,
              success ? 'sent' : 'failed',
            ]
          );

          console.log(`✅ Forwarded to ${rule.whatsapp_group_name}`);
        }
      }
    );
  } catch (error) {
    console.error('❌ Message processing error:', error);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

async function start() {
  console.log('🚀 Starting Slack-WhatsApp Dashboard...');

  // Initialize WhatsApp
  console.log('📱 Initializing WhatsApp...');
  whatsappManager.initialize();

  // Start Slack
  console.log('💬 Starting Slack listener...');
  await slackApp.start();
  console.log('✅ Slack listener started');

  // Start Express
  app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
  });
}

start().catch(console.error);

module.exports = { db, app };
