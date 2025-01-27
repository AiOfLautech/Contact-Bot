const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const i18n = require("i18n");
const express = require("express");
require("dotenv").config();

// Bot Configuration
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// Multilingual Support
i18n.configure({
  locales: ["en", "es", "fr", "de", "ar", "zh"],
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
  banType: String,
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

// Predefined Reasons for Appeals
const reasons = {
  temporary: `Dear WhatsApp Team,\n\nI recently encountered a situation where my WhatsApp account associated with the phone number {{phone}} was temporarily banned. I deeply value using WhatsApp for communication, both personal and professional. It seems there might have been an inadvertent violation of your terms of service, which I assure you was completely unintentional.\n\nI kindly request that you review my case and consider reinstating my account at the earliest convenience. I have always strived to comply with your community standards and will be extra cautious to avoid any issues in the future.\n\nThank you for your understanding and support.\n\nSincerely,\n[Your Name]`,
  permanent: `Dear WhatsApp Support Team,\n\nI am writing to appeal the permanent ban on my WhatsApp account associated with the phone number {{phone}}. I was surprised to learn about this action, as I have always used WhatsApp responsibly and within the scope of your terms and conditions.\n\nI rely heavily on WhatsApp for maintaining personal connections and conducting business communications. If there was any misunderstanding or unintentional violation, I sincerely apologize and assure you that it will not happen again.\n\nI kindly request you to reevaluate my case and consider reinstating my account. Your platform is invaluable to me, and I hope to regain access soon.\n\nThank you for your time and understanding.\n\nSincerely,\n[Your Name]`
};

// Start Command
bot.start((ctx) => {
  ctx.reply(
    ctx.i18n.__("welcome", {
      ownerName: "AI OF LAUTECH",
      telegram: "@Godwin366390",
      phone: "+2348089336992",
    }),
    Markup.inlineKeyboard([
      [Markup.button.url(ctx.i18n.__("follow_telegram"), "https://t.me/Godwin366390")],
      [Markup.button.url(ctx.i18n.__("follow_tiktok"), "https://www.tiktok.com/@Godwin366390")],
      [Markup.button.url(ctx.i18n.__("follow_whatsapp"), "https://wa.me/+2348089336992")],
      [Markup.button.callback(ctx.i18n.__("continue"), "verify_follow")]
    ])
  );
});

// Verify Follow
bot.action("verify_follow", (ctx) => {
  ctx.reply(ctx.i18n.__("provide_details"));
});

// Handle Appeal Submission
bot.on("text", async (ctx) => {
  const phoneNumber = ctx.message.text;
  ctx.session = { phoneNumber };

  ctx.reply(ctx.i18n.__("select_ban_type"), Markup.inlineKeyboard([
    [Markup.button.callback(ctx.i18n.__("temporary_ban"), "ban_temporary")],
    [Markup.button.callback(ctx.i18n.__("permanent_ban"), "ban_permanent")]
  ]));
});

// Temporary Ban Appeal
bot.action("ban_temporary", async (ctx) => {
  const phoneNumber = ctx.session.phoneNumber;

  // Save to database
  const appeal = new Appeal({
    userId: ctx.from.id,
    phoneNumber: phoneNumber,
    banType: "Temporary Ban",
  });
  await appeal.save();

  // Send email
  sendAppealEmail(phoneNumber, reasons.temporary.replace("{{phone}}", phoneNumber));
  ctx.reply(ctx.i18n.__("appeal_sent"));
});

// Permanent Ban Appeal
bot.action("ban_permanent", async (ctx) => {
  const phoneNumber = ctx.session.phoneNumber;

  // Save to database
  const appeal = new Appeal({
    userId: ctx.from.id,
    phoneNumber: phoneNumber,
    banType: "Permanent Ban",
  });
  await appeal.save();

  // Send email
  sendAppealEmail(phoneNumber, reasons.permanent.replace("{{phone}}", phoneNumber));
  ctx.reply(ctx.i18n.__("appeal_sent"));
});

// Send Email Function
const sendAppealEmail = (phoneNumber, appealReason) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: "support@whatsapp.com",
    subject: "Appeal for WhatsApp Ban",
    text: appealReason,
  };

  transporter.sendMail(mailOptions, (err) => {
    if (err) {
      console.error(err);
    }
  });
};

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
