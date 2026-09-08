import Database from "better-sqlite3";

const db = new Database("klepchelka.db");

export type SavedMessage = {
  role: "user" | "assistant";
  text: string;
  created_at: string;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
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
