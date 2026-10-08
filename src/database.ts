import Database from "better-sqlite3";
import {
	generateHouseholdWeek,
	type HouseholdAssignment,
	type HouseholdMember,
} from "./household-schedule.js";

const db = new Database("klepchelka.db");

export type SavedMessage = {
  role: "user" | "assistant";
  text: string;
  created_at: string;
};

export type DailyTask = {
  task_date: string;
  chat_id: number;
  status: "sent" | "completed";
  completion_text: string | null;
};

export type PersonalTask = {
  id: number;
  task_date: string;
  text: string;
  status: "pending" | "completed";
};

export type Reminder = {
  id: number;
  chat_id: number;
  text: string;
  due_at: string;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_tasks (
    task_date TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'completed')),
    sent_message_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    completed_at TEXT,
    completion_text TEXT
  );

  CREATE TABLE IF NOT EXISTS personal_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    task_date TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    completion_text TEXT
  );

  CREATE INDEX IF NOT EXISTS personal_tasks_owner_date_status
  ON personal_tasks (chat_id, user_id, task_date, status);

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    due_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  CREATE INDEX IF NOT EXISTS reminders_pending_due
  ON reminders (due_at)
  WHERE sent_at IS NULL;

  CREATE TABLE IF NOT EXISTS household_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_start TEXT NOT NULL,
    task_date TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    chore_key TEXT NOT NULL,
    chore_text TEXT NOT NULL,
    member_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (chat_id, task_date, chore_key)
  );

  CREATE INDEX IF NOT EXISTS household_assignments_chore_history
  ON household_assignments (chat_id, chore_key, task_date DESC);

  CREATE TABLE IF NOT EXISTS household_schedule_state (
    state_key TEXT PRIMARY KEY,
    state_value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS household_daily_notifications (
    task_date TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (task_date, chat_id)
  );
`);

export function addReminder(
  chatId: number,
  userId: number,
  text: string,
  dueAt: Date,
): number {
  const result = db.prepare(`
    INSERT INTO reminders (chat_id, user_id, text, due_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    chatId,
    userId,
    text,
    dueAt.toISOString(),
    new Date().toISOString(),
  );

  return Number(result.lastInsertRowid);
}

export function getDueReminders(now: Date, limit = 20): Reminder[] {
  return db.prepare(`
    SELECT id, chat_id, text, due_at
    FROM reminders
    WHERE sent_at IS NULL AND due_at <= ?
    ORDER BY due_at, id
    LIMIT ?
  `).all(now.toISOString(), limit) as Reminder[];
}

export function getLatestPendingReminder(
  chatId: number,
  userId: number,
): Reminder | undefined {
  return db.prepare(`
    SELECT id, chat_id, text, due_at
    FROM reminders
    WHERE chat_id = ? AND user_id = ? AND sent_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(chatId, userId) as Reminder | undefined;
}

export function rescheduleReminder(
  reminderId: number,
  chatId: number,
  userId: number,
  dueAt: Date,
): boolean {
  const result = db.prepare(`
    UPDATE reminders
    SET due_at = ?
    WHERE id = ? AND chat_id = ? AND user_id = ? AND sent_at IS NULL
  `).run(dueAt.toISOString(), reminderId, chatId, userId);

  return result.changes === 1;
}

export function markReminderSent(reminderId: number): boolean {
  const result = db.prepare(`
    UPDATE reminders
    SET sent_at = ?
    WHERE id = ? AND sent_at IS NULL
  `).run(new Date().toISOString(), reminderId);

  return result.changes === 1;
}

export function saveMessage(
  chatId: number,
  role: "user" | "assistant",
  text: string,
): void {
  const statement = db.prepare(`
    INSERT INTO messages (chat_id, role, text, created_at)
    VALUES (?, ?, ?, ?)
  `);

  statement.run(chatId, role, text, new Date().toISOString());
}

export function getRecentMessages(
  chatId: number,
  limit = 20,
): SavedMessage[] {
  return db
    .prepare(`
      SELECT role, text, created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(chatId, limit) as SavedMessage[];
}

export function getMessageCount(chatId: number): number {
  const result = db
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?")
    .get(chatId) as { count: number };

  return result.count;
}

export function getDailyTask(taskDate: string): DailyTask | undefined {
  return db
    .prepare(`
      SELECT task_date, chat_id, status, completion_text
      FROM daily_tasks
      WHERE task_date = ?
    `)
    .get(taskDate) as DailyTask | undefined;
}

export function saveSentDailyTask(
  taskDate: string,
  chatId: number,
  messageId: number,
  userId?: number,
  text?: string,
): boolean {
  const save = db.transaction(() => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO daily_tasks (
        task_date,
        chat_id,
        status,
        sent_message_id,
        sent_at
      )
      VALUES (?, ?, 'sent', ?, ?)
    `).run(taskDate, chatId, messageId, new Date().toISOString());

    if (result.changes !== 1) {
      return false;
    }

    if (userId !== undefined && text !== undefined) {
      db.prepare(`
        INSERT INTO personal_tasks (
          chat_id,
          user_id,
          task_date,
          text,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(chatId, userId, taskDate, text, new Date().toISOString());
    }

    return true;
  });

  return save();
}

