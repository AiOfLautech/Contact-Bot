const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const i18n = require("i18n");
const schedule = require("node-schedule");
const express = require("express");
require("dotenv").config();

// Bot Configuration
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// Multilingual Support
i18n.configure({
  locales: ["en", "es"],
  directory: __dirname + "/locales",
  defaultLocale: "en",
  register: global,
});

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Database Schema
const Appeal = mongoose.model("Appeal", new mongoose.Schema({
  userId: String,
  phoneNumber: String,
  reason: String,
  status: { type: String, default: "Pending" },
  createdAt: { type: Date, default: Date.now },
}));

// Email Configuration
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Middleware
bot.use((ctx, next) => {
  ctx.i18n = i18n;
  return next();
});

// Start Command
bot.start((ctx) => {
  ctx.reply(ctx.i18n.__("welcome"), Markup.keyboard([
    [ctx.i18n.__("submit_appeal"), ctx.i18n.__("view_history")],
    [ctx.i18n.__("change_language")]
  ]).resize());
});

// Change Language
bot.hears(i18n.__("change_language"), (ctx) => {
  ctx.reply(ctx.i18n.__("select_language"), Markup.inlineKeyboard([
    [Markup.button.callback("English", "lang_en"), Markup.button.callback("Español", "lang_es")]
  ]));
});

bot.action(/lang_(.+)/, (ctx) => {
  const lang = ctx.match[1];
  i18n.setLocale(lang);
  ctx.reply(ctx.i18n.__("language_changed"));
});

// Submit Appeal
bot.hears(i18n.__("submit_appeal"), (ctx) => {
  ctx.reply(ctx.i18n.__("provide_details"));
});

// Handle Text Input for Appeals
bot.on("text", async (ctx) => {
  const [phoneNumber, reason] = ctx.message.text.split(" | ");
  if (!phoneNumber || !reason) {
    return ctx.reply(ctx.i18n.__("invalid_format"));
  }

  const appeal = new Appeal({
    userId: ctx.from.id,
    phoneNumber,
    reason,
  });

  await appeal.save();

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: "support@whatsapp.com",
    subject: `Appeal for WhatsApp Ban: ${phoneNumber}`,
    text: `Dear WhatsApp Team,\n\nMy account associated with the phone number ${phoneNumber} has been banned. Here's my reason:\n\n${reason}\n\nThank you.`,
  };

  transporter.sendMail(mailOptions, (err) => {
    if (err) {
      console.error(err);
      return ctx.reply(ctx.i18n.__("email_error"));
    }
    ctx.reply(ctx.i18n.__("appeal_sent"));
  });
});

// View History
bot.hears(i18n.__("view_history"), async (ctx) => {
  const appeals = await Appeal.find({ userId: ctx.from.id });
  if (!appeals.length) {
    return ctx.reply(ctx.i18n.__("no_history"));
  }

  const history = appeals.map(a => `${a.phoneNumber} - ${a.reason} (${a.status})`).join("\n");
  ctx.reply(ctx.i18n.__("history") + history);
});

// Webhook Support
app.use(express.json());
app.post(`/webhook/${process.env.BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body);
  res.status(200).send("OK");
});

// Start Server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await bot.telegram.setWebhook(`${process.env.RENDER_DOMAIN}/webhook/${process.env.BOT_TOKEN}`);
  console.log("Webhook set!");
});
