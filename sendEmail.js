require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.AWS_SMTP_HOST,
    port: process.env.AWS_SMTP_PORT,
    secure: false, // Use TLS
    auth: {
        user: process.env.AWS_SMTP_USER,
        pass: process.env.AWS_SMTP_PASS,
    },
});

async function sendTestEmail(toEmail) {
    try {
        let info = await transporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: toEmail,
            subject: "Amazon SES Test Email",
            text: "Hello, this is a test email from Amazon SES!",
        });

        console.log(`Email sent successfully to ${toEmail}: ${info.messageId}`);
    } catch (error) {
        console.error(`Error sending email to ${toEmail}:`, error.message);
    }
}

// Test an email
sendTestEmail("mustafa.k@demandmediabpm.com");
