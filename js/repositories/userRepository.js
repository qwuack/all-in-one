/**
 * 用户数据访问层（DAO）
 * 注意：当前密码哈希为 sha256 的简化实现；如需更强安全性建议切换 bcrypt/argon2。
 */

const { query } = require('../db');
const crypto = require('crypto');
const bcrypt = require("bcrypt");

async function findUserByUsername(username) {
  const results = await query(
    'SELECT id, username, password_hash FROM users WHERE username = ?',
    [username]
  );
  return results.length > 0 ? results[0] : null;
}

async function findUserById(userId) {
  const results = await query(
    'SELECT id, username FROM users WHERE id = ?',
    [userId]
  );
  return results.length > 0 ? results[0] : null;
}

async function createUser(username, email, name, password) {
  const passwordHash = await hashPassword(password);

  const result = await query(
    'INSERT INTO users (username, email, name, password_hash) VALUES (?, ?, ?, ?)',
    [username, email, name, passwordHash]
  );

  return {
    id: result.insertId,
    username
  };
}

async function verifyPassword(password, hash) {
  const computedHash = await bcrypt.compare(password, hash);
  return computedHash;
}

async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

async function hashToken(email, token) {
  return crypto.createHash("sha256").update(email + token).digest("hex");
}

module.exports = {
  findUserByUsername,
  findUserById,
  createUser,
  verifyPassword,
  hashPassword,
  hashToken
};
