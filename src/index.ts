import "dotenv/config";
import { Bot } from "grammy";
import { generateAnswer, getAiDiagnostics } from "./ai.js";
import { getMessageCount, getRecentMessages, saveMessage } from "./database.js";

const token = process.env.BOT_TOKEN;
const allowedChatIds = (
	process.env.ALLOWED_CHAT_IDS ?? process.env.ALLOWED_CHAT_ID ?? ""
)
	.split(",")
	.map((value) => Number(value.trim()))
	.filter((value) => Number.isInteger(value) && value !== 0);

if (!token) {
	throw new Error("BOT_TOKEN is not set");
}

if (allowedChatIds.length === 0) {
	throw new Error("ALLOWED_CHAT_IDS is not set");
}

const bot = new Bot(token);

// Проверяем доступ пользователя
bot.use(async (ctx, next) => {
	if (!ctx.chat || !allowedChatIds.includes(ctx.chat.id)) {
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

// Диагностика без секретов
bot.command("diagnostics", async (ctx) => {
	const ai = getAiDiagnostics();
	const lastRequest = ai.lastRequest;
	const memory = process.memoryUsage();
	const attempts = lastRequest?.attempts
		.map((attempt) => {
			const error = attempt.error ? ` error=${attempt.error}` : "";
			return `${attempt.provider}: ${attempt.durationMs} ms${error}`;
		})
		.join("\n") ?? "нет данных";

	const diagnostics = [
		"Диагностика Klepchelka_bot",
		`Время работы: ${Math.round(process.uptime())} сек.`,
		`Node.js: ${process.version}`,
		`Память процесса: ${Math.round(memory.rss / 1024 / 1024)} MB RSS`,
		`Сообщений в SQLite: ${getMessageCount(ctx.chat.id)}`,
		`Провайдеры: ${ai.configuredProviders.join(" -> ") || "нет"}`,
		"",
		"Последний AI-запрос:",
		lastRequest
			? `Всего: ${lastRequest.durationMs} ms, prompt: ${lastRequest.promptChars} символов, ответ: ${lastRequest.provider ?? "нет"}`
			: "нет данных",
		attempts,
	];

	await ctx.reply(diagnostics.join("\n"));
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
