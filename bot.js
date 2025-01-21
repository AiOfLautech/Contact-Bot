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

        // Extract phone numbers
        const phoneNumbers = contacts.map(contact => contact.tel[0].value);

        bot.sendMessage(chatId, 'VCF file received. Please enter the message you want to send:');
        
        // Handle message input
        bot.once('message', (msg) => {
            const message = msg.text;

            phoneNumbers.forEach((number) => {
                whatsappClient.sendMessage(number, message)
                    .then(() => console.log(`Message sent to ${number}`))
                    .catch(err => console.error(`Failed to send message to ${number}: ${err}`));
            });

            bot.sendMessage(chatId, 'Messages sent successfully!');
        });
    } else {
        bot.sendMessage(chatId, 'Please upload a valid .vcf file.');
    }
});
