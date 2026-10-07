import "dotenv/config";
import { Bot } from "grammy";
import { generateAnswer, getAiDiagnostics } from "./ai.js";
import {
	completeDailyTask,
	getDailyTask,
	getMessageCount,
	getRecentMessages,
	saveMessage,
	saveSentDailyTask,
} from "./database.js";
import { loadUrlContext } from "./url-loader.js";

const token = process.env.BOT_TOKEN;
const dailyTaskChatId = process.env.DAILY_TASK_CHAT_ID
	? Number(process.env.DAILY_TASK_CHAT_ID)
	: undefined;
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

if (
	dailyTaskChatId !== undefined &&
	(!Number.isSafeInteger(dailyTaskChatId) ||
		!allowedChatIds.includes(dailyTaskChatId))
) {
	throw new Error("DAILY_TASK_CHAT_ID must be an integer in ALLOWED_CHAT_IDS");
}

const bot = new Bot(token);
const DAILY_TASK_TEXT = "Андрей, попылесось на кухне";
const DAILY_TASK_TIME_ZONE = "Europe/Warsaw";

function getWarsawDateTime(): { date: string; hour: number; minute: number } {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: DAILY_TASK_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date());
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

	return {
		date: `${values.year}-${values.month}-${values.day}`,
		hour: Number(values.hour),
		minute: Number(values.minute),
	};
}

let sendingDailyTask = false;

async function sendDailyTaskIfDue(): Promise<void> {
	if (dailyTaskChatId === undefined || sendingDailyTask) {
		return;
	}

	const { date, hour, minute } = getWarsawDateTime();
	if (hour !== 9 || minute > 5 || getDailyTask(date)) {
		return;
	}

	sendingDailyTask = true;
	try {
		const message = await bot.api.sendMessage(dailyTaskChatId, DAILY_TASK_TEXT);
		if (!saveSentDailyTask(date, dailyTaskChatId, message.message_id)) {
			console.error(`[TASK] daily task already recorded date=${date}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[TASK] unable to send daily task date=${date}: ${message}`);
	} finally {
		sendingDailyTask = false;
	}
}

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
		"Привет! Я работаю 🤖\n\nМожешь отправлять мне сообщения или отмечать выполнение задачи командой @Klepchelka_bot готово."
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

	if (/@Klepchelka_bot\s+готово\b/i.test(text)) {
		const { date } = getWarsawDateTime();
		const task = getDailyTask(date);

		if (!task || task.chat_id !== chatId) {
			await ctx.reply("Сегодняшняя задача ещё не отправлена.");
			return;
		}

		if (task.status === "completed") {
			await ctx.reply("Задача на сегодня уже отмечена как выполненная. ✅");
			return;
		}

		if (completeDailyTask(date, chatId, text)) {
			await ctx.reply("Отметил задачу на сегодня как выполненную. ✅");
			return;
		}

		await ctx.reply("Не удалось отметить задачу. Попробуйте ещё раз.");
		return;
	}

	const history = getRecentMessages(chatId).reverse();

	console.log(`Received: ${text}`);
	saveMessage(chatId, "user", text);

	let urlContext;
	try {
		urlContext = await loadUrlContext(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[URL] fetch failed error=${message}`);
	}

	try {
		const { provider, answer } = await generateAnswer(history, text, urlContext);
		console.log(`Using provider: ${provider}`);
		saveMessage(chatId, "assistant", answer);
		await ctx.reply(answer);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Unable to answer message: ${message}`);
		await ctx.reply(
			"Сейчас все AI-провайдеры недоступны. Попробуйте повторить запрос через минуту.",
		);
	}
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
		if (dailyTaskChatId !== undefined) {
			console.log(
				`[TASK] daily reminder enabled chat=${dailyTaskChatId} time=09:00 ${DAILY_TASK_TIME_ZONE}`,
			);
			void sendDailyTaskIfDue();
			setInterval(() => void sendDailyTaskIfDue(), 15_000);
		} else {
			console.log("[TASK] daily reminder disabled: DAILY_TASK_CHAT_ID is not set");
		}
	},
});
