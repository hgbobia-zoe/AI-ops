// Give every test FILE a clean database. The in-memory SQLite connection lives in better-sqlite3's native
// handle, which survives vitest's per-file JS module isolation — so without this, one file's rows leak into
// the next (e.g. a lead "L-1" row from one file contaminating another), a flake that only shows in the full
// suite. Clearing every table at each file's start fixes it deterministically and cheaply, WITHOUT the
// per-file forked processes that OOM the CI runner ("Worker exited unexpectedly").

import { beforeAll } from "vitest";
import { getDb } from "@/lib/db";

beforeAll(() => {
  const db = getDb(); // also ensures the schema exists before we clear
  db.pragma("foreign_keys = OFF");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]);
  const clear = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM "${t.name}"`).run();
  });
  clear();
});
