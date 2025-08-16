require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { makeWASocket, useSingleFileAuthState, Browsers } = require('@adiwajshing/baileys');
const vCard = require('vcf');
const axios = require('axios');
const express = require('express');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');

// Initialize server
const app = express();
const server = app.listen(process.env.PORT || 3000);
const io = socketIO(server);

// Create bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Proper session initialization
const session = require('telegraf/session');
bot.use(session());

// User session management
const userStates = new Map();

// Fixed VCF URL
const VCF_URL = 'https://files.catbox.moe/ytnuy2.vcf';

// Socket connection handler
io.on('connection', (socket) => {
  socket.on('subscribe', (userId) => {
    const state = userStates.get(userId) || {};
    socket.emit('status', state.whatsappStatus || 'disconnected');
    if (state.pairingCode) {
      socket.emit('pairing_code', state.pairingCode);
    }
  });
});

// Start command - fetch contacts immediately
bot.start(async (ctx) => {
  try {
    await ctx.reply('⏳ Fetching contacts from VCF file...');
    
    // Download and parse VCF
    const { data } = await axios.get(VCF_URL);
    const contacts = parseVCF(data);
    
    if (!contacts || contacts.length === 0) {
      return ctx.reply('❌ No valid contacts found in the VCF file');
    }
    
    // Initialize session if needed
    if (!ctx.session) ctx.session = {};
    
    // Save to session
    ctx.session.contacts = contacts;
    ctx.session.selectedContacts = [];
    
    // Show contact selection
    ctx.reply(
      `✅ Loaded ${contacts.length} contacts. Select recipients:`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Select All', 'select_all'),
          Markup.button.callback('Clear All', 'clear_all')
        ],
        ...createContactKeyboard(contacts)
      ])
    );
    
  } catch (err) {
    console.error('VCF error:', err);
    ctx.reply('❌ Error loading contacts. Please try again later.');
  }
});

// Parse VCF file content
function parseVCF(content) {
  return content
    .split('END:VCARD')
    .filter(entry => entry.trim())
    .map(entry => {
      try {
        const card = new vCard().parse(entry + 'END:VCARD');
        const name = card.get('fn')?.valueOf() || 'Unknown';
        const tel = (card.get('tel')?.valueOf() || '').replace(/[^\d+]/g, '');
        return tel.length >= 8 ? { name, tel } : null;
      } catch (e) {
        console.error('Error parsing contact:', e);
        return null;
      }
    })
    .filter(Boolean);
}

// Create contact keyboard
function createContactKeyboard(contacts) {
  return contacts.slice(0, 50).map((contact, i) => [
    Markup.button.callback(
      `${contact.name.substring(0, 20)} (${contact.tel.substring(0, 12)})`,
      `toggle_${i}`
    )
  ]);
}

// Contact selection handler
bot.action(/toggle_(\d+)/, (ctx) => {
  const index = parseInt(ctx.match[1]);
  
  // Ensure session exists
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.contacts) return ctx.answerCbQuery('Session expired!');
  
  const contact = ctx.session.contacts[index];
  
  if (!ctx.session.selectedContacts) {
    ctx.session.selectedContacts = [];
  }
  
  if (!ctx.session.selectedContacts.includes(contact)) {
    ctx.session.selectedContacts.push(contact);
    ctx.answerCbQuery(`✅ Selected ${contact.name}`);
  } else {
    ctx.session.selectedContacts = ctx.session.selectedContacts.filter(c => c.tel !== contact.tel);
    ctx.answerCbQuery(`❌ Removed ${contact.name}`);
  }
  
  // Update keyboard
  ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        Markup.button.callback('Select All', 'select_all'),
        Markup.button.callback('Clear All', 'clear_all')
      ],
      ...createContactKeyboard(ctx.session.contacts)
    ]
  });
});

// Select all/Clear all handlers
bot.action(['select_all', 'clear_all'], (ctx) => {
  // Ensure session exists
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.contacts) return ctx.answerCbQuery('Session expired!');
  
  if (ctx.match[0] === 'select_all') {
    ctx.session.selectedContacts = [...ctx.session.contacts];
    ctx.answerCbQuery('✅ All contacts selected');
  } else {
    ctx.session.selectedContacts = [];
    ctx.answerCbQuery('❌ All contacts cleared');
  }
  
  // Update keyboard
  ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        Markup.button.callback('Select All', 'select_all'),
        Markup.button.callback('Clear All', 'clear_all')
      ],
      ...createContactKeyboard(ctx.session.contacts)
    ]
  });
});

// Broadcast command
bot.command('broadcast', (ctx) => {
  // Ensure session exists
  if (!ctx.session) ctx.session = {};
  
  if (!ctx.session?.selectedContacts?.length) {
    return ctx.reply('❌ No contacts selected! Please select recipients first.');
  }
  
  ctx.session.step = 'awaiting_message';
  ctx.reply(`✉️ You've selected ${ctx.session.selectedContacts.length} contacts. Enter your broadcast message:`);
});

