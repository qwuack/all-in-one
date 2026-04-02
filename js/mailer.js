require("./config");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
    }
});

async function sendResetEmail(email, resetLink) {
    await transporter.verify();

    const mailOptions = {
        from: process.env.SMTP_EMAIL,
        to: email,
        subject: "Reset Password",
        html: `
        <h3>Password Reset</h3>
        <p>Click the link below to reset your password:</p>
        <a href="${resetLink}">${resetLink}</a>
        `
    };

    await transporter.sendMail(mailOptions);
    console.log(`Reset email sent to ${email}`);
}

module.exports = sendResetEmail;