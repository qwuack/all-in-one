/**
 * 运行时配置（从环境变量读取）
 * - 这里不应写入任何真实密钥（例如 GitHub PAT）
 * - `.env` 仅用于本地开发；生产环境建议由部署系统注入环境变量
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Load env vars (robust for packaged exe):
 * - Dev: prefer `${cwd}/.env` then `${cwd}/env.local`
 * - Packaged: also try exe-dir / resources / appPath / userData
 */
let loadedEnvFrom = null;
function tryLoadEnvFile(p) {
  try {
    if (!p) return false;
    if (!fs.existsSync(p)) return false;
    dotenv.config({ path: p });
    loadedEnvFrom = p;
    return true;
  } catch {
    return false;
  }
}

try {
  const cwd = process.cwd();
  const candidates = [];

  // 1) current working directory (dev / manual run)
  candidates.push(path.join(cwd, '.env'));
  candidates.push(path.join(cwd, 'env.local'));

  // 2) packaged app common locations
  try {
    // exe dir (Windows installed/unpacked)
    if (process.execPath) {
      candidates.push(path.join(path.dirname(process.execPath), 'env.local'));
      candidates.push(path.join(path.dirname(process.execPath), '.env'));
    }
  } catch { }

  try {
    // electron resources path (when packaged)
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'env.local'));
      candidates.push(path.join(process.resourcesPath, '.env'));
    }
  } catch { }

  try {
    // electron app paths (when running in Electron main process)
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { app } = require('electron');
    if (app) {
      // app.getAppPath() may point to app.asar; still useful for adjacent file lookup
      const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : null;
      if (appPath) {
        candidates.push(path.join(appPath, 'env.local'));
        candidates.push(path.join(appPath, '.env'));
      }
      const userData = typeof app.getPath === 'function' ? app.getPath('userData') : null;
      if (userData) {
        candidates.push(path.join(userData, 'env.local'));
        candidates.push(path.join(userData, '.env'));
      }
    }
  } catch { }

  // first hit wins
  let ok = false;
  for (const p of candidates) {
    if (tryLoadEnvFile(p)) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    // fallback: will read from process.env only
    dotenv.config();
  }
} catch {
  dotenv.config();
}
const logger = require('./logger');

const config = {
  mysql: {
    host: process.env.MYSQL_HOST || '192.168.100.113',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'crm_db',
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
  },

  github: {
    owner: process.env.GITHUB_OWNER || 'qwuack',
    repo: process.env.GITHUB_REPO || 'SaaS',
    branch: process.env.GITHUB_BRANCH || 'main',
    basePath: process.env.GITHUB_BASE_PATH || 'users',
    pat: process.env.GITHUB_PAT || ''
  },

  smtp: {
    email: process.env.SMTP_EMAIL || '',
    password: process.env.SMTP_PASSWORD || ''
  },

  domain: {
    url: process.env.DOMAIN_URL || '',
  },

  app: {
    sessionBasePath: 'sessions',
    enableSync: process.env.ENABLE_SYNC !== 'false'
  }
};

function validateMysqlConfig() {
  const errors = [];
  if (!config.mysql.host) errors.push('MySQL host 未配置（MYSQL_HOST）');
  if (!config.mysql.user) errors.push('MySQL user 未配置（MYSQL_USER）');
  if (!config.mysql.database) errors.push('MySQL database 未配置（MYSQL_DATABASE）');

  if (errors.length > 0) {
    logger.warn('Config', `MySQL 配置缺失: ${errors.join(', ')}`);
    logger.warn('Config', '请检查环境变量（或创建 .env 文件）');
  }

  return errors.length === 0;
}

function validateGitHubConfig() {
  const errors = [];

  if (!config.github.owner) errors.push('GitHub owner 未配置（GITHUB_OWNER）');
  if (!config.github.repo) errors.push('GitHub repo 未配置（GITHUB_REPO）');
  if (!config.github.pat) errors.push('GitHub PAT 未配置（GITHUB_PAT）');

  if (errors.length > 0) {
    logger.warn('Config', `GitHub 配置缺失: ${errors.join(', ')}`);
    logger.warn('Config', '请检查环境变量（或创建 .env 文件）；也可以设置 ENABLE_SYNC=false 关闭同步');
  }

  return errors.length === 0;
}

function validateConfig() {
  const mysqlOk = validateMysqlConfig();
  const githubOk = config.app.enableSync ? validateGitHubConfig() : true;
  // best-effort visibility: where env was loaded from (useful for packaged exe)
  try {
    if (loadedEnvFrom) {
      logger.info('Config', `Loaded env from: ${loadedEnvFrom}`);
    } else {
      logger.info('Config', 'Loaded env from: process.env (no .env/env.local found)');
    }
  } catch { }
  return mysqlOk && githubOk;
}

module.exports = {
  config,
  validateConfig,
  validateMysqlConfig,
  validateGitHubConfig
};
