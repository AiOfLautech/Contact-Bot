require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const vCard = require('vcf');
const axios = require('axios');
const express = require('express');
const socketIO = require('socket.io');
const fs = require('fs').promises;
const path = require('path');
const pino = require('pino');
const pn = require('awesome-phonenumber');

// Initialize server
const app = express();
const server = app.listen(process.env.PORT || 3000);
const io = socketIO(server);

// Create bot
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Proper session initialization
bot.use(session());

// User session management
const userStates = new Map();

// Fixed VCF URL
const VCF_URL = 'https://files.catbox.moe/ytnuy2.vcf';

// Helper function to remove session directory
async function removeFile(FilePath) {
  try {
    if (!await fs.access(FilePath).then(() => true).catch(() => false)) return false;
    await fs.rm(FilePath, { recursive: true, force: true });
    console.log(`Cleaned up session directory: ${FilePath}`);
    return true;
  } catch (e) {
    console.error('Error removing file:', e.message);
    return false;
  }
}

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
    
    // Show contact selection with Broadcast button
    await ctx.reply(
      `✅ Loaded ${contacts.length} contacts. Select recipients:`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Select All', 'select_all'),
          Markup.button.callback('Clear All', 'clear_all')
        ],
        ...createContactKeyboard(contacts),
        [Markup.button.callback('🚀 Broadcast to Selected', 'start_broadcast')]
      ])
    );
    
  } catch (err) {
    console.error('VCF error:', err.message);
    await ctx.reply('❌ Error loading contacts. Please try again later.');
  }
});

// Parse VCF file content
function parseVCF(content) {
  try {
    const entries = content.split('END:VCARD');
    const contacts = [];
    const uniqueTels = new Set();
    
    for (const entry of entries) {
      if (!entry.trim()) continue;
      
      try {
        const fullEntry = entry + 'END:VCARD';
        const card = new vCard().parse(fullEntry);
        
        // Get name
        let name = 'Unknown';
        const fn = card.get('fn');
        if (fn && fn.valueOf()) name = fn.valueOf();
        
        // Get telephone numbers
        const tels = card.get('tel');
        if (!tels) continue;
        
        // Handle single tel or array of tels
        const telArray = Array.isArray(tels) ? tels : [tels];
        
        for (const tel of telArray) {
          let telValue = tel.valueOf();
          
          // Convert to string if needed
          if (typeof telValue !== 'string') {
            if (telValue.text) telValue = telValue.text;
            else if (telValue.uri) telValue = telValue.uri.replace('tel:', '');
            else telValue = String(telValue);
          }
          
          // Clean and validate phone number
          telValue = telValue.replace(/[^\d+]/g, '');
          if (telValue.length >= 8 && !uniqueTels.has(telValue)) {
            uniqueTels.add(telValue);
            contacts.push({ name, tel: telValue });
          }
        }
      } catch (e) {
        console.error('Skipping invalid contact entry:', e.message);
      }
    }
    
    return contacts;
  } catch (error) {
    console.error('VCF parsing failed:', error.message);
    return [];
  }
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
bot.action(/toggle_(\d+)/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1]);
    
    // Ensure session exists
    if (!ctx.session) ctx.session = {};
    if (!ctx.session.contacts) return ctx.answerCbQuery('Session expired!');
    
    const contact = ctx.session.contacts[index];
    
    if (!ctx.session.selectedContacts) {
      ctx.session.selectedContacts = [];
    }
    
    // Check if selection state changed
    let changed = false;
    
    if (!ctx.session.selectedContacts.includes(contact)) {
      ctx.session.selectedContacts.push(contact);
      await ctx.answerCbQuery(`✅ Selected ${contact.name}`);
      changed = true;
    } else {
      ctx.session.selectedContacts = ctx.session.selectedContacts.filter(c => c.tel !== contact.tel);
      await ctx.answerCbQuery(`❌ Removed ${contact.name}`);
      changed = true;
    }
    
    // Only update if selection changed
    if (changed) {
      try {
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [
            [
              Markup.button.callback('Select All', 'select_all'),
              Markup.button.callback('Clear All', 'clear_all')
            ],
            ...createContactKeyboard(ctx.session.contacts),
            [Markup.button.callback('🚀 Broadcast to Selected', 'start_broadcast')]
          ]
        });
      } catch (err) {
        // Ignore "not modified" error, handle others
        if (!err.description || !err.description.includes('not modified')) {
          console.error('Error updating message:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Error in toggle action:', err.message);
    await ctx.answerCbQuery('❌ An error occurred. Please try again.');
  }
});

