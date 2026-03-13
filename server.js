// main.js or server.js
const express = require("express");
const { getUserByEmail } = require("./userModel");
const crypto = require("crypto");

const app = express();
app.use(express.json());

app.get("/reset-password", async (req, res) => {
    const { email, key } = req.query;

    if (!email || !key) return res.status(400).send("Invalid link");

    const user = await getUserByEmail(email);
    if (!user) return res.status(404).send("User not found");

    const expectedKey = crypto.createHash("sha256").update(email + user.reset_token).digest("hex");
    if (key !== expectedKey || Date.now() > user.reset_token_expiry) {
        return res.status(400).send("Token invalid or expired");
    }

    // Token valid → show password reset page in your Electron app
    res.send("Token valid! Show password reset form.");
});

// Start server
app.listen(3000, () => console.log("Server running on port 3000"));