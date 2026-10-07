import Database from "better-sqlite3";

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
`);

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