export function assignSentDailyTaskToUser(
  taskDate: string,
  chatId: number,
  userId: number,
  text: string,
): void {
  const task = getDailyTask(taskDate);
  if (!task || task.chat_id !== chatId || task.status !== "sent") {
    return;
  }

  db.prepare(`
    INSERT INTO personal_tasks (
      chat_id,
      user_id,
      task_date,
      text,
      status,
      created_at
    )
    SELECT ?, ?, ?, ?, 'pending', ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM personal_tasks
      WHERE chat_id = ?
        AND user_id = ?
        AND task_date = ?
        AND text = ?
    )
  `).run(
    chatId,
    userId,
    taskDate,
    text,
    new Date().toISOString(),
    chatId,
    userId,
    taskDate,
    text,
  );
}

export function completeDailyTask(
  taskDate: string,
  chatId: number,
  completionText: string,
): boolean {
  const result = db.prepare(`
    UPDATE daily_tasks
    SET status = 'completed',
        completed_at = ?,
        completion_text = ?
    WHERE task_date = ?
      AND chat_id = ?
      AND status = 'sent'
  `).run(new Date().toISOString(), completionText, taskDate, chatId);

  return result.changes === 1;
}

export function getPendingTasks(
  chatId: number,
  userId: number,
  taskDate: string,
): PersonalTask[] {
  return db
    .prepare(`
      SELECT id, task_date, text, status
      FROM personal_tasks
      WHERE chat_id = ?
        AND user_id = ?
        AND task_date = ?
        AND status = 'pending'
      ORDER BY id
    `)
    .all(chatId, userId, taskDate) as PersonalTask[];
}

