import "dotenv/config";
import { Bot } from "grammy";
import { generateAnswer, getAiDiagnostics, matchCompletedTask } from "./ai.js";
import {
	addPersonalTask,
	completePersonalTask,
	addReminder,
	ensureHouseholdWeeklySchedule,
	getDueReminders,
	getHouseholdAssignments,
	getHouseholdCycleStartDate,
	getLatestPendingReminder,
	hasHouseholdDailyNotification,
	getMessageCount,
	getPendingTasks,
	getRecentMessages,
	markReminderSent,
	rescheduleReminder,
	saveHouseholdDailyNotification,
	saveMessage,
} from "./database.js";
import { HOUSEHOLD_MEMBERS } from "./household-schedule.js";
import { parseReminder } from "./reminders.js";
import { loadUrlContext } from "./url-loader.js";

const token = process.env.BOT_TOKEN;
const householdTaskChatId = process.env.DAILY_TASK_CHAT_ID
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
	householdTaskChatId !== undefined &&
	(!Number.isSafeInteger(householdTaskChatId) ||
		!allowedChatIds.includes(householdTaskChatId))
) {
	throw new Error("DAILY_TASK_CHAT_ID must be an integer in ALLOWED_CHAT_IDS");
}

const bot = new Bot(token);
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

let sendingHouseholdTasks = false;
let sendingReminders = false;

async function sendHouseholdTasksIfDue(): Promise<void> {
	if (householdTaskChatId === undefined || sendingHouseholdTasks) {
		return;
	}

	const { date, hour, minute } = getWarsawDateTime();
	if (
		hour !== 9 ||
		minute > 5 ||
		hasHouseholdDailyNotification(date, householdTaskChatId)
	) {
		return;
	}

	sendingHouseholdTasks = true;
	try {
		const cycleStart = getHouseholdCycleStartDate(date);
		ensureHouseholdWeeklySchedule(cycleStart, householdTaskChatId);
		const assignments = getHouseholdAssignments(date, householdTaskChatId);
		if (assignments.length === 0) {
			throw new Error(`No household assignments generated for date=${date}`);
		}

		const sections = HOUSEHOLD_MEMBERS.map((member) => {
			const chores = assignments
				.filter((assignment) => assignment.member_name === member)
				.map((assignment) => `• ${assignment.chore_text}`);
			return `${member}\n${chores.length > 0 ? chores.join("\n") : "• Сегодня выходной"}`;
		});
		const message = await bot.api.sendMessage(
			householdTaskChatId,
			`Домашние задачи на сегодня (${date})\n\n${sections.join("\n\n")}`,
		);
		if (!saveHouseholdDailyNotification(date, householdTaskChatId, message.message_id)) {
			console.error(`[TASK] household task list already recorded date=${date}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[TASK] unable to send household task list date=${date}: ${message}`);
	} finally {
		sendingHouseholdTasks = false;
	}
}

async function sendDueReminders(): Promise<void> {
	if (sendingReminders) {
		return;
	}

	sendingReminders = true;
	try {
		for (const reminder of getDueReminders(new Date())) {
			try {
				const prefix = "⏰ Напоминание: ";
				const entities = [
					...reminder.text.matchAll(/(^|[^\p{L}\p{N}_])(@[A-Za-z][A-Za-z0-9_]{4,31})/gu),
				].map((match) => ({
					type: "mention" as const,
					offset: prefix.length + (match.index ?? 0) + match[1].length,
					length: match[2].length,
				}));
				await bot.api.sendMessage(
					reminder.chat_id,
					`${prefix}${reminder.text}`,
					{ entities },
				);
				if (!markReminderSent(reminder.id)) {
					console.error(
						`[REMINDER] unable to mark reminder sent id=${reminder.id}`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(
					`[REMINDER] unable to send reminder id=${reminder.id}: ${message}`,
				);
			}
		}
	} finally {
		sendingReminders = false;
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

	if (/(?<![\p{L}\p{N}_])напомни(?:ть)?(?![\p{L}\p{N}_])/iu.test(text)) {
		const reminder = parseReminder(text);
		if (!reminder) {
			await ctx.reply(
				"Укажи время напоминания: например, «через час» или «сейчас». Максимум — год.",
			);
			return;
		}
		let reminderText = reminder.text;
		if (!reminderText) {
			const previousReminder = getLatestPendingReminder(chatId, userId);
			if (!previousReminder) {
				await ctx.reply(
					"Напиши, о чём напомнить. Например: «Бот, напомни через час купить хлеб».",
				);
				return;
			}
			if (
				!rescheduleReminder(
					previousReminder.id,
					chatId,
					userId,
					reminder.dueAt,
				)
			) {
				await ctx.reply("Не удалось обновить напоминание. Попробуй ещё раз.");
				return;
			}
			reminderText = previousReminder.text;
		} else {
			addReminder(chatId, userId, reminderText, reminder.dueAt);
		}
		await ctx.reply(
			reminder.dueAt.getTime() <= Date.now()
				? `Хорошо, напомню сейчас: ${reminderText}`
				: `Хорошо, напомню ${reminder.dueAt.toLocaleString("ru-RU", { timeZone: DAILY_TASK_TIME_ZONE })}: ${reminderText}`,
		);
		if (reminder.dueAt.getTime() <= Date.now()) {
			void sendDueReminders();
		}
		return;
	}

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
			void sendDueReminders();
			setInterval(() => void sendDueReminders(), 15_000);
			if (householdTaskChatId !== undefined) {
				console.log(
					`[TASK] household rotation enabled chat=${householdTaskChatId} time=09:00 ${DAILY_TASK_TIME_ZONE}`,
				);
				void sendHouseholdTasksIfDue();
				setInterval(() => void sendHouseholdTasksIfDue(), 15_000);
			} else {
				console.log("[TASK] household rotation disabled: DAILY_TASK_CHAT_ID is not set");
			}
	},
});
