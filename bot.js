require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const OWNER_ID = process.env.OWNER_ID; // Bot owner's Telegram ID

// Load or initialize local database
const DB_FILE = 'database.json';
const loadDB = () => {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
};
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
const db = loadDB();

// Translations for multiple languages
const translations = {
    en: {
        welcome: 'Welcome! Send a video link to download.',
        tutorial: 'Here is the tutorial video.',
        invalidLink: '❌ Please send a valid video link.',
        error: '🚨 Error fetching video. Please try again.',
        failedDownload: '⚠️ Failed to download video. Try another link.',
        languageChange: '🌍 Language options coming soon.',
        stats: '📊 You have downloaded *{{count}}* videos.',
        back: '🔙 Back to main menu.',
        ownerStats: '📈 Bot Statistics\n👥 Total Users: *{{totalUsers}}*\n📥 Total Downloads: *{{totalDownloads}}*',
    },
    es: {
        welcome: '¡Bienvenido! Envíe un enlace de video para descargar.',
        tutorial: 'Aquí está el video tutorial.',
        invalidLink: '❌ Por favor, envíe un enlace de video válido.',
        error: '🚨 Error al obtener el video. Intenta nuevamente.',
        failedDownload: '⚠️ Falló la descarga del video. Intenta con otro enlace.',
        languageChange: '🌍 Opciones de idioma próximamente.',
        stats: '📊 Has descargado *{{count}}* videos.',
        back: '🔙 Volver al menú principal.',
        ownerStats: '📈 Estadísticas del bot\n👥 Usuarios Totales: *{{totalUsers}}*\n📥 Descargas Totales: *{{totalDownloads}}*',
    },
    // Add more languages here
};

const getTranslation = (userId, key) => {
    const lang = db.users[userId]?.language || 'en'; // Default to 'en' if not set
    return translations[lang][key];
};

// Inline keyboard for users
const menuKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '🌍 Change Language', callback_data: 'change_lang' }],
            [{ text: '📊 View My Stats', callback_data: 'stats' }],
            [{ text: '🔙 Back', callback_data: 'back' }]
        ]
    }
};

// Inline keyboard for the owner
const ownerKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📊 View Bot Stats', callback_data: 'owner_stats' }],
            [{ text: '🔙 Back', callback_data: 'back' }]
        ]
    }
};

// Start command with tutorial video
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId]) {
        db.users[userId] = { downloads: 0, language: 'en' }; // Default language is 'en'
        saveDB(db);
    }

    const keyboard = userId.toString() === OWNER_ID ? ownerKeyboard : menuKeyboard;

    await ctx.replyWithVideo(
        { url: 'https://example.com/tutorial.mp4' },
        { caption: getTranslation(userId, 'tutorial'), ...keyboard }
    );
});

// Handle video download requests
bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const url = ctx.message.text;

    if (!url.startsWith('http')) {
        return ctx.reply(getTranslation(userId, 'invalidLink'));
    }

    try {
        const response = await axios.get(`https://api.davidcyriltech.my.id/download/aio?url=${url}`);
        if (response.data.success) {
            db.users[userId].downloads += 1;
            saveDB(db);

            await ctx.replyWithPhoto(
                { url: response.data.video.high_quality },
                {
                    caption: `🎬 *${response.data.video.title}*\n[📥 Download Video](${response.data.video.high_quality})`,
                    parse_mode: 'Markdown'
                }
            );
        } else {
            ctx.reply(getTranslation(userId, 'failedDownload'));
        }
    } catch (error) {
        ctx.reply(getTranslation(userId, 'error'));
    }
});

// Handle inline button actions
bot.on('callback_query', async (ctx) => {
    const userId = ctx.from.id;
    const data = ctx.callbackQuery.data;

    if (data === 'change_lang') {
        db.users[userId].language = db.users[userId].language === 'en' ? 'es' : 'en'; // Toggle between 'en' and 'es'
        saveDB(db);
        ctx.reply(getTranslation(userId, 'languageChange'), menuKeyboard);
    } else if (data === 'stats') {
        ctx.reply(getTranslation(userId, 'stats').replace('{{count}}', db.users[userId]?.downloads || 0), { parse_mode: 'Markdown' });
    } else if (data === 'owner_stats' && userId.toString() === OWNER_ID) {
        const totalUsers = Object.keys(db.users).length;
        const totalDownloads = Object.values(db.users).reduce((sum, user) => sum + user.downloads, 0);

        ctx.reply(
            getTranslation(userId, 'ownerStats')
                .replace('{{totalUsers}}', totalUsers)
                .replace('{{totalDownloads}}', totalDownloads),
            { parse_mode: 'Markdown' }
        );
    } else if (data === 'back') {
        const keyboard = userId.toString() === OWNER_ID ? ownerKeyboard : menuKeyboard;
        ctx.reply(getTranslation(userId, 'back'), keyboard);
    }

    await ctx.answerCbQuery();
});

// Webhook setup
app.use(express.json());
app.post('/webhook', (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
});

app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await bot.telegram.setWebhook(`${WEBHOOK_URL}`);
});
