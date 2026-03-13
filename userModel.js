const { query } = require('./db');

async function getUserByEmail(email) {
    const rows = await query(
        `SELECT * FROM users WHERE email = ? LIMIT 1`,
        [email]
    );

    return rows[0] || null;
}

async function saveResetToken(userId, token, expiry) {
    await query(
        `UPDATE users 
     SET reset_token = ?, reset_token_expiry = ?
     WHERE id = ?`,
        [token, expiry, userId]
    );
}

module.exports = {
    getUserByEmail,
    saveResetToken
};