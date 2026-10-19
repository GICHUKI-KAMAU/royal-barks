import nodemailer from "nodemailer";

export function createMailTransporter(environment = process.env) {
  const host = environment.SMTP_HOST;
  const sender = environment.SMTP_FROM;
  const user = environment.SMTP_USER;
  const password = environment.SMTP_PASSWORD;

  if (!host || !sender) {
    throw new Error("Email delivery requires SMTP_HOST and SMTP_FROM configuration.");
  }
  if (Boolean(user) !== Boolean(password)) {
    throw new Error("Set both SMTP_USER and SMTP_PASSWORD to authenticate with SMTP.");
  }

  return nodemailer.createTransport({
    host,
    port: Number(environment.SMTP_PORT || 587),
    secure: environment.SMTP_SECURE === "true",
    auth: user ? { user, pass: password } : undefined,
  });
}
