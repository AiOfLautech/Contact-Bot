require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fetch = require('node-fetch');
const { Client, LocalAuth } = require('whatsapp-web.js');
const vCard = require('vcard4');
const express = require('express');

// Initialize Express for webhook
const app = express();
app.use(express.json());

// Telegram Bot Token and Webhook URL
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookURL = process.env.WEBHOOK_URL;

// Initialize Telegram bot with webhook
const bot = new TelegramBot(telegramBotToken, { webHook: true });
bot.setWebHook(`${webhookURL}/bot${telegramBotToken}`);

// Initialize WhatsApp client
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
});
whatsappClient.initialize();

// Directory for storing uploaded .vcf files
const CONTACTS_DIR = './contacts';
if (!fs.existsSync(CONTACTS_DIR)) fs.mkdirSync(CONTACTS_DIR);

// Store user sessions
let userSessions = {};

// Handle Telegram messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    if (msg.document && msg.document.mime_type === 'text/x-vcard') {
        const fileId = msg.document.file_id;

        // Download the .vcf file
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${telegramBotToken}/${filePath}`;
        const localFilePath = `${CONTACTS_DIR}/${Date.now()}_contacts.vcf`;

        // Fetch the file
        const response = await fetch(fileUrl);
        const fileBuffer = await response.arrayBuffer();
        fs.writeFileSync(localFilePath, Buffer.from(fileBuffer));

        // Normalize line endings to CRLF
        const vcfData = fs.readFileSync(localFilePath, 'utf-8').replace(/\r?\n/g, '\r\n');
        fs.writeFileSync(localFilePath, vcfData);

        // Parse the .vcf file
        const parsedContacts = vCard.parse(vcfData);
        const contacts = parsedContacts.map((contact, index) => ({
            name: contact.fn || `Contact ${index + 1}`,
            phone: contact.tel[0]?.value || null,
        })).filter(contact => contact.phone);

        // Save contacts in session
        userSessions[chatId] = { contacts, selectedContacts: [] };

        // Send inline buttons for contact selection
        bot.sendMessage(chatId, 'Select the contacts to message:', {
            reply_markup: {
                inline_keyboard: contacts.map((contact, index) => [
                    { text: contact.name, callback_data: `select_${index}` },
                ]),
            },
        });
    } else if (userSessions[chatId] && msg.text) {
        // Handle custom message input
        const session = userSessions[chatId];
        const message = msg.text;

        if (session.selectedContacts.length > 0) {
            // Send the message to selected contacts
            session.selectedContacts.forEach((contact) => {
                whatsappClient.sendMessage(contact.phone, message)
                    .then(() => console.log(`Message sent to ${contact.phone}`))
                    .catch((err) => console.error(`Failed to send message to ${contact.phone}:`, err));
            });

            bot.sendMessage(chatId, `Message sent to ${session.selectedContacts.length} contacts.`);
            delete userSessions[chatId];
        } else {
            bot.sendMessage(chatId, 'No contacts selected. Please select contacts first.');
        }
    } else {
        bot.sendMessage(chatId, 'Please upload a valid .vcf file to start.');
    }
});

// Handle inline button clicks for contact selection
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const session = userSessions[chatId];
    const action = query.data;

    if (action.startsWith('select_')) {
        const index = parseInt(action.split('_')[1], 10);
        const contact = session.contacts[index];

        // Toggle contact selection
        const alreadySelected = session.selectedContacts.some(c => c.phone === contact.phone);
        if (alreadySelected) {
            session.selectedContacts = session.selectedContacts.filter(c => c.phone !== contact.phone);
            bot.answerCallbackQuery(query.id, `${contact.name} deselected.`);
        } else {
            session.selectedContacts.push(contact);
            bot.answerCallbackQuery(query.id, `${contact.name} selected.`);
        }
    }
});

// Start Express server for webhook
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Webhook server running on port ${PORT}`);
});
