/**
 * GitHub 客户端
 * 封装 GitHub REST API 调用
 * PAT 从配置中读取，不硬编码
 */

const axios = require('axios');
const { config } = require('./config');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

// 确保 axios 有 CancelToken（旧版本兼容）
const CancelToken = axios.CancelToken || (axios.default && axios.default.CancelToken);

// GitHub API 基础 URL
const GITHUB_API_BASE = 'https://api.github.com';

// Default ignore list for Chromium profile/partition directories.
// These paths are large and typically not required for login persistence (cookies/local storage).
const DEFAULT_IGNORE_DIR_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'GrShaderCache',
  'ShaderCache',
  'blob_storage',
  'Crashpad',
  'Media Cache',
  'VideoDecodeStats'
].map(s => s.toLowerCase()));

function defaultShouldIgnorePath(filePath) {
  const p = normalizePath(filePath);
  const segments = p.split('/').filter(Boolean).map(s => s.toLowerCase());
  
  // 忽略缓存目录
  if (segments.some(seg => DEFAULT_IGNORE_DIR_NAMES.has(seg))) {
    return true;
  }
  
  // 忽略 LevelDB 锁定文件（这些文件不应该被同步，会在浏览器启动时自动创建）
  const fileName = segments[segments.length - 1];
  if (fileName === 'lock') {
    // LOCK 文件总是忽略（无论在哪里）
    return true;
  }
  
  // 允许 LevelDB 的其他文件（CURRENT, MANIFEST, .log, .ldb 等）
  // 这些是数据库文件，应该被同步
  
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function createLimiter(concurrency = 6) {
  const max = Math.max(1, Number(concurrency) || 1);
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    Promise.resolve()
      .then(next.fn)
      .then(next.resolve, next.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

const _pathLocks = new Map();
async function withPathLock(key, fn) {
  const lockKey = String(key || '');
  const prev = _pathLocks.get(lockKey) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(async () => await fn());
  // store tail so the next caller will wait for *this* run to complete
  _pathLocks.set(lockKey, run);
  try {
    return await run;
  } finally {
    // cleanup only if no newer waiter replaced it
    if (_pathLocks.get(lockKey) === run) {
      _pathLocks.delete(lockKey);
    }
  }
}

function isShaConflictStatus(status) {
  return status === 409 || status === 422;
}

async function putFileWithShaRefresh(normalizedPath, url, data, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await axios.put(url, data, {
        headers: createHeaders(),
        timeout: 30000
      });
      return response.data;
    } catch (error) {
      lastErr = error;
      const status = error.response?.status;
      const apiMsg = error.response?.data?.message;
      const docUrl = error.response?.data?.documentation_url;
      // 重试过程日志会非常刷屏（尤其是 LevelDB/CacheStorage 文件），这里不输出。
      if (!isShaConflictStatus(status) || i >= attempts - 1) throw error;

      // 409/422: sha 过期/缺失（并发上传最常见）。
      // 优先从 GitHub 的 message 里直接提取当前 sha（减少额外请求与竞态窗口）：
      // "is at <currentSha> but expected <sentSha>"
      let refreshedSha = null;
      if (typeof apiMsg === 'string') {
        const m = apiMsg.match(/is at ([0-9a-f]{40}) but expected ([0-9a-f]{40})/i);
        if (m && m[1]) refreshedSha = m[1];
      }

      if (refreshedSha) {
        data.sha = refreshedSha;
      } else {
        // 回退：再查一次远端 sha
        const existsInfo = await fileExists(normalizedPath).catch(() => ({ exists: false }));
        if (existsInfo?.sha) {
          data.sha = existsInfo.sha;
        } else {
          delete data.sha;
        }
      }

      const jitter = Math.floor(Math.random() * 200);
      await sleep(350 * (i + 1) + jitter);
    }
  }
  throw lastErr;
}

async function withRetries(fn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      const code = err?.code;
      const retryable =
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNABORTED' ||
        msg.includes('stream has been aborted') ||
        msg.includes('socket hang up') ||
        msg.includes('Client network socket disconnected');
      if (!retryable || attempt >= retries) throw err;
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      logger.debug('GitHub', `Retry ${code || ''} ${msg.substring(0, 120)}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * 规范化 GitHub 路径（将反斜杠替换为正斜杠）
 * @param {string} filePath - 文件路径
 * @returns {string} 规范化后的路径
 */
function normalizePath(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

// GitHub contents API returns git blob SHA (sha1 over: "blob <len>\\0" + content)
function computeGitBlobSha(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

/**
 * 创建 GitHub API 请求头
 */
function createHeaders() {
  if (!config.github.pat) {
    throw new Error('GitHub PAT 未配置，请设置 GITHUB_PAT 环境变量');
  }

  return {
    'Authorization': `token ${config.github.pat}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'CS-AI-CRM-Sync'
  };
}

/**
 * 获取文件内容
 * @param {string} filePath - GitHub 仓库中的文件路径
 * @returns {Promise<string|null>} 文件内容或 null（文件不存在）
 */
async function getFile(filePath) {
  const normalizedPath = normalizePath(filePath);
  try {
    const url = `${GITHUB_API_BASE}/repos/${config.github.owner}/${config.github.repo}/contents/${normalizedPath}`;
    const response = await axios.get(url, {
      headers: createHeaders(),
      params: {
        ref: config.github.branch
      },
      timeout: 10000 // 10秒超时
    });

    if (response.data.content) {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null; // 文件不存在
    }
    logger.error('GitHub', `Failed to get file (text) ${normalizedPath}`, error);
    if (error.code === 'ECONNABORTED') {
      throw new Error(`Request timeout: ${normalizedPath}`);
    }
    throw error;
  }
}

/**
 * Download raw bytes from GitHub contents API (vnd.github.v3.raw).
 * This is required for binary files (SQLite, LevelDB, etc.).
 * @param {string} filePath
 * @returns {Promise<Buffer|null>}
 */
async function getFileRaw(filePath) {
  const normalizedPath = normalizePath(filePath);
  const url = `${GITHUB_API_BASE}/repos/${config.github.owner}/${config.github.repo}/contents/${normalizedPath}`;

  return await withRetries(async () => {
    try {
      const response = await axios.get(url, {
        headers: {
          ...createHeaders(),
          Accept: 'application/vnd.github.v3.raw'
        },
        params: { ref: config.github.branch },
        responseType: 'arraybuffer',
        timeout: 30000
      });
      logger.debug('GitHub', `getFileRaw: ${normalizedPath} (${response.data?.byteLength ?? 0} bytes)`);
      return Buffer.from(response.data);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return null;
      }
      logger.error('GitHub', `getFileRaw failed: ${normalizedPath}`, error);
      throw error;
    }
  }, { retries: 2, baseDelayMs: 750 });
}

