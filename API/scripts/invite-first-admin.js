import { createAdminInvitation, initializeAuth } from "../src/auth.js";
import { createDatabase } from "../src/database.js";
import { createMailTransporter } from "../src/email.js";

const db = createDatabase();
const email = process.argv[2];
const displayName = process.argv[3] || email?.split("@")[0];

function createSetupUrl(token) {
  const base = process.env.APP_BASE_URL || "http://127.0.0.1:5173";
  return `${base}/#accept-invitation?token=${encodeURIComponent(token)}`;
}

async function sendInvitation(invitation, setupUrl) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.SMTP_PASSWORD) {
    return false;
  }

  const transporter = createMailTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: invitation.email,
    subject: "Your Royal Barks Admin invitation",
    text: `Hello ${invitation.displayName}, set your password within seven days: ${setupUrl}`,
  });
  return true;
}

async function main() {
  if (!email) {
    throw new Error("Usage: npm run bootstrap-admin-invitation -- <email> [display name]");
  }

  initializeAuth(db);
  const invitation = createAdminInvitation(db, { email, displayName });
  const setupUrl = createSetupUrl(invitation.token);

  try {
    const sent = await sendInvitation(invitation, setupUrl);
    if (sent) {
      console.log(`Admin invitation sent to ${invitation.email}. It expires in seven days.`);
      return;
    }

    console.log("SMTP is not configured. The Admin invitation is ready but was not emailed.");
    console.log(`Use this one-time password setup link within seven days: ${setupUrl}`);
  } catch {
    console.error("Email delivery failed. The invitation is still valid; use this setup link:");
    console.error(setupUrl);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
