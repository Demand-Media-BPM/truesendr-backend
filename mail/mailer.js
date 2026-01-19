// // mail/mailer.js
// const nodemailer = require("nodemailer");

// function makeTransport() {
//   if (process.env.SMTP_HOST) {
//     return nodemailer.createTransport({
//       host: process.env.SMTP_HOST,
//       port: +(process.env.SMTP_PORT || 587),
//       secure: String(process.env.SMTP_SECURE || "false") === "true",
//       auth: process.env.SMTP_USER
//         ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
//         : undefined,
//     });
//   }
//   return nodemailer.createTransport({ jsonTransport: true });
// }

// const transporter = makeTransport();

// async function sendActivationEmail(to, code) {
//   const from = process.env.MAIL_FROM || "No Reply <no-reply@example.com>";
//   const subject = "Your activation code";
//   const html = `
//     <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
//       <h2>Verify your email</h2>
//       <p>Your activation code is:</p>
//       <p style="font-size:22px; letter-spacing:4px; font-weight:700">${code}</p>
//       <p>This code expires in <b>5 minutes</b>.</p>
//     </div>
//   `;
//   const text = `Your activation code is: ${code}\nThis code expires in 5 minutes.`;

//   return transporter.sendMail({ from, to, subject, text, html });
// }

// // 👇 NEW: send password reset email with link
// async function sendPasswordResetEmail(to, link) {
//   const from = process.env.MAIL_FROM || "No Reply <no-reply@example.com>";
//   const subject = "Reset your password";
//   const html = `
//     <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
//       <h2>Password reset</h2>
//       <p>We received a request to reset your password.</p>
//       <p><a href="${link}" style="display:inline-block;background:#1976d2;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Create a new password</a></p>
//       <p>Or open this link:<br/><code>${link}</code></p>
//       <p>This link expires in <b>15 minutes</b>. If you didn't request this, you can ignore this email.</p>
//     </div>
//   `;
//   const text = `Reset your password:\n${link}\n\nThis link expires in 15 minutes.`;

//   return transporter.sendMail({ from, to, subject, text, html });
// }

// module.exports = { sendActivationEmail, sendPasswordResetEmail };




// mail/mailer.js
const nodemailer = require("nodemailer");

function makeTransport() {
  if (process.env.SMTP_HOST) {
    console.log("📧 Using SMTP host:", process.env.SMTP_HOST);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false") === "true", // TLS if true
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  console.warn("⚠ No SMTP_HOST found – using JSON transport (emails will NOT be sent)");
  return nodemailer.createTransport({ jsonTransport: true });
}

const transporter = makeTransport();

async function safeSendMail(options) {
  try {
    const info = await transporter.sendMail(options);
    console.log("✅ Email sent:", info.messageId || info);
    return info;
  } catch (err) {
    console.error("❌ Failed to send email:", err);
    throw err;
  }
}

async function sendActivationEmail(to, code) {
  const from = process.env.MAIL_FROM || "No Reply <no-reply@example.com>";
  const subject = "Your activation code";
  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <h2>Verify your email</h2>
      <p>Your activation code is:</p>
      <p style="font-size:22px; letter-spacing:4px; font-weight:700">${code}</p>
      <p>This code expires in <b>5 minutes</b>.</p>
    </div>
  `;
  const text = `Your activation code is: ${code}\nThis code expires in 5 minutes.`;

  return safeSendMail({ from, to, subject, text, html });
}

async function sendPasswordResetEmail(to, link) {
  const from = process.env.MAIL_FROM || "No Reply <no-reply@example.com>";
  const subject = "Reset your password";
  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <h2>Password reset</h2>
      <p>We received a request to reset your password.</p>
      <p><a href="${link}" style="display:inline-block;background:#1976d2;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Create a new password</a></p>
      <p>Or open this link:<br/><code>${link}</code></p>
      <p>This link expires in <b>15 minutes</b>. If you didn't request this, you can ignore this email.</p>
    </div>
  `;
  const text = `Reset your password:\n${link}\n\nThis link expires in 15 minutes.`;

  return safeSendMail({ from, to, subject, text, html });
}

module.exports = { sendActivationEmail, sendPasswordResetEmail };