/**
 * 上传文件（支持 Buffer 和字符串）
 * @param {string} filePath - GitHub 仓库中的文件路径
 * @param {string|Buffer} content - 文件内容
 * @param {string} message - 提交消息
 * @param {string} sha - 文件 SHA（更新时必需）
 * @returns {Promise<Object>} GitHub API 响应
 */
async function putFile(filePath, content, message, sha = null) {
  const normalizedPath = normalizePath(filePath);
  const url = `${GITHUB_API_BASE}/repos/${config.github.owner}/${config.github.repo}/contents/${normalizedPath}`;
  
  // 支持 Buffer 和字符串
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8');
  const contentBase64 = buf.toString('base64');
  
  const data = {
    message: message || `Update ${normalizedPath}`,
    content: contentBase64,
    branch: config.github.branch
  };

  if (sha) {
    data.sha = sha;
  }

  try {
    return await withPathLock(normalizedPath, async () => {
      logger.debug('GitHub', `putFile: ${normalizedPath} (${buf.length} bytes, hasSha: ${!!data.sha})`);
      const result = await putFileWithShaRefresh(normalizedPath, url, data, 6);
      logger.debug('GitHub', `putFile success: ${normalizedPath}`);
      return result;
    });
  } catch (error) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const apiMsg = error.response?.data?.message;
    const docUrl = error.response?.data?.documentation_url;
    
    logger.error('GitHub', `putFile failed: ${normalizedPath}`, error);
    
    if (error.response) {
      logger.error('GitHub', `HTTP Status: ${status} ${statusText}`);
      if (apiMsg) logger.error('GitHub', `HTTP Message: ${apiMsg}`);
      if (docUrl) logger.error('GitHub', `HTTP Doc: ${docUrl}`);
    }
    
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new Error(`Request timeout: ${normalizedPath}`);
    }
    
    throw error;
  }
}

/**
 * 检查文件是否存在
 * @param {string} filePath - GitHub 仓库中的文件路径
 * @returns {Promise<{exists: boolean, sha?: string, size?: number}>} 文件存在性、SHA 和大小（字节）
 */
