import { createHash, randomBytes } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { createMailTransporter } from "../src/email.js";

const db = createDatabase();
const email = String(process.argv[2] || "")
  .trim()
  .toLowerCase();
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

async function main() {
  if (!email) {
    throw new Error("Usage: npm run resend-admin-invitation -- <email>");
  }

  const admin = db
    .prepare(
      "SELECT p.id,p.email,p.display_name,p.account_status FROM profiles p JOIN role_assignments r ON r.profile_id=p.id WHERE p.email=? COLLATE NOCASE AND r.role='ADMIN'",
    )
    .get(email);
  if (!admin || admin.account_status !== "INVITED") {
    throw new Error("No pending Admin invitation exists for that email.");
  }

  const transporter = createMailTransporter();
  await transporter.verify();

  const token = randomBytes(32).toString("base64url");
  const stamp = new Date().toISOString();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const tokenId = Number(
    db
      .prepare(
        "INSERT INTO auth_tokens(profile_id,token_hash,purpose,expires_at,created_at) VALUES(?,?,'INVITATION',?,?)",
      )
      .run(admin.id, hashToken(token), expires, stamp).lastInsertRowid,
  );
  const base = process.env.APP_BASE_URL || "http://127.0.0.1:5173";
  const setupUrl = `${base}/#accept-invitation?token=${encodeURIComponent(token)}`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: admin.email,
      subject: "Your Royal Barks Admin invitation",
      text: `Hello ${admin.display_name}, set your password within seven days: ${setupUrl}`,
    });
  } catch (error) {
    db.prepare("DELETE FROM auth_tokens WHERE id=?").run(tokenId);
    throw new Error(`Email delivery failed: ${error.message}`);
  }

  db.transaction(() => {
    db.prepare(
      "UPDATE auth_tokens SET used_at=? WHERE profile_id=? AND purpose='INVITATION' AND id<>? AND used_at IS NULL",
    ).run(stamp, admin.id, tokenId);
    db.prepare(
      "INSERT INTO auth_audit(actor_profile_id,target_profile_id,action,details_json,created_at) VALUES(NULL,?,'admin_invitation_resent','{}',?)",
    ).run(admin.id, stamp);
  })();
  console.log(`Admin password setup invitation sent to ${admin.email}.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
