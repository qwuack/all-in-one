/**
 * 账户数据访问层（DAO）
 * 仅负责与 MySQL 交互：不做业务编排、不关心 GitHub 同步细节
 */

const { query } = require('../db');

async function getAccountsByUserId(userId) {
  const results = await query(
    `SELECT 
      id, user_id, platform, phone_number, name, partition_key, status,
      unread_count, latest_message_time,
      created_at, updated_at
    FROM accounts 
    WHERE user_id = ? 
    ORDER BY latest_message_time DESC, created_at DESC`,
    [userId]
  );

  return results.map(row => ({
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    phoneNumber: row.phone_number,
    name: row.name,
    partition: row.partition_key,
    status: row.status,
    unreadCount: row.unread_count || 0,
    latestMessageTime: row.latest_message_time || 0,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  }));
}

async function findAccountByPartition(userId, partition) {
  const results = await query(
    'SELECT * FROM accounts WHERE user_id = ? AND partition_key = ?',
    [userId, partition]
  );
  return results.length > 0 ? results[0] : null;
}

async function accountExists(userId, platform, phoneNumber) {
  const results = await query(
    'SELECT id FROM accounts WHERE user_id = ? AND platform = ? AND phone_number = ?',
    [userId, platform, phoneNumber]
  );
  return results.length > 0;
}

async function createAccount(userId, platform, phoneNumber, name, partition) {
  const result = await query(
    `INSERT INTO accounts (user_id, platform, phone_number, name, partition_key, status)
     VALUES (?, ?, ?, ?, ?, 'running')`,
    [userId, platform, phoneNumber, name, partition]
  );

  await query(
    'INSERT INTO account_sync_state (account_id, needs_sync) VALUES (?, TRUE)',
    [result.insertId]
  );

  return {
    id: result.insertId,
    userId,
    platform,
    phoneNumber,
    name,
    partition,
    status: 'running'
  };
}

async function deleteAccount(userId, partition) {
  const result = await query(
    'DELETE FROM accounts WHERE user_id = ? AND partition_key = ?',
    [userId, partition]
  );
  return result.affectedRows > 0;
}

async function renameAccount(userId, partition, newName) {
  const result = await query(
    'UPDATE accounts SET name = ? WHERE user_id = ? AND partition_key = ?',
    [newName, userId, partition]
  );

  if (result.affectedRows === 0) {
    return null;
  }

  await markAccountNeedsSync(userId, partition);

  return findAccountByPartition(userId, partition);
}

async function updateAccountStatus(userId, partition, status) {
  const result = await query(
    'UPDATE accounts SET status = ? WHERE user_id = ? AND partition_key = ?',
    [status, userId, partition]
  );
  return result.affectedRows > 0;
}

async function updateAccountMessageInfo(accountId, unreadCount, latestMessageTime) {
  const result = await query(
    'UPDATE accounts SET unread_count = ?, latest_message_time = ? WHERE id = ?',
    [unreadCount, latestMessageTime, accountId]
  );
  return result.affectedRows > 0;
}

async function markAccountNeedsSync(userId, partition) {
  await query(
    `UPDATE account_sync_state 
     SET needs_sync = TRUE 
     WHERE account_id IN (
       SELECT id FROM accounts WHERE user_id = ? AND partition_key = ?
     )`,
    [userId, partition]
  );
}

async function getAccountsNeedingSync(userId) {
  const results = await query(
    `SELECT a.*, s.needs_sync, s.last_sync_checksum
     FROM accounts a
     INNER JOIN account_sync_state s ON a.id = s.account_id
     WHERE a.user_id = ? AND s.needs_sync = TRUE`,
    [userId]
  );
  return results;
}

async function updateSyncState(accountId, checksum) {
  await query(
    `UPDATE account_sync_state 
     SET last_sync_checksum = ?, 
         last_synced_at = NOW(), 
         needs_sync = FALSE 
     WHERE account_id = ?`,
    [checksum, accountId]
  );
}

module.exports = {
  getAccountsByUserId,
  findAccountByPartition,
  accountExists,
  createAccount,
  deleteAccount,
  renameAccount,
  updateAccountStatus,
  updateAccountMessageInfo,
  markAccountNeedsSync,
  getAccountsNeedingSync,
  updateSyncState
};
