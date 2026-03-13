// node test/testMailer.js

require("../config"); // this loads env.local
const sendResetEmail = require('../mailer');

sendResetEmail(process.env.SMTP_EMAIL, process.env.SMTP_PASSWORD)
    .then(() => console.log("Email sent"))
    .catch(console.error);