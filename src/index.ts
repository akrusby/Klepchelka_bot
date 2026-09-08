import "dotenv/config";
import { Bot } from "grammy";
import { generateAnswer } from "./ai.js";
import { getRecentMessages, saveMessage } from "./database.js";

const token = process.env.BOT_TOKEN;
const allowedChatId = Number(process.env.ALLOWED_CHAT_ID);

if (!token) {
	throw new Error("BOT_TOKEN is not set");
}

if (!allowedChatId) {
	throw new Error("ALLOWED_CHAT_ID is not set");
}

const bot = new Bot(token);

// Проверяем доступ пользователя
bot.use(async (ctx, next) => {
	if (ctx.chat?.id !== allowedChatId) {
		console.log(
			`Blocked message from chat ${ctx.chat?.id}`
		);

		await ctx.reply("Извините, доступ запрещён.");

		return;
	}

	await next();
});

// /start
bot.command("start", async (ctx) => {
	await ctx.reply(
		"Привет! Я работаю 🤖\n\nПока я умею только отвечать на сообщения."
	);
});

// Последние сохранённые сообщения
bot.command("memory", async (ctx) => {
	const messages = getRecentMessages(ctx.chat.id).reverse();

	if (messages.length === 0) {
		await ctx.reply("Память пока пуста.");
		return;
	}

	const history = messages
		.map((message) => `${message.role}: ${message.text}`)
		.join("\n\n");

	await ctx.reply(`Последние сообщения:\n\n${history}`);
});

// Любой обычный текст
bot.on("message:text", async (ctx) => {
	const text = ctx.message.text;
	const chatId = ctx.chat.id;
	const history = getRecentMessages(chatId).reverse();

	console.log(`Received: ${text}`);
	saveMessage(chatId, "user", text);

	const { provider, answer } = await generateAnswer(history, text);
	console.log(`Using provider: ${provider}`);
	saveMessage(chatId, "assistant", answer);

	await ctx.reply(answer);
});

// Обработка ошибок
bot.catch((error) => {
	console.error("Bot error:", error);
});

// Запуск
console.log("Bot is starting...");

bot.start({
	onStart: (botInfo) => {
		console.log(`Bot started as @${botInfo.username}`);
	},
});
