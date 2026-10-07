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
): boolean {
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

  return result.changes === 1;
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
