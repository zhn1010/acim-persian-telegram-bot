import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "DB_multilingual.v4.json");
const outputPath = resolve(root, "migrations/0002_lessons.sql");
const database = JSON.parse(await readFile(sourcePath, "utf8"));

if (database.lesson_count !== 365 || database.lessons.length !== 365) {
  throw new Error("Expected exactly 365 lessons in DB_multilingual.v4.json");
}

const quote = (value) => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const statements = [
  "-- Generated from DB_multilingual.v4.json. Do not edit by hand.",
  "DELETE FROM lessons;",
];

for (const lesson of database.lessons) {
  const fa = lesson.content.fa;
  if (!fa?.title || !fa?.reminder_text || !fa?.full_text || !fa?.text_url) {
    throw new Error(`Incomplete Persian content for lesson ${lesson.lesson_number}`);
  }
  statements.push(
    `INSERT INTO lessons (lesson_number, title_fa, reminder_fa, full_text_fa, text_url_fa, audio_url_fa, schedule_type, schedule_options_json) VALUES (${lesson.lesson_number}, ${quote(fa.title)}, ${quote(fa.reminder_text)}, ${quote(fa.full_text)}, ${quote(fa.text_url)}, ${quote(fa.audio_url)}, ${quote(lesson.schedule.type)}, ${quote(JSON.stringify(lesson.schedule.course_specified_options))});`,
  );
}

const result = `${statements.join("\n")}\n`;
if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== result) throw new Error("migrations/0002_lessons.sql is stale; run npm run seed");
  console.log("Seed is current: 365 Persian lessons.");
} else {
  await writeFile(outputPath, result);
  console.log("Generated migrations/0002_lessons.sql with 365 Persian lessons.");
}