async function fileExists(filePath) {
  const normalizedPath = normalizePath(filePath);
  
  try {
    const url = `${GITHUB_API_BASE}/repos/${config.github.owner}/${config.github.repo}/contents/${normalizedPath}`;
    logger.debug('GitHub', `fileExists: checking ${normalizedPath}`);
    
    // 使用 axios 的 cancel token 来确保可以取消请求
    let source = null;
    let timeoutId = null;
    
    if (CancelToken) {
      source = CancelToken.source();
      timeoutId = setTimeout(() => {
        if (source) {
          source.cancel('Request timeout');
        }
      }, 25000); // 25秒超时
    }
    
    try {
      const requestConfig = {
        headers: createHeaders(),
        params: {
          ref: config.github.branch
        },
        timeout: 25000 // 25秒超时
      };
      
      if (source && source.token) {
        requestConfig.cancelToken = source.token;
      }
      
      const response = await axios.get(url, requestConfig);
      
      clearTimeout(timeoutId);
      
      if (response.data && response.data.sha) {
        logger.debug('GitHub', `fileExists: ${normalizedPath} exists (sha: ${response.data.sha.substring(0, 8)}...)`);
        return {
          exists: true,
          sha: response.data.sha,
          size: typeof response.data.size === 'number' ? response.data.size : undefined,
        };
      }
      logger.debug('GitHub', `fileExists: ${normalizedPath} exists but no sha`);
      return {
        exists: true,
        size: typeof response.data?.size === 'number' ? response.data.size : undefined,
      };
    } catch (axiosError) {
      if (timeoutId) clearTimeout(timeoutId);
      throw axiosError;
    }
  } catch (error) {
    const isCancel = axios.isCancel || (axios.default && axios.default.isCancel);
    if (isCancel && isCancel(error)) {
      throw new Error(`Request timeout: ${normalizedPath}`);
    }
    
    if (error.response) {
      const status = error.response.status;
      
      if (status === 404) {
        logger.debug('GitHub', `fileExists: ${normalizedPath} does not exist (404)`);
        return { exists: false };
      }
      
      logger.error('GitHub', `fileExists failed: ${normalizedPath}`, error);
    } else {
      logger.error('GitHub', `fileExists failed: ${normalizedPath}`, error);
    }
    
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new Error(`Request timeout: ${normalizedPath}`);
    }
    
    throw error;
  }
}

/**
 * 列出目录内容
 * @param {string} dirPath - GitHub 仓库中的目录路径
 * @returns {Promise<Array>} 文件/目录列表
 */
