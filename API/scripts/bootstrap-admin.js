import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bootstrapAdmin, initializeAuth } from "../src/auth.js";
import { createDatabase } from "../src/database.js";

const db = createDatabase();
initializeAuth(db, (event, actor, entity, id, details) =>
  db
    .prepare(
      "INSERT INTO audit_log(event,actor,entity,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(event, actor, entity, id, JSON.stringify(details), new Date().toISOString()),
);
const rl = createInterface({ input: stdin, output: stdout });
const secret = () =>
  new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      stdout.write("Initial password (12+ characters): ");
      stdin.setEncoding("utf8");
      stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      return;
    }
    stdout.write("Initial password (12+ characters): ");
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (chunk) => {
      for (const c of chunk.toString()) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
        } else if (c === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          reject(new Error("Bootstrap cancelled."));
        } else if (c === "\u007f" || c === "\b") {
          value = value.slice(0, -1);
        } else value += c;
      }
    };
    stdin.on("data", onData);
  });
try {
  const email = process.argv[2] || (await rl.question("Admin email: "));
  const displayName = process.argv[3] || (await rl.question("Admin display name: "));
  const memberText =
    process.argv[4] || (await rl.question("Linked member ID (leave blank if not available): "));
  rl.close();
  const password = await secret();
  const id = await bootstrapAdmin(db, {
    email,
    displayName,
    memberId: memberText ? Number(memberText) : null,
    password,
  });
  stdout.write(
    `Initial Admin created with profile ID ${id}. This bootstrap command is now disabled by the database guard.\n`,
  );
} catch (e) {
  stdout.write(`Bootstrap failed: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
  await db.close();
}
