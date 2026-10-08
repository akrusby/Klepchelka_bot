export type ParsedReminder = {
	dueAt: Date;
	text: string;
};

const TIME_ZONE = "Europe/Warsaw";
const REMINDER_TIME_PATTERN =
	/(?<![\p{L}\p{N}_])через\s+(?:(\d+|один|одна|одно|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)\s*)?(секунд(?:а|ы|у)?|минут(?:а|ы|у)?|час(?:а|ов)?|д(?:ень|ня|ней))(?![\p{L}\p{N}_])/iu;
const REMINDER_NUMBERS: Record<string, number> = {
	один: 1,
	одна: 1,
	одно: 1,
	одну: 1,
	два: 2,
	две: 2,
	три: 3,
	четыре: 4,
	пять: 5,
	шесть: 6,
	семь: 7,
	восемь: 8,
	девять: 9,
	десять: 10,
};

function getWarsawDateTime(date: Date): { date: string; hour: number } {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

	return {
		date: `${values.year}-${values.month}-${values.day}`,
		hour: Number(values.hour),
	};
}

function shiftDate(date: string, days: number): string {
	const shifted = new Date(`${date}T00:00:00.000Z`);
	shifted.setUTCDate(shifted.getUTCDate() + days);
	return shifted.toISOString().slice(0, 10);
}

function getWarsawDateTimeFor(date: string, hour: number, minute: number): Date {
	const [year, month, day] = date.split("-").map(Number);
	const desiredLocalTime = Date.UTC(year, month - 1, day, hour, minute);
	const formattedParts = new Intl.DateTimeFormat("en-GB", {
		timeZone: TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(desiredLocalTime));
	const values = Object.fromEntries(
		formattedParts.map(({ type, value }) => [type, value]),
	);
	const representedLocalTime = Date.UTC(
		Number(values.year),
		Number(values.month) - 1,
		Number(values.day),
		Number(values.hour),
		Number(values.minute),
		Number(values.second),
	);

	return new Date(desiredLocalTime - (representedLocalTime - desiredLocalTime));
}

export function parseReminder(text: string, now = new Date()): ParsedReminder | undefined {
	const command = /(?<![\p{L}\p{N}_])напомни(?:ть)?(?![\p{L}\p{N}_])/iu.exec(text);
	if (!command || command.index === undefined) {
		return undefined;
	}

	const commandEnd = command.index + command[0].length;
	const remainder = text.slice(commandEnd);
	const nowMatch = /(?<![\p{L}\p{N}_])сейчас(?![\p{L}\p{N}_])/iu.exec(remainder);
	const eveningMatch =
		/(?<![\p{L}\p{N}_])(?:(завтра)\s+)?вечером(?![\p{L}\p{N}_])/iu.exec(remainder);
	const relativeTimeMatch = REMINDER_TIME_PATTERN.exec(remainder);
	const timeMatch = nowMatch ?? eveningMatch ?? relativeTimeMatch;
	if (!timeMatch || timeMatch.index === undefined) {
		return undefined;
	}

	let dueAt: Date;
	if (timeMatch === nowMatch) {
		dueAt = now;
	} else if (timeMatch === eveningMatch) {
		const { date, hour } = getWarsawDateTime(now);
		const daysAhead = eveningMatch[1] === "завтра" || hour >= 20 ? 1 : 0;
		dueAt = getWarsawDateTimeFor(shiftDate(date, daysAhead), 20, 0);
	} else {
		const quantity = relativeTimeMatch?.[1] ?? "1";
		const amount =
			Number(quantity) || REMINDER_NUMBERS[quantity.toLocaleLowerCase("ru")];
		const unit = relativeTimeMatch?.[2].toLocaleLowerCase("ru") ?? "";
		const unitMs = unit.startsWith("секунд")
			? 1_000
			: unit.startsWith("минут")
				? 60_000
				: unit.startsWith("час")
					? 3_600_000
					: 86_400_000;
		const delayMs = amount * unitMs;
		if (!Number.isFinite(delayMs) || delayMs > 365 * 86_400_000) {
			return undefined;
		}
		dueAt = new Date(now.getTime() + delayMs);
	}

	const beforeTime = remainder
		.slice(0, timeMatch.index)
		.replace(/^\s*(?:мне|себе)(?![\p{L}\p{N}_])/iu, " ")
		.replace(/[\s,:;-]+$/g, "");
	const afterTime = remainder
		.slice(timeMatch.index + timeMatch[0].length)
		.replace(/^[\s,:;-]*(?:чтобы|чтоб|что)(?![\p{L}\p{N}_])[\s,:;-]*/iu, " ")
		.replace(/^[\s,:;-]+/g, "");
	const reminderText = `${beforeTime} ${afterTime}`
		.replace(/^[\s,:;-]+|[\s.!?]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	return { dueAt, text: reminderText };
}