async function listDirectory(dirPath) {
  const normalizedPath = normalizePath(dirPath);
  try {
    const url = `${GITHUB_API_BASE}/repos/${config.github.owner}/${config.github.repo}/contents/${normalizedPath}`;
    const response = await axios.get(url, {
      headers: createHeaders(),
      params: {
        ref: config.github.branch
      },
      timeout: 10000 // 10秒超时
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return []; // 目录不存在
    }
    logger.error('GitHub', `Failed to list directory ${normalizedPath}`, error);
    if (error.code === 'ECONNABORTED') {
      throw new Error(`Request timeout: ${normalizedPath}`);
    }
    throw error;
  }
}

/**
 * 递归下载目录
 * @param {string} remotePath - GitHub 仓库中的目录路径
 * @param {string} localPath - 本地保存路径
 * @param {object} [options]
 * @param {number} [options.maxFileSizeBytes] - skip files bigger than this (default 10MB)
 * @param {(path:string, item?:any)=>boolean} [options.shouldIgnorePath] - return true to skip
 * @param {boolean} [options.skipUnchanged] - 如果为 true，则通过大小比较跳过未变化的文件（默认 false）
 * @returns {Promise<void>}
 */
async function downloadDirectory(remotePath, localPath, options = {}) {
  try {
    const shouldIgnore = typeof options.shouldIgnorePath === 'function' ? options.shouldIgnorePath : defaultShouldIgnorePath;
    const maxFileSizeBytes = Number.isFinite(options.maxFileSizeBytes) ? options.maxFileSizeBytes : 10 * 1024 * 1024;
    const overwrite = options.overwrite === true;
    const skipUnchanged = options.skipUnchanged === true;
    const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 6;
    const limiter = createLimiter(concurrency);

    await fs.mkdir(localPath, { recursive: true });

    // 1) 递归收集远端文件列表（一次性列出），再并发下载
    const files = [];
    async function walk(remoteDir, localDir) {
      const items = await listDirectory(remoteDir);
      for (const item of items) {
        const itemRemotePath = item.path;
        const itemLocalPath = path.join(localDir, item.name);
        if (shouldIgnore(itemRemotePath, item)) continue;

        if (item.type === 'dir') {
          await fs.mkdir(itemLocalPath, { recursive: true }).catch(() => {});
          await walk(itemRemotePath, itemLocalPath);
        } else if (item.type === 'file') {
          if (typeof item.size === 'number' && item.size > maxFileSizeBytes) {
            logger.debug('GitHub', `downloadDirectory: Skipping large file (${item.size} bytes): ${itemRemotePath}`);
            continue;
          }
          files.push({ remotePath: itemRemotePath, localPath: itemLocalPath, size: item.size });
        }
      }
    }
    await walk(remotePath, localPath);
    logger.debug('GitHub', `downloadDirectory: ${remotePath} -> ${localPath} (${files.length} files, concurrency=${concurrency})`);

    // 2) 并发下载每个文件（单文件失败不影响整体目录下载）
    await Promise.all(files.map((f) => limiter(async () => {
      // skipUnchanged：通过 size 快速跳过（下载侧仍保持轻量，不读内容）
      if (skipUnchanged) {
        const localStat = await fs.stat(f.localPath).catch(() => null);
        if (localStat && typeof f.size === 'number' && f.size === localStat.size) {
          logger.debug('GitHub', `downloadDirectory: Skipping unchanged file (same size): ${f.remotePath}`);
          return;
        }
      }

      // 非 skipUnchanged 且 overwrite=false：不覆盖已存在文件
      if (!skipUnchanged && !overwrite) {
        const exists = await fs.stat(f.localPath).then(() => true).catch(() => false);
        if (exists) {
          logger.debug('GitHub', `downloadDirectory: Local file exists, skipping (overwrite=false): ${f.localPath}`);
          return;
        }
      }

      const buf = await getFileRaw(f.remotePath);
      if (buf === null) return;

      await fs.mkdir(path.dirname(f.localPath), { recursive: true });

      let writeSuccess = false;
      let lastError = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          await fs.writeFile(f.localPath, buf);
          const writtenStat = await fs.stat(f.localPath);
          if (writtenStat.size === buf.length) {
            writeSuccess = true;
            break;
          }
          logger.debug('GitHub', `downloadDirectory: File size mismatch after write, retrying... (attempt ${retry + 1}/3): ${f.localPath}`);
          await sleep(100 * (retry + 1));
        } catch (writeErr) {
          lastError = writeErr;
          if (writeErr.code === 'EACCES' || writeErr.code === 'EPERM' || writeErr.code === 'EBUSY') {
            logger.debug('GitHub', `downloadDirectory: File locked or permission error, retrying... (attempt ${retry + 1}/3): ${f.localPath}`);
            await sleep(200 * (retry + 1));
          } else {
            throw writeErr;
          }
        }
      }

      if (!writeSuccess) {
        logger.warn('GitHub', `downloadDirectory: Failed to write file after 3 attempts: ${f.localPath}, error: ${lastError?.message || 'unknown'}`);
      }
    })));
  } catch (error) {
    logger.error('GitHub', `Failed to download directory ${remotePath}`, error);
    throw error;
  }
}

async function buildRemoteFileMap(remotePath, options = {}) {
  const shouldIgnore = typeof options.shouldIgnorePath === 'function' ? options.shouldIgnorePath : defaultShouldIgnorePath;
  const map = new Map(); // full remote path -> { sha, size, type }

  async function walk(dir) {
    const items = await listDirectory(dir);
    for (const item of items) {
      const itemRemotePath = item.path;
      if (shouldIgnore(itemRemotePath, item)) continue;
      if (item.type === 'file') {
        map.set(itemRemotePath, { sha: item.sha, size: item.size, type: 'file' });
      } else if (item.type === 'dir') {
        await walk(itemRemotePath);
      }
    }
  }

  await walk(remotePath);
  return map;
}

