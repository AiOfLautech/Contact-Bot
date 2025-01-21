require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const vCard = require('vcard4');

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

// Load and parse VCF file
let contacts = [];
try {
    const vcfData = fs.readFileSync('./Group_Contacts.vcf', 'utf-8');
    const parsedContacts = vCard.parse(vcfData);

    contacts = parsedContacts.map((contact, index) => ({
        name: contact.fn || `Contact ${index + 1}`,
        phone: contact.tel[0]?.value || null,
    })).filter(contact => contact.phone); // Filter out invalid contacts
    console.log(`Loaded ${contacts.length} contacts.`);
} catch (error) {
    console.error('Failed to load VCF file:', error.message);
}

// Store user sessions
let userSessions = {};

// Handle Telegram messages
bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    // Start interaction
    bot.sendMessage(chatId, 'Select the contacts to message:', {
        reply_markup: {
            inline_keyboard: contacts.map((contact, index) => [{
                text: contact.name,
                callback_data: `${index}`,
            }]),
        },
    });

    // Initialize user session
    userSessions[chatId] = {
        selectedContacts: [],
    };
});

// Handle inline button clicks for contact selection
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const session = userSessions[chatId];
    const contactIndex = parseInt(query.data, 10);

    if (!session) return;

    // Toggle selection
    const selectedContact = contacts[contactIndex];
    const alreadySelected = session.selectedContacts.some(
        (contact) => contact.phone === selectedContact.phone
    );

    if (alreadySelected) {
        // Deselect the contact
        session.selectedContacts = session.selectedContacts.filter(
            (contact) => contact.phone !== selectedContact.phone
        );
        bot.answerCallbackQuery(query.id, `${selectedContact.name} deselected.`);
    } else {
        // Select the contact
        session.selectedContacts.push(selectedContact);
        bot.answerCallbackQuery(query.id, `${selectedContact.name} selected.`);
    }

    // Optionally display selected count
    bot.sendMessage(chatId, `Selected ${session.selectedContacts.length} contacts.`);
});

// Handle custom message input
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions[chatId];

    // Check if a message is sent after selection
    if (session && session.selectedContacts.length > 0 && msg.text) {
        const message = msg.text;

        // Send message to all selected contacts
        session.selectedContacts.forEach((contact) => {
            whatsappClient.sendMessage(contact.phone, message)
                .then(() => console.log(`Message sent to ${contact.phone}`))
                .catch((err) => console.error(`Failed to send message to ${contact.phone}:`, err));
        });

        bot.sendMessage(chatId, `Message sent to ${session.selectedContacts.length} contacts.`);
        delete userSessions[chatId]; // Clear session after sending
    }
});
