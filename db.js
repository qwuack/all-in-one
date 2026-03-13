/**
 * MySQL 访问封装
 * - 维护单例连接池（lazy init）
 * - 提供 `query/transaction` 基础能力
 * - `initDatabase()` 可重复调用（幂等建表）
 */

const mysql = require('mysql2/promise');
const { config, validateMysqlConfig } = require('./config');
const logger = require('./logger');

let pool = null;

async function createDbPool() {
  if (pool) {
    return pool;
  }

  if (!validateMysqlConfig()) {
    throw new Error('MySQL 配置验证失败，请检查环境变量（MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE）');
  }

  try {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: config.mysql.waitForConnections,
      connectionLimit: config.mysql.connectionLimit,
      queueLimit: config.mysql.queueLimit,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });

    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();

    logger.info('DB', 'Database connection pool created successfully');
    return pool;
  } catch (error) {
    logger.error('DB', 'Database connection failed', error);
    throw error;
  }
}

async function query(sql, params = []) {
  if (!pool) {
    await createDbPool();
  }

  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    logger.error('DB', 'Database query error', error);
    throw error;
  }
}

async function transaction(callback) {
  if (!pool) {
    await createDbPool();
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('DB', 'Database connection pool closed');
  }
}

async function initDatabase() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id bigint(20) NOT NULL,
        name varchar(255) DEFAULT NULL,
        username varchar(100) NOT NULL,
        password_hash varchar(255) NOT NULL,
        email varchar(255) DEFAULT NULL,
        reset_token text DEFAULT NULL,
        reset_token_expiry bigint(20) DEFAULT NULL,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        name VARCHAR(100) NOT NULL,
        partition_key VARCHAR(200) NOT NULL,
        status VARCHAR(20) DEFAULT 'running',
        unread_count INT DEFAULT 0,
        latest_message_time BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY uk_user_platform_phone (user_id, platform, phone_number),
        INDEX idx_user_id (user_id),
        INDEX idx_partition (partition_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS account_sync_state (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        account_id BIGINT NOT NULL,
        last_sync_checksum VARCHAR(64),
        last_synced_at TIMESTAMP NULL,
        needs_sync BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        UNIQUE KEY uk_account_id (account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    logger.info('DB', 'Database tables initialized');
  } catch (error) {
    logger.error('DB', 'Database initialization failed', error);
    throw error;
  }
}

module.exports = {
  createDbPool,
  query,
  transaction,
  closePool,
  initDatabase
};