async function collectLocalFiles(localPath, remoteBasePath, options = {}) {
  const shouldIgnore = typeof options.shouldIgnorePath === 'function' ? options.shouldIgnorePath : defaultShouldIgnorePath;
  const maxFileSizeBytes = Number.isFinite(options.maxFileSizeBytes) ? options.maxFileSizeBytes : 10 * 1024 * 1024;
  const files = []; // { localPath, remotePath, size }

  async function walk(localDir, remoteDir) {
    const entries = await fs.readdir(localDir, { withFileTypes: true });
    for (const ent of entries) {
      const itemLocalPath = path.join(localDir, ent.name);
      const itemRemotePath = `${remoteDir}/${ent.name}`.replace(/\\/g, '/');

      if (ent.isDirectory()) {
        if (shouldIgnore(itemRemotePath, ent)) continue;
        await walk(itemLocalPath, itemRemotePath);
      } else if (ent.isFile()) {
        if (shouldIgnore(itemRemotePath, ent)) continue;
        const stat = await fs.stat(itemLocalPath).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        if (stat.size > maxFileSizeBytes) {
          logger.debug('GitHub', `collectLocalFiles: Skipping large file (${stat.size} bytes): ${itemRemotePath}`);
          continue;
        }
        files.push({ localPath: itemLocalPath, remotePath: itemRemotePath, size: stat.size });
      }
    }
  }

  await walk(localPath, remoteBasePath);
  return files;
}

/**
 * 上传目录（递归上传所有文件）
 * @param {string} localPath - 本地目录路径
 * @param {string} remoteBasePath - GitHub 仓库中的基础路径
 * @param {string} message - 提交消息
 * @param {object} [options]
 * @param {number} [options.maxFileSizeBytes]
 * @param {(path:string, dirent?:import('fs').Dirent)=>boolean} [options.shouldIgnorePath]
 * @param {boolean} [options.skipUnchanged] - 如果为 true，则通过大小比较跳过未变化的文件（默认 false）
 * @returns {Promise<void>}
 */
async function uploadDirectory(localPath, remoteBasePath, message = 'Upload directory', options = {}) {
  try {
    const skipUnchanged = options.skipUnchanged === true;
    const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 6;
    const limiter = createLimiter(concurrency);
    const smallFileShaThresholdBytes = Number.isFinite(options.smallFileShaThresholdBytes)
      ? options.smallFileShaThresholdBytes
      : 256 * 1024;

    // 1) 一次性拉取远端目录树并缓存（避免“每个文件都 exists 一次”）
    const remoteMap = await buildRemoteFileMap(remoteBasePath, options).catch((e) => {
      logger.warn('GitHub', `uploadDirectory: Failed to build remote map, falling back to per-file exists: ${remoteBasePath}`, e);
      return null;
    });

    // 2) 收集所有待上传的本地文件
    const files = await collectLocalFiles(localPath, remoteBasePath, options);
    logger.debug('GitHub', `uploadDirectory: ${localPath} -> ${remoteBasePath} (${files.length} files, concurrency=${concurrency})`);

    // 3) 并发上传（带“更可靠的跳过未变更”策略）
    await Promise.all(files.map((f) => limiter(async () => {
      const remoteInfo = remoteMap ? remoteMap.get(f.remotePath) : await fileExists(f.remotePath).catch(() => ({ exists: false }));
      const remoteExists = !!remoteInfo?.sha;

      if (skipUnchanged && remoteExists) {
        // 小文件：用 git blob sha 精确比对（避免“同大小内容变化”漏同步）
        if (f.size <= smallFileShaThresholdBytes) {
          let contentForSha;
          try {
            contentForSha = await fs.readFile(f.localPath);
          } catch (readErr) {
            if (readErr.code === 'EBUSY' || readErr.code === 'EACCES' || readErr.code === 'EPERM') {
              logger.warn('GitHub', `uploadDirectory: File is locked or inaccessible, skipping: ${f.localPath} (${readErr.code})`);
              return;
            }
            throw readErr;
          }
          const localBlobSha = computeGitBlobSha(contentForSha);
          if (String(remoteInfo.sha).toLowerCase() === localBlobSha) {
            logger.debug('GitHub', `uploadDirectory: Skipping unchanged file (blob sha match): ${f.remotePath}`);
            return;
          }
          // sha 不一致：继续上传（复用已读取的 buffer）
          await putFile(
            f.remotePath,
            contentForSha,
            `${message}: ${path.basename(f.localPath)}`,
            remoteExists ? remoteInfo.sha : null
          );
          return;
        }

        // 大文件：退回 size（更省 IO；仍然可能有极小概率漏同步）
        if (typeof remoteInfo.size === 'number' && remoteInfo.size === f.size) {
          logger.debug('GitHub', `uploadDirectory: Skipping unchanged file (same size): ${f.remotePath}`);
          return;
        }
      }

      // 默认：读取并上传
      let content;
      try {
        content = await fs.readFile(f.localPath);
      } catch (readErr) {
        if (readErr.code === 'EBUSY' || readErr.code === 'EACCES' || readErr.code === 'EPERM') {
          logger.warn('GitHub', `uploadDirectory: File is locked or inaccessible, skipping: ${f.localPath} (${readErr.code})`);
          return;
        }
        throw readErr;
      }

      await putFile(
        f.remotePath,
        content,
        `${message}: ${path.basename(f.localPath)}`,
        remoteExists ? remoteInfo.sha : null
      );
    })));

    logger.debug('GitHub', `uploadDirectory: Completed: ${localPath} (${files.length} files)`);
  } catch (error) {
    logger.error('GitHub', `Failed to upload directory ${localPath}`, error);
    throw error;
  }
}