// Handle message input
bot.on('text', async (ctx) => {
  // Ensure session exists
  if (!ctx.session) ctx.session = {};
  
  if (ctx.session.step === 'awaiting_message') {
    ctx.session.broadcastMessage = ctx.message.text;
    ctx.session.step = 'connecting_whatsapp';
    
    try {
      await initWhatsAppConnection(ctx);
      ctx.reply(
        `🔗 *Linking WhatsApp*\n\n` +
        `1. Open WhatsApp on your phone\n` +
        `2. Go to Settings → Linked Devices\n` +
        `3. Tap "Link a Device"\n` +
        `4. Enter this 8-digit code: ${ctx.session.pairingCode}\n\n` +
        `Monitor status: ${process.env.SERVER_URL}/status.html?userId=${ctx.from.id}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('WhatsApp init error:', err);
      ctx.reply('❌ Failed to initialize WhatsApp connection. Please try /broadcast again.');
    }
  }
});

// Initialize WhatsApp connection
async function initWhatsAppConnection(ctx) {
  const userId = ctx.from.id;
  
  // Create session directory if not exists
  const sessionDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
  
  // Initialize WhatsApp client
  const sessionFile = path.join(sessionDir, `${userId}.json`);
  const { state, saveState } = useSingleFileAuthState(sessionFile);
  
  const client = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    shouldSyncHistory: false,
    syncFullHistory: false
  });
  
  // Save state
  client.ev.on('creds.update', saveState);
  
  // Handle connection events
  client.ev.on('connection.update', async (update) => {
    if (!userStates.has(userId)) userStates.set(userId, {});
    const state = userStates.get(userId);
    
    // Handle pairing code
    if (update.connection === 'open') {
      state.whatsappStatus = 'connected';
      io.emit('status', { userId, status: 'connected' });
      
      // Start broadcasting
      await broadcastMessages(ctx);
    } 
    else if (update.pairingCode) {
      state.pairingCode = update.pairingCode;
      state.whatsappStatus = 'awaiting_pairing';
      
      // Ensure session exists
      if (!ctx.session) ctx.session = {};
      ctx.session.pairingCode = update.pairingCode;
      
      io.emit('pairing_code', { userId, code: update.pairingCode });
      io.emit('status', { userId, status: 'awaiting_pairing' });
    }
    else if (update.connection) {
      state.whatsappStatus = update.connection;
      io.emit('status', { userId, status: update.connection });
    }
  });
  
  // Store client in session
  if (!ctx.session) ctx.session = {};
  ctx.session.whatsappClient = client;
  userStates.set(userId, { whatsappStatus: 'connecting' });
}

// Broadcast messages
async function broadcastMessages(ctx) {
  // Ensure session exists
  if (!ctx.session) {
    await ctx.reply('❌ Session expired! Please start over.');
    return;
  }
  
  const client = ctx.session.whatsappClient;
  const contacts = ctx.session.selectedContacts || [];
  const message = ctx.session.broadcastMessage || '';
  
  if (!client || contacts.length === 0 || !message) {
    await ctx.reply('❌ Invalid session state. Please start over.');
    return;
  }
  
  let success = 0, failed = 0;
  
  try {
    // Send initial confirmation
    await ctx.reply(`🚀 Starting broadcast to ${contacts.length} contacts...`);
    
    for (const [index, contact] of contacts.entries()) {
      try {
        const jid = `${contact.tel}@s.whatsapp.net`;
        await client.sendMessage(jid, { text: message });
        success++;
        
        // Send progress update every 10 messages
        if ((index + 1) % 10 === 0) {
          await ctx.reply(`📤 Sent to ${index + 1}/${contacts.length} contacts...`);
        }
        
        // Rate limiting (1.5 seconds per message)
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        console.error(`Failed to send to ${contact.tel}:`, error);
        failed++;
        
        // Save failed contacts
        if (!ctx.session.failedContacts) ctx.session.failedContacts = [];
        ctx.session.failedContacts.push(contact);
      }
    }
    
    // Final report
    let report = `📊 *Broadcast Report*\n\n` +
                `✅ Success: ${success}\n` +
                `❌ Failed: ${failed}\n` +
                `📩 Total: ${contacts.length}`;
    
    // Add failed contacts if any
    if (ctx.session.failedContacts?.length) {
      report += `\n\n📝 *Failed Contacts:*\n`;
      report += ctx.session.failedContacts
        .slice(0, 5)
        .map(c => `- ${c.name} (${c.tel})`)
        .join('\n');
      if (ctx.session.failedContacts.length > 5) {
        report += `\n...and ${ctx.session.failedContacts.length - 5} more`;
      }
    }
    
    await ctx.reply(report, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Broadcast error:', error);
    ctx.reply('❌ Broadcast failed due to an unexpected error');
  } finally {
    try { 
      if (client) await client.end(); 
    } catch (e) {
      console.error('Error closing client:', e);
    }
    
    // Clean up session
    if (ctx.session) {
      ctx.session.step = undefined;
      ctx.session.broadcastMessage = undefined;
      ctx.session.whatsappClient = undefined;
    }
  }
}

// Status page
app.get('/status.html', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Connection Status</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
           background: linear-gradient(135deg, #1a2a6c, #b21f1f, #1a2a6c); 
           color: white; min-height: 100vh; padding: 20px; }
    .container { max-width: 600px; margin: 40px auto; background: rgba(0,0,0,0.7); 
                border-radius: 20px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { text-align: center; margin-bottom: 30px; font-size: 2.5rem; 
         background: linear-gradient(90deg, #00d2ff, #3a7bd5); 
         -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .status-card { background: rgba(255,255,255,0.1); border-radius: 15px; 
                  padding: 25px; margin-bottom: 30px; text-align: center; }
    .status { font-size: 2rem; font-weight: bold; margin: 20px 0; 
              text-transform: uppercase; letter-spacing: 3px; }
    .connecting { color: #FFD700; }
    .awaiting_pairing { color: #1E90FF; }
    .connected { color: #32CD32; }
    .disconnected { color: #FF4500; }
    .code-display { background: rgba(0,0,0,0.3); padding: 25px; 
                   border-radius: 15px; margin: 30px 0; }
    .code { font-size: 3.5rem; letter-spacing: 10px; font-weight: bold; 
            margin: 20px 0; color: #00FF7F; }
    .instructions { background: rgba(255,255,255,0.1); border-radius: 15px; 
                   padding: 20px; margin-top: 30px; }
    ol { text-align: left; padding-left: 30px; margin: 15px 0; }
    li { margin: 10px 0; line-height: 1.6; }
    .hidden { display: none; }
    @media (max-width: 600px) {
      .container { padding: 20px; }
      h1 { font-size: 2rem; }
      .code { font-size: 2.5rem; letter-spacing: 5px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>WhatsApp Connection Status</h1>
    
    <div class="status-card">
      <h2>CURRENT STATUS</h2>
      <div id="status" class="status disconnected">DISCONNECTED</div>
    </div>
    
    <div id="codeDisplay" class="hidden">
      <div class="code-display">
        <h2>YOUR PAIRING CODE</h2>
        <div id="code" class="code"></div>
        <p>Enter this code in WhatsApp under "Linked Devices"</p>
      </div>
      
      <div class="instructions">
        <h3>How to link:</h3>
        <ol>
          <li>Open WhatsApp on your phone</li>
          <li>Go to Settings → Linked Devices</li>
          <li>Tap "Link a Device"</li>
          <li>Enter the 8-digit code above</li>
        </ol>
      </div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('userId');
    
    if (!userId) {
      document.body.innerHTML = '<div class="container"><h1>Error: Missing User ID</h1></div>';
      return;
    }
    
    // Subscribe to status updates
    socket.emit('subscribe', userId);
    
    // Handle status updates
    socket.on('status', (data) => {
      if (data.userId !== userId) return;
      
      const statusEl = document.getElementById('status');
      if (!statusEl) return;
      
      statusEl.textContent = data.status.toUpperCase();
      statusEl.className = 'status ' + data.status;
      
      // Update status text
      const statusMap = {
        'connecting': 'CONNECTING...',
        'awaiting_pairing': 'AWAITING PAIRING',
        'connected': 'CONNECTED!',
        'disconnected': 'DISCONNECTED'
      };
      statusEl.textContent = statusMap[data.status] || data.status.toUpperCase();
    });
    
    // Handle pairing code
    socket.on('pairing_code', (data) => {
      if (data.userId !== userId) return;
      
      const codeEl = document.getElementById('code');
      const codeDisplay = document.getElementById('codeDisplay');
      if (!codeEl || !codeDisplay) return;
      
      // Format code as XXXX-XXXX
      const formattedCode = data.code.replace(/(\d{4})(\d{4})/, '$1-$2');
      codeEl.textContent = formattedCode;
      codeDisplay.classList.remove('hidden');
    });
    
    // Handle connection error
    socket.on('connect_error', () => {
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = 'SERVER CONNECTION ERROR';
    });
  </script>
</body>
</html>
  `);
});

// Start bot
bot.launch().then(() => {
  console.log('🚀 Bot started');
  if (process.env.SERVER_URL) {
    console.log('🌐 Status page available at:', `${process.env.SERVER_URL}/status.html`);
  }
});

// Handle graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
