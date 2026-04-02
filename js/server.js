// server.js
const express = require("express");
const cors = require("cors");
const { getUserByEmail, updateUserPassword, getResetToken, deleteResetToken } = require("./userModel");
const { hashToken } = require('./repositories/userRepository');
const { config } = require('./config');

const app = express();


// Allow GitHub Pages origin
app.use(cors({
    origin: process.env.DOMAIN_URL, // allow only your frontend
    methods: ["GET", "POST", "PUT", "DELETE"]
}));
app.use(express.json());
// Optional: keep your GET endpoint for token validation if you want
app.get("/reset-password", async (req, res) => {
    const { email, key } = req.query;

    if (!email || !key) return res.status(400).send("Invalid link");

    const user = await getUserByEmail(email);
    if (!user) return res.status(404).send("User not found");

    const record = await getResetToken(user.id);
    if (!record) return res.status(400).send("Token invalid or expired");

    const expectedKey = await hashToken(email, record.token);

    console.log("key from URL:", key);
    console.log("expected key:", expectedKey);
    console.log("token in DB:", record.token);
    console.log("expiry:", record.expiry, "now:", Date.now());

    if (key !== expectedKey || Date.now() > record.expiry) {
        return res.status(400).send("Token invalid or expired");
    }

    res.send("Token valid! Show password reset form.");
});

// ✅ Add POST endpoint for frontend form submission
app.post("/api/reset-password", async (req, res) => {
    const { email, key, newPassword } = req.body;

    try {
        const user = await getUserByEmail(email);
        console.log(user);
        if (!user) return res.json({ success: false, message: "User not found" });

        const record = await getResetToken(user.id);
        console.log(record);
        if (!record) return res.json({ success: false, message: "Invalid token" });

        const expectedKey = await hashToken(email, record.reset_token);

        console.log("Key from URL:", key);
        console.log("Expected key:", expectedKey);
        console.log("Token in DB:", record.reset_token);
        console.log("Expiry:", record.reset_token_expiry, "Now:", Date.now());

        if (key !== expectedKey) return res.json({ success: false, message: "Invalid token" });

        if (Date.now() > record.reset_token_expiry) return res.json({ success: false, message: "Token expired" });

        const hashedPassword = await hashPassword(newPassword);
        await updateUserPassword(user.id, hashedPassword);

        await deleteResetToken(user.id);

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Start server
app.listen(3000, () => console.log("Server running on port 3000"));