/**
 * 删除 GitHub 仓库中的文件
 * @param {string} filePath - GitHub 仓库中的文件路径
 * @param {string} message - 提交消息
 * @returns {Promise<void>}
 */
async function deleteFile(filePath, message = 'Delete file') {
  const normalizedPath = normalizePath(filePath);
  
  try {
    const existsInfo = await fileExists(normalizedPath);
    if (!existsInfo.exists || !existsInfo.sha) {
      logger.debug('GitHub', `deleteFile: File does not exist, skipping: ${normalizedPath}`);
      return;
    }

    const url = `${GITHUB_API_BASE}/repos/${config.github.owner}/${config.github.repo}/contents/${normalizedPath}`;
    logger.debug('GitHub', `deleteFile: Deleting file: ${normalizedPath}`);
    
    // GitHub Contents API: delete must be HTTP DELETE with a JSON body (message/sha/branch)
    const response = await axios.delete(url, {
      headers: createHeaders(),
      timeout: 30000,
      data: {
        message: message,
        sha: existsInfo.sha,
        branch: config.github.branch
      }
    });

    logger.debug('GitHub', `deleteFile: File deleted successfully: ${normalizedPath}`);
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    
    if (error.response && status === 404) {
      logger.debug('GitHub', `deleteFile: File does not exist (404), skipping: ${normalizedPath}`);
      return;
    }
    
    logger.error('GitHub', `deleteFile: Failed to delete file ${normalizedPath}`, error);
    throw error;
  }
}

/**
 * 递归删除 GitHub 仓库中的目录
 * @param {string} dirPath - GitHub 仓库中的目录路径
 * @param {string} message - 提交消息
 * @returns {Promise<void>}
 */
async function deleteDirectory(dirPath, message = 'Delete directory') {
  const normalizedPath = normalizePath(dirPath);
  
  try {
    logger.debug('GitHub', `deleteDirectory: Deleting directory: ${normalizedPath}`);
    
    const items = await listDirectory(normalizedPath);
    
    for (const item of items) {
      const itemPath = item.path;
      if (item.type === 'file') {
        try {
          await deleteFile(itemPath, `${message} - ${item.name}`);
        } catch (e) {
          logger.warn('GitHub', `deleteDirectory: Failed to delete file ${itemPath}`, e);
        }
      } else if (item.type === 'dir') {
        try {
          await deleteDirectory(itemPath, `${message} - ${item.name}`);
        } catch (e) {
          logger.warn('GitHub', `deleteDirectory: Failed to delete directory ${itemPath}`, e);
        }
      }
    }
    
    logger.debug('GitHub', `deleteDirectory: Directory deleted successfully: ${normalizedPath}`);
  } catch (error) {
    if (error.response?.status === 404) {
      logger.debug('GitHub', `deleteDirectory: Directory does not exist, skipping: ${normalizedPath}`);
      return;
    }
    
    logger.error('GitHub', `deleteDirectory: Failed to delete directory ${normalizedPath}`, error);
    throw error;
  }
}

/**
 * 计算文件或目录的校验和
 * @param {string} filePath - 文件或目录路径
 * @returns {Promise<string>} 校验和（SHA256）
 */
module.exports = {
  getFile,
  getFileRaw,
  putFile,
  fileExists,
  listDirectory,
  downloadDirectory,
  uploadDirectory,
  deleteFile,
  deleteDirectory,
};
