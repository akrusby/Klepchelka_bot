import "dotenv/config";
import { Bot } from "grammy";
import { generateAnswer, getAiDiagnostics, matchCompletedTask } from "./ai.js";
import {
	addPersonalTask,
	assignSentDailyTaskToUser,
	completeDailyTask,
	completePersonalTask,
	getDailyTask,
	getMessageCount,
	getPendingTasks,
	getRecentMessages,
	saveMessage,
	saveSentDailyTask,
} from "./database.js";
import { loadUrlContext } from "./url-loader.js";

const token = process.env.BOT_TOKEN;
const dailyTaskChatId = process.env.DAILY_TASK_CHAT_ID
	? Number(process.env.DAILY_TASK_CHAT_ID)
	: undefined;
const dailyTaskUserId = process.env.DAILY_TASK_USER_ID
	? Number(process.env.DAILY_TASK_USER_ID)
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

if (
	dailyTaskUserId !== undefined &&
	(!Number.isSafeInteger(dailyTaskUserId) || dailyTaskUserId <= 0)
) {
	throw new Error("DAILY_TASK_USER_ID must be a positive Telegram user ID");
}

const bot = new Bot(token);
const DAILY_TASK_TEXT = "Андрей, попылесось на кухне";
const DAILY_TASK_TIME_ZONE = "Europe/Warsaw";
const BOT_TRIGGER_PATTERN =
	/(^|[^\p{L}\p{N}_])(?:бот|елебот|еле-елебот|балабот|ботан)(?=$|[^\p{L}\p{N}_])|@Klepchelka_bot\b/iu;

function containsBotTrigger(text: string): boolean {
	return BOT_TRIGGER_PATTERN.test(text);
}

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

