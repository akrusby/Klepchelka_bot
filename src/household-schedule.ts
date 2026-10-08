export const HOUSEHOLD_MEMBERS = ["Андрей", "Настя", "Катя", "Лиза"] as const;

export type HouseholdMember = (typeof HOUSEHOLD_MEMBERS)[number];

export type HouseholdChore = {
	key: string;
	text: string;
	countPerWeek: number;
	eligibleMembers: readonly HouseholdMember[];
};

export type HouseholdAssignment = {
	task_date: string;
	chore_key: string;
	chore_text: string;
	member_name: HouseholdMember;
};

const EVERYONE = HOUSEHOLD_MEMBERS;
const CHILDREN = ["Катя", "Лиза"] as const satisfies readonly HouseholdMember[];

export const HOUSEHOLD_CHORES: readonly HouseholdChore[] = [
	{
		key: "vacuum-apartment",
		text: "Пылесосить квартиру",
		countPerWeek: 1,
		eligibleMembers: EVERYONE,
	},
	{
		key: "vacuum-kitchen",
		text: "Пылесосить кухню",
		countPerWeek: 3,
		eligibleMembers: EVERYONE,
	},
	{
		key: "vacuum-kids-room",
		text: "Пылесосить детскую",
		countPerWeek: 1,
		eligibleMembers: CHILDREN,
	},
	{
		key: "clean-toilet",
		text: "Мыть унитаз",
		countPerWeek: 1,
		eligibleMembers: EVERYONE,
	},
	{
		key: "clean-bathroom",
		text: "Мыть ванную",
		countPerWeek: 1,
		eligibleMembers: EVERYONE,
	},
	{
		key: "clean-mirrors",
		text: "Мыть зеркала",
		countPerWeek: 1,
		eligibleMembers: EVERYONE,
	},
	{
		key: "dust",
		text: "Протирать пыль",
		countPerWeek: 1,
		eligibleMembers: EVERYONE,
	},
];

function shuffle<T>(items: T[], random: () => number): T[] {
	for (let index = items.length - 1; index > 0; index -= 1) {
		const other = Math.floor(random() * (index + 1));
		[items[index], items[other]] = [items[other], items[index]];
	}
	return items;
}

function addDays(date: string, days: number): string {
	const result = new Date(`${date}T00:00:00.000Z`);
	result.setUTCDate(result.getUTCDate() + days);
	return result.toISOString().slice(0, 10);
}

function chooseKitchenDays(random: () => number): number[] {
	const candidates: number[][] = [];
	for (let first = 0; first < 7; first += 1) {
		for (let second = first + 2; second < 7; second += 1) {
			for (let third = second + 2; third < 7; third += 1) {
				if (first + 7 - third >= 2) {
					candidates.push([first, second, third]);
				}
			}
		}
	}
	return shuffle(candidates, random)[0];
}

export function generateHouseholdWeek(
	cycleStart: string,
	lastAssignedByChore: ReadonlyMap<string, HouseholdMember>,
	random: () => number = Math.random,
): HouseholdAssignment[] {
	const doubleDays = shuffle(
		Array.from({ length: 7 }, (_, index) => index),
		random,
	).slice(0, 2);
	const capacity = Array.from({ length: 7 }, (_, index) =>
		doubleDays.includes(index) ? 2 : 1,
	);
	const kitchenDays = chooseKitchenDays(random);
	for (const day of kitchenDays) capacity[day] -= 1;

	const choreByKey = new Map(HOUSEHOLD_CHORES.map((chore) => [chore.key, chore]));
	const choresByDay = Array.from({ length: 7 }, () => [] as HouseholdChore[]);
	const kitchenChore = choreByKey.get("vacuum-kitchen");
	if (!kitchenChore) throw new Error("Kitchen chore is not configured");
	for (const day of kitchenDays) choresByDay[day].push(kitchenChore);

	const remainingSlots = capacity.flatMap((slots, day) =>
		Array.from({ length: slots }, () => day),
	);
	const remainingChores = shuffle(
		HOUSEHOLD_CHORES.filter((chore) => chore.key !== "vacuum-kitchen"),
		random,
	);
	if (remainingSlots.length !== remainingChores.length) {
		throw new Error("Weekly chore schedule has an invalid number of slots");
	}

	shuffle(remainingSlots, random).forEach((day, index) => {
		choresByDay[day].push(remainingChores[index]);
	});

	const lastAssigned = new Map(lastAssignedByChore);
	const weeklyLoad = new Map<HouseholdMember, number>(
		HOUSEHOLD_MEMBERS.map((member) => [member, 0]),
	);
	const choresInOrder = choresByDay.flatMap((chores, dayIndex) =>
		shuffle(chores, random).map((chore) => ({ chore, dayIndex })),
	);
	const assignedMembers: HouseholdMember[] = [];

	const assign = (index: number): boolean => {
		if (index === choresInOrder.length) {
			return [...weeklyLoad.values()].every((load) => load >= 2);
		}

		const remaining = choresInOrder.length - index;
		if (
			HOUSEHOLD_MEMBERS.some(
				(member) => (weeklyLoad.get(member) ?? 0) + remaining < 2,
			)
		) {
			return false;
		}

		const { chore } = choresInOrder[index];
		const previousMember = lastAssigned.get(chore.key);
		const candidates = shuffle(
			chore.eligibleMembers.filter(
				(member) =>
					member !== previousMember && (weeklyLoad.get(member) ?? 0) < 3,
			),
			random,
		).sort(
			(first, second) =>
				(weeklyLoad.get(first) ?? 0) - (weeklyLoad.get(second) ?? 0),
		);

		for (const member of candidates) {
			const previous = lastAssigned.get(chore.key);
			lastAssigned.set(chore.key, member);
			weeklyLoad.set(member, (weeklyLoad.get(member) ?? 0) + 1);
			assignedMembers[index] = member;

			if (assign(index + 1)) return true;

			weeklyLoad.set(member, (weeklyLoad.get(member) ?? 0) - 1);
			if (previous === undefined) lastAssigned.delete(chore.key);
			else lastAssigned.set(chore.key, previous);
		}

		return false;
	};

	if (!assign(0)) {
		throw new Error("Unable to balance household chores under assignment rules");
	}

	return choresInOrder
		.map(({ chore, dayIndex }, index) => ({
			task_date: addDays(cycleStart, dayIndex),
			chore_key: chore.key,
			chore_text: chore.text,
			member_name: assignedMembers[index],
		}))
		.sort(
			(first, second) =>
				first.task_date.localeCompare(second.task_date) ||
				first.chore_key.localeCompare(second.chore_key),
		);
}