// Select all/Clear all handlers
bot.action(['select_all', 'clear_all'], async (ctx) => {
  try {
    // Ensure session exists
    if (!ctx.session) ctx.session = {};
    if (!ctx.session.contacts) return ctx.answerCbQuery('Session expired!');
    
    let changed = false;
    
    if (ctx.match[0] === 'select_all') {
      // Only select all if not already selected
      if (ctx.session.selectedContacts?.length !== ctx.session.contacts.length) {
        ctx.session.selectedContacts = [...ctx.session.contacts];
        await ctx.answerCbQuery('✅ All contacts selected');
        changed = true;
      }
    } else {
      // Only clear if there are selected contacts
      if (ctx.session.selectedContacts?.length > 0) {
        ctx.session.selectedContacts = [];
        await ctx.answerCbQuery('❌ All contacts cleared');
        changed = true;
      }
    }
    
    // Only update if selection changed
    if (changed) {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            Markup.button.callback('Select All', 'select_all'),
            Markup.button.callback('Clear All', 'clear_all')
          ],
          ...createContactKeyboard(ctx.session.contacts),
          [Markup.button.callback('🚀 Broadcast to Selected', 'start_broadcast')]
        ]
      });
    } else {
      await ctx.answerCbQuery('No changes made');
    }
  } catch (err) {
    console.error('Error in select/clear action:', err.message);
    await ctx.answerCbQuery('❌ An error occurred. Please try again.');
  }
});

// Start broadcast button handler
bot.action('start_broadcast', async (ctx) => {
  try {
    // Ensure session exists
    if (!ctx.session) ctx.session = {};
    
    if (!ctx.session?.selectedContacts?.length) {
      return ctx.answerCbQuery('❌ No contacts selected!', { show_alert: true });
    }
    
    ctx.session.step = 'awaiting_message';
    await ctx.answerCbQuery();
    await ctx.reply(`✉️ You've selected ${ctx.session.selectedContacts.length} contacts. Enter your broadcast message:`);
  } catch (err) {
    console.error('Error in start_broadcast action:', err.message);
    await ctx.answerCbQuery('❌ An error occurred. Please try again.');
  }
});