function shiftDate(date: string, days: number): string {
	const shifted = new Date(`${date}T00:00:00.000Z`);
	shifted.setUTCDate(shifted.getUTCDate() + days);
	return shifted.toISOString().slice(0, 10);
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
		if (
			!saveSentDailyTask(
				date,
				dailyTaskChatId,
				message.message_id,
				dailyTaskUserId,
				DAILY_TASK_TEXT,
			)
		) {
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

bot.use(async (ctx, next) => {
	const chat = ctx.chat;
	const message = ctx.message;
	if (
		chat &&
		(chat.type === "group" || chat.type === "supergroup") &&
		message &&
		"text" in message &&
		typeof message.text === "string" &&
		!containsBotTrigger(message.text)
	) {
		console.log(
			`[FILTER] ignored group message update=${ctx.update.update_id} message=${message.message_id} chat=${chat.id}`,
		);
		return;
	}

	await next();
});

// /start
bot.command("start", async (ctx) => {
	await ctx.reply(
		"Привет! Я работаю 🤖\n\nВ группе обращайся ко мне со словом «бот» или упоминай @Klepchelka_bot. Например: «Бот, какие у меня задачи на сегодня?»"
	);
});

bot.command("myid", async (ctx) => {
	const user = ctx.from;
	if (!user) {
		await ctx.reply("Не удалось определить Telegram user ID.");
		return;
	}
	await ctx.reply(`Ваш Telegram user ID: ${user.id}`);
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
	const user = ctx.from;
	if (!user) {
		throw new Error("Telegram user is missing from a text message");
	}
	const userId = user.id;
	const normalized = text.toLocaleLowerCase("ru");
	const { date: today } = getWarsawDateTime();
	const entities = ctx.message.entities
		?.map((entity) => `${entity.type}:${entity.offset}+${entity.length}`)
		.join(",") ?? "none";
	console.log(
		`[UPDATE] text received update=${ctx.update.update_id} message=${ctx.message.message_id} chat=${chatId} user=${userId} entities=${entities}`,
	);

	if (/(?:какие|что)\s+(?:у\s+меня\s+)?задач|мои\s+задач/i.test(normalized)) {
		const targetDate = /\bзавтра\b/i.test(normalized)
			? shiftDate(today, 1)
			: today;
		const tasks = getPendingTasks(chatId, userId, targetDate);

		if (tasks.length === 0) {
			await ctx.reply(
				targetDate === today
					? "На сегодня у тебя нет невыполненных задач. ✅"
					: "На завтра у тебя пока нет задач.",
			);
			return;
		}

		const heading = targetDate === today ? "Твои задачи на сегодня:" : "Твои задачи на завтра:";
		await ctx.reply(
			`${heading}\n${tasks.map((task, index) => `${index + 1}. ${task.text}`).join("\n")}`,
		);
		return;
	}

	if (/\b(добавь|добавить|запиши|создай|поставь)\b/i.test(normalized)) {
		const dateMatch = normalized.match(/\b(сегодня|завтра)\b/);
		if (!dateMatch) {
			await ctx.reply("Уточни, на какой день добавить задачу: сегодня или завтра.");
			return;
		}

		let taskText = text
			.replace(/^\s*@Klepchelka_bot\b[\s,:-]*/i, "")
			.replace(/^\s*(?:бот[\s,:-]*)?/i, "")
			.replace(/\b(?:добавь|добавить|запиши|создай|поставь)\b/i, "")
			.replace(/\b(?:мне|себе)\b/i, "")
			.replace(/\b(?:на\s+)?(?:сегодня|завтра)\b/i, "")
			.replace(/\b(?:задачу|задача)\b/i, "")
			.replace(/\bтакую-то\b/i, "")
			.replace(/^[\s,:-]+|[\s.!?]+$/g, "")
			.trim();

		if (!taskText) {
			await ctx.reply("Напиши, какую именно задачу добавить.");
			return;
		}

		const targetDate =
			dateMatch[1] === "завтра" ? shiftDate(today, 1) : today;
		addPersonalTask(chatId, userId, targetDate, taskText);
		await ctx.reply(
			`Добавил задачу на ${dateMatch[1]}: ${taskText}`,
		);
		return;
	}

	if (containsBotTrigger(text) && /готово/iu.test(text)) {
		const task = getDailyTask(today);

		if (!task || task.chat_id !== chatId) {
			await ctx.reply("Сегодняшняя задача ещё не отправлена.");
			return;
		}

		if (task.status === "completed") {
			await ctx.reply("Задача на сегодня уже отмечена как выполненная. ✅");
			return;
		}

		if (completeDailyTask(today, chatId, text)) {
			await ctx.reply("Отметил задачу на сегодня как выполненную. ✅");
			return;
		}

		await ctx.reply("Не удалось отметить задачу. Попробуйте ещё раз.");
		return;
	}

	if (
		/\b(?:я\s+(?:уже\s+)?(?:сделал[а]?|выполнил[а]?|закончил[а]?|попылесосил[а]?|убрал[а]?|купил[а]?|помыл[а]?|приготовил[а]?|позвонил[а]?|сходил[а]?|почистил[а]?|вынес[ла]?|постирал[а]?|разобрал[а]?)|(?:сделал[а]?|выполнил[а]?|закончил[а]?|попылесосил[а]?|убрал[а]?|готово)|задача выполнена)\b/i.test(
			normalized,
		)
	) {
		const tasks = getPendingTasks(chatId, userId, today);
		if (tasks.length === 0) {
			await ctx.reply("На сегодня у тебя нет невыполненных задач.");
			return;
		}

		try {
			const decision = await matchCompletedTask(text, tasks);
			if (decision.kind === "none") {
				await ctx.reply("Не нашёл подходящую задачу на сегодня. Ничего не менял.");
				return;
			}
			if (decision.kind === "ambiguous") {
				await ctx.reply(
					`Не уверен, какую задачу отметить. Уточни, пожалуйста:\n${tasks.map((task) => `• ${task.text}`).join("\n")}`,
				);
				return;
			}

			const task = tasks.find((candidate) => candidate.id === decision.taskId);
			if (
				task &&
				completePersonalTask(task.id, chatId, userId, text)
			) {
				await ctx.reply(`Отметил выполненной задачу: ${task.text} ✅`);
				return;
			}

			await ctx.reply("Задача уже изменена или не найдена. Обнови список задач.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[TASK] unable to match completion: ${message}`);
			await ctx.reply("Не смог надёжно определить задачу и ничего не изменил.");
		}
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
			if (dailyTaskUserId !== undefined) {
				assignSentDailyTaskToUser(
					getWarsawDateTime().date,
					dailyTaskChatId,
					dailyTaskUserId,
					DAILY_TASK_TEXT,
				);
			}
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