export function addPersonalTask(
  chatId: number,
  userId: number,
  taskDate: string,
  text: string,
): number {
  const result = db.prepare(`
    INSERT INTO personal_tasks (
      chat_id,
      user_id,
      task_date,
      text,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(chatId, userId, taskDate, text, new Date().toISOString());

  return Number(result.lastInsertRowid);
}

export function completePersonalTask(
  taskId: number,
  chatId: number,
  userId: number,
  completionText: string,
): boolean {
  const result = db.prepare(`
    UPDATE personal_tasks
    SET status = 'completed',
        completed_at = ?,
        completion_text = ?
    WHERE id = ?
      AND chat_id = ?
      AND user_id = ?
      AND status = 'pending'
  `).run(
    new Date().toISOString(),
    completionText,
    taskId,
    chatId,
    userId,
  );

  return result.changes === 1;
}

function shiftDate(date: string, days: number): string {
	const shifted = new Date(`${date}T00:00:00.000Z`);
	shifted.setUTCDate(shifted.getUTCDate() + days);
	return shifted.toISOString().slice(0, 10);
}

export function getHouseholdCycleStartDate(today: string): string {
	const state = db
		.prepare(`
			SELECT state_value
			FROM household_schedule_state
			WHERE state_key = 'cycle_start_date'
		`)
		.get() as { state_value: string } | undefined;

	if (!state) {
		db.prepare(`
			INSERT INTO household_schedule_state (state_key, state_value)
			VALUES ('cycle_start_date', ?)
		`).run(today);
		return today;
	}

	const start = new Date(`${state.state_value}T00:00:00.000Z`);
	const current = new Date(`${today}T00:00:00.000Z`);
	const elapsedDays = Math.floor(
		(current.getTime() - start.getTime()) / 86_400_000,
	);
	if (elapsedDays < 7) return state.state_value;

	const cycleStart = shiftDate(
		state.state_value,
		Math.floor(elapsedDays / 7) * 7,
	);
	db.prepare(`
		UPDATE household_schedule_state
		SET state_value = ?
		WHERE state_key = 'cycle_start_date'
	`).run(cycleStart);
	return cycleStart;
}

export function ensureHouseholdWeeklySchedule(
	cycleStart: string,
	chatId: number,
): void {
	const createSchedule = db.transaction(() => {
		const existing = db
			.prepare(`
				SELECT COUNT(*) AS count
				FROM household_assignments
				WHERE cycle_start = ? AND chat_id = ?
			`)
			.get(cycleStart, chatId) as { count: number };
		if (existing.count > 0) return;

		const historyRows = db
			.prepare(`
				SELECT chore_key, member_name
				FROM household_assignments
				WHERE chat_id = ? AND task_date < ?
				ORDER BY task_date DESC, id DESC
			`)
			.all(chatId, cycleStart) as Array<{
				chore_key: string;
				member_name: HouseholdMember;
			}>;
		const lastAssignedByChore = new Map<string, HouseholdMember>();
		for (const row of historyRows) {
			if (!lastAssignedByChore.has(row.chore_key)) {
				lastAssignedByChore.set(row.chore_key, row.member_name);
			}
		}

		const assignments = generateHouseholdWeek(
			cycleStart,
			lastAssignedByChore,
		);
		const insert = db.prepare(`
			INSERT INTO household_assignments (
				cycle_start,
				task_date,
				chat_id,
				chore_key,
				chore_text,
				member_name,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		const createdAt = new Date().toISOString();
		for (const assignment of assignments) {
			insert.run(
				cycleStart,
				assignment.task_date,
				chatId,
				assignment.chore_key,
				assignment.chore_text,
				assignment.member_name,
				createdAt,
			);
		}
	});

	createSchedule();
}

export function getHouseholdAssignments(
	taskDate: string,
	chatId: number,
): HouseholdAssignment[] {
	return db
		.prepare(`
			SELECT task_date, chore_key, chore_text, member_name
			FROM household_assignments
			WHERE task_date = ? AND chat_id = ?
			ORDER BY id
		`)
		.all(taskDate, chatId) as HouseholdAssignment[];
}

export function hasHouseholdDailyNotification(
	taskDate: string,
	chatId: number,
): boolean {
	return Boolean(
		db
			.prepare(`
				SELECT 1
				FROM household_daily_notifications
				WHERE task_date = ? AND chat_id = ?
			`)
			.get(taskDate, chatId),
	);
}

export function saveHouseholdDailyNotification(
	taskDate: string,
	chatId: number,
	messageId: number,
): boolean {
	const result = db
		.prepare(`
			INSERT OR IGNORE INTO household_daily_notifications (
				task_date,
				chat_id,
				message_id,
				sent_at
			)
			VALUES (?, ?, ?, ?)
		`)
		.run(taskDate, chatId, messageId, new Date().toISOString());

	return result.changes === 1;
}