// Handle message input
bot.on('text', async (ctx) => {
  try {
    // Ensure session exists
    if (!ctx.session) ctx.session = {};
    
    if (ctx.session.step === 'awaiting_message') {
      ctx.session.broadcastMessage = ctx.message.text;
      ctx.session.step = 'awaiting_number';
      
      // Ask for WhatsApp number
      await ctx.reply(
        `🔢 Please enter your WhatsApp number (with country code) to receive pairing code:\n\n` +
        `Example: +1234567890`,
        Markup.keyboard([Markup.button.contactRequest('📱 Share Phone Number')])
          .oneTime()
          .resize()
      );
    } else if (ctx.session.step === 'awaiting_number') {
      // Extract phone number from message or contact
      let phone = ctx.message.text;
      
      // If contact is shared
      if (ctx.message.contact) {
        phone = ctx.message.contact.phone_number;
      }
      
      // Validate phone number using awesome-phonenumber
      phone = phone.replace(/[^\d+]/g, '');
      const phoneObj = pn(phone);
      if (!phoneObj.isValid()) {
        return ctx.reply('❌ Invalid phone number format. Please enter with country code (e.g., +1234567890)');
      }
      phone = phoneObj.getNumber('e164').replace('+', '');
      
      ctx.session.phone = phone;
      
      try {
        await initWhatsAppConnection(ctx);
        await ctx.reply(
          `🔗 *Linking WhatsApp*\n\n` +
          `1. Open WhatsApp on your phone\n` +
          `2. Go to Settings → Linked Devices\n` +
          `3. Tap "Link a Device"\n` +
          `4. Enter this 8-digit code: ${ctx.session.pairingCode}\n\n` +
          `Monitor status: ${process.env.SERVER_URL || 'http://localhost:3000'}/status.html?userId=${ctx.from.id}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('WhatsApp init error for user', ctx.from.id, ':', err.message);
        await ctx.reply('❌ Failed to initialize WhatsApp connection. Please try again or contact support.');
      }
    } else {
      await ctx.reply('Please use /start to begin the process.');
    }
  } catch (err) {
    console.error('Error in text handler for user', ctx.from.id, ':', err.message);
    await ctx.reply('❌ An unexpected error occurred. Please try again or contact support.');
  }
});

// Initialize WhatsApp connection
async function initWhatsAppConnection(ctx) {
  const userId = ctx.from.id;
  const sessionDir = path.join(__dirname, 'sessions', `wa_${userId}`);
  
  console.log(`Initializing WhatsApp connection for user ${userId}...`);
  
  // Clean up existing session
  try {
    await removeFile(sessionDir);
  } catch (err) {
    console.error(`Failed to clean up session directory for user ${userId}:`, err.message);
    throw new Error('Failed to clean up session directory');
  }
  
  // Create session directory
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    console.log(`Created session directory: ${sessionDir}`);
  } catch (err) {
    console.error(`Failed to create session directory for user ${userId}:`, err.message);
    throw new Error('Failed to create session directory');
  }
  
  // Initialize WhatsApp client
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch (err) {
    console.error(`Failed to initialize auth state for user ${userId}:`, err.message);
    throw new Error('Failed to initialize WhatsApp auth state');
  }
  
  let client;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using Baileys version ${version.join('.')}, isLatest: ${isLatest}`);
    client = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
      },
      printQRInTerminal: false,
      logger: pino({ level: "fatal" }).child({ level: "fatal" }),
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 250,
      maxRetries: 5,
    });
  } catch (err) {
    console.error(`Failed to create WhatsApp socket for user ${userId}:`, err.message);
    throw new Error('Failed to create WhatsApp socket');
  }
  
  // Save credentials
  client.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      console.log(`Credentials updated for user ${userId}`);
    } catch (err) {
      console.error(`Failed to save credentials for user ${userId}:`, err.message);
    }
  });
  
  // Handle connection events
  client.ev.on('connection.update', async (update) => {
    if (!userStates.has(userId)) userStates.set(userId, {});
    const state = userStates.get(userId);
    
    const { connection, lastDisconnect, isNewLogin, isOnline } = update;
    
    console.log(`Connection update for user ${userId}:`, { connection, isNewLogin, isOnline });
    
    if (connection === 'open') {
      state.whatsappStatus = 'connected';
      io.emit('status', { userId, status: 'connected' });
      console.log(`WhatsApp connected for user ${userId}`);
      
      try {
        await broadcastMessages(ctx);
      } catch (err) {
        console.error(`Broadcast error for user ${userId}:`, err.message);
        await ctx.reply('❌ Broadcast failed during connection update.');
      }
    } else if (!client.authState.creds.registered) {
      try {
        await delay(3000); // Wait 3 seconds before requesting pairing code
        let num = ctx.session.phone.replace(/[^\d+]/g, '');
        if (num.startsWith('+')) num = num.substring(1);
        
        console.log(`Requesting pairing code for user ${userId}, number: ${num}`);
        let code = await client.requestPairingCode(num);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        state.pairingCode = code;
        state.whatsappStatus = 'awaiting_pairing';
        
        // Ensure session exists
        if (!ctx.session) ctx.session = {};
        ctx.session.pairingCode = code;
        
        io.emit('pairing_code', { userId, code });
        io.emit('status', { userId, status: 'awaiting_pairing' });
        console.log(`Pairing code sent for user ${userId}: ${code}`);
      } catch (error) {
        console.error(`Error requesting pairing code for user ${userId}:`, error.message);
        await ctx.reply('❌ Failed to get pairing code. Please check your phone number and try again.');
      }
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed for user ${userId}, statusCode: ${statusCode}`);
      if (statusCode === 401) {
        state.whatsappStatus = 'disconnected';
        io.emit('status', { userId, status: 'disconnected' });
        await removeFile(sessionDir);
        console.log(`Logged out for user ${userId}, session cleaned up`);
      } else {
        console.log(`Connection closed for user ${userId}, restarting...`);
        state.whatsappStatus = 'disconnected';
        io.emit('status', { userId, status: 'disconnected' });
        await removeFile(sessionDir);
        try {
          await initWhatsAppConnection(ctx);
        } catch (err) {
          console.error(`Failed to restart WhatsApp connection for user ${userId}:`, err.message);
          await ctx.reply('❌ Failed to reconnect WhatsApp. Please try again.');
        }
      }
    } else if (connection) {
      state.whatsappStatus = connection;
      io.emit('status', { userId, status: connection });
    }
    
    if (isNewLogin) {
      console.log(`New login via pair code for user ${userId}`);
    }
    
    if (isOnline) {
      console.log(`Client is online for user ${userId}`);
    }
  });
  
  // Store client in session
  if (!ctx.session) ctx.session = {};
  ctx.session.whatsappClient = client;
  userStates.set(userId, { whatsappStatus: 'connecting' });
  console.log(`WhatsApp client initialized for user ${userId}`);
}

// Broadcast messages
async function broadcastMessages(ctx) {
  const userId = ctx.from.id;
  console.log(`Starting broadcast for user ${userId}`);
  
  // Ensure session exists
  if (!ctx.session) {
    console.error(`Session missing for user ${userId}`);
    await ctx.reply('❌ Session expired! Please start over.');
    return;
  }
  
  const client = ctx.session.whatsappClient;
  const contacts = ctx.session.selectedContacts || [];
  const message = ctx.session.broadcastMessage || '';
  
  if (!client || contacts.length === 0 || !message) {
    console.error(`Invalid session state for user ${userId}:`, { client: !!client, contacts: contacts.length, message: !!message });
    await ctx.reply('❌ Invalid session state. Please start over.');
    return;
  }
  
  let success = 0, failed = 0;
  const sessionDir = path.join(__dirname, 'sessions', `wa_${userId}`);
  
  try {
    // Send initial confirmation
    const startMsg = await ctx.reply(`🚀 Starting broadcast to ${contacts.length} contacts...`);
    console.log(`Broadcast started for user ${userId}, ${contacts.length} contacts`);
    
    // Create a progress message
    const progressMessage = await ctx.reply('📤 Broadcast progress: 0% (0/0)');
    
    for (const [index, contact] of contacts.entries()) {
      try {
        const jid = jidNormalizedUser(`${contact.tel}@s.whatsapp.net`);
        console.log(`Sending message to ${contact.tel} for user ${userId}`);
        
        // Send message with status notification
        await client.sendMessage(jid, { text: message });
        success++;
        console.log(`Message sent to ${contact.tel} for user ${userId}`);
        
        // Update progress every 10 messages or last message
        if ((index + 1) % 10 === 0 || index === contacts.length - 1) {
          const percent = Math.floor(((index + 1) / contacts.length) * 100);
          try {
            await ctx.telegram.editMessageText(
              progressMessage.chat.id,
              progressMessage.message_id,
              null,
              `📤 Broadcast progress: ${percent}%\n` +
              `✅ Sent: ${index + 1}/${contacts.length}\n` +
              `❌ Failed: ${failed}`
            );
          } catch (editError) {
            // Ignore edit errors
            console.log(`Progress update error for user ${userId}:`, editError.message);
          }
        }
        
        // Rate limiting (2.5 seconds per message)
        await delay(2500);
      } catch (error) {
        console.error(`Failed to send to ${contact.tel} for user ${userId}:`, error.message);
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
      report += `\n\n📝 *Failed Contacts (${ctx.session.failedContacts.length}):*`;
      report += ctx.session.failedContacts
        .slice(0, 10)
        .map(c => `\n- ${c.name} (${c.tel})`)
        .join('');
      if (ctx.session.failedContacts.length > 10) {
        report += `\n...and ${ctx.session.failedContacts.length - 10} more`;
      }
    }
    
    await ctx.reply(report, { parse_mode: 'Markdown' });
    console.log(`Broadcast completed for user ${userId}: ${success} successes, ${failed} failures`);
    
  } catch (error) {
    console.error(`Broadcast error for user ${userId}:`, error.message);
    await ctx.reply('❌ Broadcast failed due to an unexpected error');
  } finally {
    try { 
      if (client) {
        await client.end();
        ctx.session.whatsappClient = null;
        console.log(`WhatsApp client closed for user ${userId}`);
      }
    } catch (e) {
      console.error(`Error closing client for user ${userId}:`, e.message);
    }
    
    // Clean up session
    if (ctx.session) {
      ctx.session.step = undefined;
      ctx.session.broadcastMessage = undefined;
      ctx.session.whatsappClient = undefined;
      ctx.session.failedContacts = [];
    }
    await removeFile(sessionDir);
    console.log(`Session cleaned up for user ${userId}`);
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
  } else {
    console.log('🌐 Status page available at: http://localhost:3000/status.html');
  }
}).catch(err => {
  console.error('Failed to start bot:', err.message);
  process.exit(1);
});

// Handle graceful shutdown
process.once('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  bot.stop('SIGTERM');
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
  let e = String(err);
  if (e.includes("conflict")) return;
  if (e.includes("not-authorized")) return;
  if (e.includes("Socket connection timeout")) return;
  if (e.includes("rate-overlimit")) return;
  if (e.includes("Connection Closed")) return;
  if (e.includes("Timed Out")) return;
  if (e.includes("Value not found")) return;
  if (e.includes("Stream Errored")) return;
  if (e.includes("Stream Errored (restart required)")) return;
  if (e.includes("statusCode: 515")) return;
  if (e.includes("statusCode: 503")) return;
  console.error('Uncaught exception:', err.message, err.stack);
});
