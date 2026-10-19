import { createDatabase } from "../src/database.js";
import { createMailTransporter } from "../src/email.js";

const db = createDatabase();
const recipient = String(process.argv[2] || "").trim();

async function main() {
  if (!recipient) {
    throw new Error("Usage: npm run email-test -- <recipient email>");
  }

  const transporter = createMailTransporter();
  await transporter.verify();
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: recipient,
    subject: "Royal Barks email delivery test",
    text: "This test confirms Royal Barks can send mail through its configured SMTP provider.",
  });
  console.log(`Test email sent to ${recipient}.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
