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

async function getResetToken(userId) {
    const rows = await query(
        `SELECT reset_token, reset_token_expiry FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

async function updateUserPassword(userId, passwordHash) {
    await query(
        `UPDATE users 
     SET password_hash = ?
     WHERE id = ?`,
        [passwordHash, userId]
    );
}

async function deleteResetToken(userId) {
    await query(
        `UPDATE users 
     SET reset_token = NULL, reset_token_expiry = NULL
     WHERE id = ?`,
        [userId]
    );
}

module.exports = {
    getUserByEmail,
    saveResetToken,
    getResetToken,
    updateUserPassword,
    deleteResetToken
};