require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const vCard = require('vcard4');
const fetch = require('node-fetch');

// Initialize Telegram bot
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(telegramBotToken, { webHook: true });
const WEBHOOK_URL = process.env.WEBHOOK_URL;
bot.setWebHook(`${WEBHOOK_URL}/bot${telegramBotToken}`);

// Initialize WhatsApp client
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
});
whatsappClient.initialize();

// Store user sessions
let userSessions = {};

// Handle Telegram messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    if (msg.document && msg.document.mime_type === 'text/x-vcard') {
        const fileId = msg.document.file_id;

        // Download .vcf file
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${telegramBotToken}/${filePath}`;

        // Save the file locally
        const localFilePath = `./contacts/${Date.now()}_contacts.vcf`;
        const response = await fetch(fileUrl);
        const fileBuffer = await response.arrayBuffer();
        fs.writeFileSync(localFilePath, Buffer.from(fileBuffer));

        // Parse the .vcf file
        const vcfData = fs.readFileSync(localFilePath, 'utf-8');
        const contacts = vCard.parse(vcfData);

        // Extract contact names and numbers
        const contactButtons = contacts.map((contact, index) => ({
            text: contact.fn || `Contact ${index + 1}`,
            callback_data: contact.tel[0].value,
        }));

        userSessions[chatId] = { contacts: contactButtons };

        // Show contacts as inline buttons
        bot.sendMessage(chatId, 'Select the contacts to send the message:', {
            reply_markup: {
                inline_keyboard: contactButtons.map((contact) => [contact]),
            },
        });
    } else {
        bot.sendMessage(chatId, 'Please upload a valid .vcf file.');
    }
});

// Handle button clicks (contact selection)
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const selectedContact = query.data;

    if (!userSessions[chatId].selectedContacts) {
        userSessions[chatId].selectedContacts = [];
    }

    userSessions[chatId].selectedContacts.push(selectedContact);

    bot.sendMessage(chatId, `Contact ${selectedContact} selected. Enter the message to send:`);
});

// Handle user message input
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions[chatId];

    if (session && session.selectedContacts && msg.text && !msg.document) {
        const message = msg.text;

        session.selectedContacts.forEach((number) => {
            whatsappClient.sendMessage(number, message)
                .then(() => console.log(`Message sent to ${number}`))
                .catch((err) => console.error(`Failed to send message to ${number}:`, err));
        });

        bot.sendMessage(chatId, 'Messages sent successfully!');
        delete userSessions[chatId];
    }
});
