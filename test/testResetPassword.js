// test/testResetPassword.js
const crypto = require("crypto");
const { hashToken } = require('./repositories/userRepository');

// Fake in-memory user database for testing
const users = [
    { id: 1, email: "test@example.com", reset_token: null, reset_token_expiry: null },
];

// Mock functions to simulate your database
async function getUserByEmail(email) {
    return users.find(u => u.email === email);
}

async function saveResetToken(userId, token, expiry) {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    user.reset_token = token;
    user.reset_token_expiry = expiry;
}

// Generate reset link
async function generateResetLink(email) {
    const user = await getUserByEmail(email);
    if (!user) return console.log("User not found");

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = Date.now() + 15 * 60 * 1000; // 15 minutes
    await saveResetToken(user.id, token, expiry);

    const key = await hashToken(email, token);

    const resetLink = `${process.env.DOMAIN_URL}/all-in-one/reset-password.html?email=${encodeURIComponent(email)}&key=${key}`;

    console.log("Reset link:", resetLink);
    console.log("Token expires at:", new Date(expiry).toLocaleString());
}

// Run test
generateResetLink("test@example.com");