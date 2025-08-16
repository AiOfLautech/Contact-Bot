const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const axios = require('axios');
const vCard = require('vcf');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const AUTH_FOLDER = './whatsapp_auth';

// Create auth directory
fs.mkdir(AUTH_FOLDER, { recursive: true }).catch(console.error);

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();

// Session management middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from.id;
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      step: 'waiting_vcf',
      vcfContacts: [],
      selectedContacts: [],
      broadcastMessage: null,
      whatsappSocket: null
    });
  }
  ctx.session = sessions.get(userId);
  await next();
  sessions.set(userId, ctx.session);
});

// Start command
bot.start(async (ctx) => {
  ctx.session = {
    step: 'waiting_vcf',
    vcfContacts: [],
    selectedContacts: [],
    broadcastMessage: null,
    whatsappSocket: null
  };
  return ctx.reply(
    '🚀 Welcome to WhatsApp Broadcast Bot!\n\n' +
    '1. Send a VCF file or paste a Catbox VCF link\n' +
    '2. Select contacts to include\n' +
    '3. Enter your broadcast message\n' +
    '4. Link WhatsApp using 8-digit code\n\n' +
    'Example VCF link: https://files.catbox.moe/ytnuy2.vcf'
  );
});

// Handle VCF file or link
bot.on(message('document', 'text'), async (ctx) => {
  if (ctx.session.step !== 'waiting_vcf') return;

  try {
    let vcfData;
    
    // Handle file upload
    if (ctx.message.document) {
      if (!ctx.message.document.mime_type.includes('vcard')) {
        return ctx.reply('❌ Please send a valid VCF file');
      }
      
      const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      vcfData = response.data.toString();
    } 
    // Handle URL
    else if (ctx.message.text.startsWith('http')) {
      const response = await axios.get(ctx.message.text, { responseType: 'arraybuffer' });
      vcfData = response.data.toString();
    } else {
      return;
    }

    // Parse VCF
    const cards = new vCard().parse(vcfData);
    const contacts = cards.map(card => {
      const name = card.fn?.value || 'Unknown Contact';
      let phone = '';
      
      if (card.tel) {
        const tels = Array.isArray(card.tel) ? card.tel : [card.tel];
        const mainTel = tels.find(t => 
          t.params?.type?.includes('pref') || 
          t.params?.type?.includes('CELL')
        ) || tels[0];
        phone = mainTel?.value?.replace(/\D/g, '') || '';
      }
      
      return { name, phone };
    }).filter(contact => contact.phone);

    if (contacts.length === 0) {
      return ctx.reply('❌ No valid phone numbers found in VCF');
    }

    ctx.session.vcfContacts = contacts;
    ctx.session.step = 'selecting_contacts';

    // Generate contact list message
    let msg = '📱 Found contacts:\n\n';
    contacts.forEach((contact, i) => {
      msg += `#${i + 1} ${contact.name}\n${contact.phone}\n\n`;
    });
    
    msg += '✅ Send comma-separated indices to select contacts (e.g., 1,3,5)';
    return ctx.reply(msg, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true 
    });

  } catch (error) {
    console.error('VCF Processing Error:', error);
    return ctx.reply(
      `❌ Error processing VCF:\n${error.message}\n\n` +
      'Please send a valid VCF file or link'
    );
  }
});

// Handle contact selection
bot.on(message('text'), async (ctx) => {
  if (ctx.session.step === 'selecting_contacts') {
    try {
      const indices = ctx.message.text
        .split(',')
        .map(i => parseInt(i.trim()) - 1)
        .filter(i => !isNaN(i));
      
      if (indices.length === 0) {
        return ctx.reply('❌ Invalid selection. Send numbers like: 1,2,3');
      }

      const invalid = indices.filter(i => 
        i < 0 || i >= ctx.session.vcfContacts.length
      );
      
      if (invalid.length > 0) {
        return ctx.reply(
          `❌ Invalid indices: ${invalid.map(i => i + 1).join(', ')}\n` +
          `Valid range: 1-${ctx.session.vcfContacts.length}`
        );
      }

      ctx.session.selectedContacts = indices.map(i => 
        ctx.session.vcfContacts[i]
      );
      ctx.session.step = 'waiting_message';

      return ctx.reply(
        `✅ Selected ${ctx.session.selectedContacts.length} contacts\n\n` +
        '📝 Send your broadcast message:'
      );

    } catch (error) {
      return ctx.reply('❌ Error selecting contacts. Try again.');
    }
  }
});

// Handle broadcast message
bot.on(message('text'), async (ctx) => {
  if (ctx.session.step === 'waiting_message') {
    ctx.session.broadcastMessage = ctx.message.text;
    ctx.session.step = 'waiting_whatsapp';

    return ctx.reply(
      `📨 Broadcast message set:\n\n${ctx.session.broadcastMessage}\n\n` +
      '🔗 Linking WhatsApp account...\n' +
      '⏳ Generating 8-digit pairing code...'
    ).then(() => initiateWhatsAppConnection(ctx));
  }
});

// WhatsApp connection handler
async function initiateWhatsAppConnection(ctx) {
  try {
    const userId = ctx.from.id;
    const authPath = path.join(AUTH_FOLDER, userId.toString());
    
    // Create auth directory
    await fs.mkdir(authPath, { recursive: true });
    
    // Setup auth state
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    // Create WhatsApp socket
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Desktop'),
      logger: pino({ level: 'silent' }),
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      emitOwnEvents: true,
      generateHighQualityLinkPreview: true
    });

    ctx.session.whatsappSocket = sock;

    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          await ctx.reply('🔄 Reconnecting to WhatsApp...');
          sock = makeWASocket({ auth: state });
        } else {
          await ctx.reply('❌ WhatsApp session ended. Please restart.');
          cleanupSession(ctx);
        }
      }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Wait for initial connection
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => 
        reject(new Error('Timeout connecting to WhatsApp servers')), 15000
      );
      
      sock.ev.on('connection.update', (update) => {
        if (update.connection === 'open') {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    // Get pairing code
    const pairingCode = await sock.requestPairingCode();
    
    // Send pairing instructions
    await ctx.reply(
      `🔑 *WhatsApp Pairing Code*\n\n` +
      `Enter this 8-digit code in your WhatsApp:\n\n` +
      `*${pairingCode}*\n\n` +
      `1. Open WhatsApp > Settings > Linked Devices\n` +
      `2. Tap "Link a Device"\n` +
      `3. Enter the code above\n\n` +
      `⏳ *You have 30 seconds to enter the code*`,
      { parse_mode: 'Markdown' }
    );

    // Wait for session ready
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => 
        reject(new Error('Pairing code expired')), 30000
      );
      
      sock.ev.on('creds.update', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await ctx.reply('✅ WhatsApp connected successfully! Starting broadcast...');
    
    // Send broadcast messages
    for (const [index, contact] of ctx.session.selectedContacts.entries()) {
      if (!contact.phone) continue;
      
      try {
        const jid = `${contact.phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: ctx.session.broadcastMessage });
        
        await ctx.reply(
          `✅ *Message ${index + 1}/${ctx.session.selectedContacts.length}*\n` +
          `Sent to: ${contact.name}\n` +
          `Number: ${formatPhoneNumber(contact.phone)}`,
          { parse_mode: 'Markdown' }
        );
        
        // Rate limiting
        if (index < ctx.session.selectedContacts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2500));
        }
      } catch (error) {
        await ctx.reply(
          `❌ *Failed to send message*\n` +
          `Contact: ${contact.name}\n` +
          `Error: ${error.message.split('\n')[0]}`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Cleanup
    sock.end();
    await ctx.reply(
      `🎉 *Broadcast completed!*\n` +
      `Sent to ${ctx.session.selectedContacts.length} contacts`,
      { parse_mode: 'Markdown' }
    );
    cleanupSession(ctx);

  } catch (error) {
    console.error('WhatsApp Connection Error:', error);
    await ctx.reply(
      `❌ *WhatsApp Error*\n\n` +
      `Failed to connect: ${error.message}\n\n` +
      `Please try again with /start`,
      { parse_mode: 'Markdown' }
    );
    cleanupSession(ctx);
  }
}

// Helper functions
function formatPhoneNumber(phone) {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return cleaned;
}

function cleanupSession(ctx) {
  const userId = ctx.from.id;
  
  if (ctx.session.whatsappSocket) {
    ctx.session.whatsappSocket.end();
    ctx.session.whatsappSocket = null;
  }
  
  sessions.set(userId, {
    step: 'waiting_vcf',
    vcfContacts: [],
    selectedContacts: [],
    broadcastMessage: null,
    whatsappSocket: null
  });
}

// Error handling
bot.catch((err) => {
  console.error('Bot Error:', err);
});

// Start bot
bot.launch().then(() => {
  console.log('✅ Telegram bot is running');
  console.log('🔗 Send /start in your Telegram bot');
}).catch(console.error);

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
