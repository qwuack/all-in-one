const { app, BrowserWindow, BrowserView, ipcMain, dialog, globalShortcut } = require('electron');
const Store = require('electron-store');
const messageChecker = require('./messageChecker');
const path = require('path');
const fs = require('fs').promises;
const { initDatabase } = require('./db');
const { config } = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const { saveResetToken, getUserByEmail } = require('./userModel');
const sendResetEmail = require('./mailer');
// const { spawn } = require("child_process");
// const simpleGit = require("simple-git");
// const git = simpleGit({ baseDir: path.resolve(__dirname) });

process.on('uncaughtException', (error) => {
  logger.fatal('Main', 'Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal('Main', 'Unhandled rejection', reason);
});
const {
  getFile: ghGetFile,
  fileExists: ghFileExists,
  putFile: ghPutFile,
  listDirectory: ghListDirectory,
  downloadDirectory: ghDownloadDirectory,
  uploadDirectory: ghUploadDirectory,
  deleteDirectory: ghDeleteDirectory,
} = require('./githubClient');
const { findUserByUsername, createUser, verifyPassword, hashToken } = require('./repositories/userRepository');
const {
  getAccountsByUserId,
  accountExists,
  createAccount,
  deleteAccount: dbDeleteAccount,
  renameAccount: dbRenameAccount,
  updateAccountStatus: dbUpdateAccountStatus
} = require('./repositories/accountRepository');

// 初始化数据存储
const store = new Store();

// 全局变量
let mainWindow;
let browserViews = new Map();
let currentView = null;
let instagramMaskView = null;
let instagramMaskTimeout = null;
let legalDialogWaiters = new Map();
// 記錄每個 Instagram 帳戶是否已經顯示過「首次載入」遮罩
const instagramInitialMaskShown = new Set();
// 當前登入使用者（後續帳戶資料會與 userId 綁定）
let currentUser = null;
// 目前登入使用者的帳戶快取（避免頻繁查 DB）
let accountsCache = [];
// 控制 before-quit 僅執行一次，避免循環退出
let isQuitting = false;
let syncInProgress = false;
let accountsChangedDuringSession = false;
let syncDownInProgress = false;
const syncingDownPartitions = new Set();
let pendingSwitchPartition = null;
let tunnel;

function getSyncManifestPathForUser(userId) {
  try {
    const base = app.getPath('userData');
    return path.join(base, `sync-manifest-user-${userId}.json`);
  } catch {
    return null;
  }
}

function shouldIgnoreLocalSyncPath(absPath) {
  const p = String(absPath).replace(/\\/g, '/').toLowerCase();
  const segments = p.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] || '';
  const ignoreDirs = new Set([
    'cache',
    'code cache',
    'gpucache',
    'dawncache',
    'grshadercache',
    'shadercache',
    'blob_storage',
    'crashpad',
    'media cache',
    'videodecodestats'
  ]);
  if (segments.some(s => ignoreDirs.has(s))) return true;
  if (fileName === 'lock') return true;
  return false;
}

async function computeLocalSyncManifestForCurrentUser() {
  if (!currentUser?.id) return null;
  const { configPath, partitionsPath } = getUserDataPaths();
  const entries = {};

  async function walkDir(baseDir, prefix) {
    const items = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
    for (const ent of items) {
      const abs = path.join(baseDir, ent.name);
      if (shouldIgnoreLocalSyncPath(abs)) continue;

      const rel = `${prefix}/${ent.name}`.replace(/\\/g, '/');
      if (ent.isDirectory()) {
        await walkDir(abs, rel);
      } else if (ent.isFile()) {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) continue;
        entries[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs || 0) };
      }
    }
  }

  // Partitions/*
  await walkDir(partitionsPath, 'Partitions');

  // config.json（本地会被写入/更新，纳入变更检测）
  const configStat = await fs.stat(configPath).catch(() => null);
  if (configStat?.isFile()) {
    entries['config.json'] = { size: configStat.size, mtimeMs: Math.floor(configStat.mtimeMs || 0) };
  }

  // stable stringify
  const sortedKeys = Object.keys(entries).sort();
  const sortedEntries = {};
  for (const k of sortedKeys) sortedEntries[k] = entries[k];

  return {
    version: 1,
    userId: currentUser.id,
    generatedAt: new Date().toISOString(),
    entries: sortedEntries
  };
}

async function getSyncChangeSetForCurrentUser() {
  const manifestPath = getSyncManifestPathForUser(currentUser?.id);
  const next = await computeLocalSyncManifestForCurrentUser();
  if (!manifestPath || !next) return { hasChanges: false, changedPartitions: new Set(), configChanged: false };

  const prev = await fs.readFile(manifestPath, 'utf-8').then(JSON.parse).catch(() => null);
  if (!prev?.entries) {
    // 首次运行：认为需要同步（但仍走增量上传）
    const all = new Set();
    for (const key of Object.keys(next.entries)) {
      const m = key.match(/^Partitions\/([^/]+)\//);
      if (m) all.add(m[1]);
    }
    const configChanged = !!next.entries['config.json'];
    return { hasChanges: true, changedPartitions: all, configChanged };
  }

  const changedPartitions = new Set();
  let hasChanges = false;
  let configChanged = false;

  const allKeys = new Set([...Object.keys(prev.entries), ...Object.keys(next.entries)]);
  for (const key of allKeys) {
    const a = prev.entries[key];
    const b = next.entries[key];
    const same = !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
    if (!same) {
      hasChanges = true;
      if (key === 'config.json') configChanged = true;
      const m = key.match(/^Partitions\/([^/]+)\//);
      if (m) changedPartitions.add(m[1]);
    }
  }

  return { hasChanges, changedPartitions, configChanged, nextManifest: next, manifestPath };
}

async function persistSyncManifestForCurrentUser(nextManifest, manifestPath) {
  if (!nextManifest || !manifestPath) return;
  try {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf-8');
  } catch (e) {
    logger.warn('Sync', `Failed to persist sync manifest: ${e?.message || 'unknown'}`);
  }
}

function markAccountsChanged(reason) {
  accountsChangedDuringSession = true;
  logger.debug('Sync', `Accounts changed: ${reason || 'unknown'}`);
}

// 常量配置
const CHROME_USER_AGENT = process.platform === 'darwin'
  ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SIDEBAR_WIDTH = 280;
const HEADER_HEIGHT = 72;
const ADJUST_BOUNDS_DELAY = 100;
// Instagram 遮罩顯示時長（用來覆蓋 Instagram 內部導航欄在載入/縮放時的閃現）
// 稍微拉長一點時間，確保在版面完全穩定前都由遮罩擋住
const INSTAGRAM_MASK_DURATION_MS = 5000;

// 缩放配置
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 1;
const STORE_ZOOM_VIEW = 'embeddedZoomFactor';
const STORE_ZOOM_PAGE = 'pageZoomFactor';

// 平台 URL 映射
const PLATFORM_URLS = {
  instagram: 'https://www.instagram.com/direct/inbox/',
  messenger: 'https://www.messenger.com/',
  whatsapp: 'https://web.whatsapp.com',
  wechat: 'https://work.weixin.qq.com/wework_admin/loginpage_wx?from=myhome',
  telegram: 'https://web.telegram.org/'
};

// Instagram 内嵌页侧栏隐藏样式（兼容旧版 + 通用导航选择器）
const INSTAGRAM_SIDEBAR_HIDE_CSS = `
  /* 旧版 class（历史代码保留，防回滚） */
  div[class="xvbhtw8 x1cy8zhl x9f619 x78zum5 xdt5ytf x1gvbg2u x1qughib"],
  div[class="x1c4vz4f x2lah0s xhjk10j"],
  /* 通用导航：所有主导航 nav/aside 统统隐藏 */
  nav[role="navigation"],
  nav[aria-label],
  aside[role="navigation"],
  aside nav {
    display: none !important;
  }
`;

/**
 * 对 Instagram 的 webContents 注入侧栏隐藏逻辑
 * 1. 先插入兼容旧版的 CSS
 * 2. 再通过 executeJavaScript 基于 aria/role 等较稳定属性查找并隐藏左侧导航栏
 */
function injectInstagramSidebarHide(webContents) {
  if (!webContents || webContents.isDestroyed()) return;

  // 兼容旧版 class 的纯 CSS 隐藏
  webContents.insertCSS(INSTAGRAM_SIDEBAR_HIDE_CSS).catch?.(() => { });

  // 通过脚本持续查找并隐藏左侧窄导航栏（Instagram 会动态重渲染，需观察 DOM 变化）
  const hideScript = `
    (() => {
      try {
        if (window.__csaiHideInstagramNavInstalled) return;
        window.__csaiHideInstagramNavInstalled = true;
        // 不再在 Instagram 頁面上顯示「載入中」遮罩，只做導航欄隱藏

        const collapse = (el) => {
          if (!el) return false;
          // 强制隐藏 + 尽量让布局不再预留左侧宽度
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('width', '0px', 'important');
          el.style.setProperty('min-width', '0px', 'important');
          el.style.setProperty('flex', '0 0 0px', 'important');
          el.style.setProperty('overflow', 'hidden', 'important');

          // 尝试调整父级 grid/flex，避免留下空白列
          let p = el.parentElement;
          for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.display === 'grid') {
              const gtc = s.gridTemplateColumns || '';
              const parts = gtc.split(' ').filter(Boolean);
              if (parts.length >= 2) {
                p.style.setProperty('grid-template-columns', '0px ' + parts.slice(1).join(' '), 'important');
              }
            }
            if (s.display === 'flex') {
              // 对 flex：让第一个子项不占空间
              p.style.setProperty('gap', '0px', 'important');
            }
          }
          return true;
        };

        const isLeftNarrowBar = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 35 || rect.width > 140) return false;
          if (rect.height < window.innerHeight * 0.5) return false;
          if (rect.left > 80) return false;
          return true;
        };

        // 重置縮放後會出現「較寬的左側圖標欄」：不一定是 nav/aside，也可能是 div。
        // 這裡用更穩健的幾何 + 內容特徵抓它，但要避免誤傷消息列表（消息列表通常有搜尋框/列表結構）。
        const pickWideIconRail = () => {
          const nodes = document.querySelectorAll('nav, aside, section, div');
          let best = null;
          let bestScore = 0;
          for (const el of nodes) {
            if (!el || !el.getBoundingClientRect) continue;
            const rect = el.getBoundingClientRect();
            if (!rect || rect.width < 40 || rect.width > 320) continue;
            if (rect.height < window.innerHeight * 0.6) continue;
            if (rect.left > 180) continue; // 必須貼近左側

            // 排除消息列表：通常包含搜尋 input 或 listbox/grid/main
            if (el.querySelector('input[type="search"], input[placeholder*="搜索"], input[placeholder*="搜尋"]')) continue;
            if (el.querySelector('[role="listbox"],[role="grid"],[role="main"]')) continue;

            const svgCount = el.querySelectorAll('svg').length;
            const actionCount = el.querySelectorAll('a,button,[role="button"]').length;
            if (svgCount < 5 || actionCount < 5) continue;

            const score = (svgCount * 4) + actionCount + Math.min(60, rect.height / 18) - Math.min(50, rect.width / 6);
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          return best;
        };

        const pickByLinkSignature = () => {
          const links = [
            'a[href="/"]',
            'a[href="/direct/inbox/"]',
            'a[href="/direct/inbox"]',
            'a[href="/explore/"]',
            'a[href="/reels/"]'
          ];
          for (const sel of links) {
            const a = document.querySelector(sel);
            if (!a) continue;
            const container = a.closest('nav, aside, section, div');
            if (container && isLeftNarrowBar(container)) return container;
            // 再往上找一层更像侧栏的
            let p = a.parentElement;
            for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
              if (isLeftNarrowBar(p)) return p;
            }
          }
          return null;
        };

        const pickByHeuristic = () => {
          // 限定在可能的容器标签，避免全量遍历过重
          const nodes = document.querySelectorAll('nav, aside, section, div');
          let best = null;
          let bestScore = 0;
          for (const el of nodes) {
            if (!isLeftNarrowBar(el)) continue;
            const svgCount = el.querySelectorAll('svg').length;
            const actionCount = el.querySelectorAll('a,button,[role="button"]').length;
            if (svgCount < 4 && actionCount < 4) continue;
            const rect = el.getBoundingClientRect();
            const score = (svgCount * 3) + actionCount + Math.min(50, rect.height / 20);
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          return best;
        };

        const isBottomNavBar = (el) => {
          const rect = el.getBoundingClientRect();
          // 底部横栏：宽、矮、贴近底部
          if (rect.width < window.innerWidth * 0.6) return false;
          if (rect.height < 35 || rect.height > 140) return false;
          if (rect.bottom < window.innerHeight - 2) return false;
          if (rect.top < window.innerHeight - 220) return false;
          return true;
        };

        const pickBottomBar = () => {
          // 优先按“Direct/Home 等链接特征”命中底栏容器
          const sigLinks = [
            'a[href="/"]',
            'a[href="/direct/inbox/"]',
            'a[href="/direct/inbox"]',
            'a[href="/explore/"]',
            'a[href="/reels/"]'
          ];
          for (const sel of sigLinks) {
            const a = document.querySelector(sel);
            if (!a) continue;
            let p = a.parentElement;
            for (let i = 0; i < 10 && p; i++, p = p.parentElement) {
              if (!p || !p.getBoundingClientRect) continue;
              if (!isBottomNavBar(p)) continue;
              const svgCount = p.querySelectorAll('svg').length;
              const actionCount = p.querySelectorAll('a,button,[role="button"]').length;
              if (svgCount >= 3 || actionCount >= 4) return p;
            }
          }

          // 再用启发式扫一遍（只扫可能性高的标签，避免过重）
          const nodes = document.querySelectorAll('nav, footer, div, section');
          let best = null;
          let bestScore = 0;
          for (const el of nodes) {
            if (!isBottomNavBar(el)) continue;
            const svgCount = el.querySelectorAll('svg').length;
            const actionCount = el.querySelectorAll('a,button,[role="button"]').length;
            if (svgCount < 3 && actionCount < 4) continue;
            const rect = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            const fixedBonus = (s.position === 'fixed' || s.position === 'sticky') ? 30 : 0;
            const score = fixedBonus + (svgCount * 4) + actionCount + Math.min(20, rect.width / 100);
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          return best;
        };

        const hideOnce = () => {
          // 1) 桌面布局：左侧竖导航
          const left = pickByLinkSignature() || pickByHeuristic();
          if (left) collapse(left);

          // 1.5) 缩放重置后可能出现的“较宽图标栏”
          const wideRail = pickWideIconRail();
          if (wideRail) collapse(wideRail);

          // 2) 缩放触发的“移动端”布局：底部横导航
          const bottom = pickBottomBar();
          if (bottom) collapse(bottom);

          // 尝试去掉为底栏预留的 padding（不保证命中，但基本无副作用）
          const body = document.body;
          if (body) {
            const pb = getComputedStyle(body).paddingBottom;
            if (pb && pb !== '0px') {
              body.style.setProperty('padding-bottom', '0px', 'important');
            }
          }
        };

        hideOnce();

        // DOM 有变化就再隐藏（Instagram SPA 会反复重绘）
        const obs = new MutationObserver(() => hideOnce());
        obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });

        // 再加一个短周期兜底（前几秒最容易重绘）
        let ticks = 0;
        const timer = setInterval(() => {
          ticks++;
          hideOnce();
          if (ticks >= 20) clearInterval(timer);
        }, 500);
      } catch (e) {}
    })();
  `;

  webContents.executeJavaScript(hideScript, false).catch(() => { });
}

function getImmediateFallbackBoundsSync() {
  if (!mainWindow) return null;
  try {
    const [width, height] = mainWindow.getSize();
    return {
      x: SIDEBAR_WIDTH,
      y: HEADER_HEIGHT,
      width: Math.max(width - SIDEBAR_WIDTH, 0),
      height: Math.max(height - HEADER_HEIGHT, 0)
    };
  } catch {
    return null;
  }
}

function ensureInstagramMaskView() {
  if (instagramMaskView && !instagramMaskView.webContents?.isDestroyed?.()) {
    return instagramMaskView;
  }

  instagramMaskView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    }
  });

  try {
    instagramMaskView.setBackgroundColor('#ffffff');
  } catch { }

  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        html,body{width:100%;height:100%;margin:0;}
        body{background:#fff;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"Noto Sans","PingFang SC","Microsoft YaHei",sans-serif;}
        .wrap{display:flex;flex-direction:column;align-items:center;gap:12px;}
        .spinner{width:46px;height:46px;border-radius:999px;border:4px solid #e8e8e8;border-top-color:#00a884;animation:spin .8s linear infinite;}
        .tip{font-size:14px;color:#666;}
        @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="spinner"></div>
        <div class="tip">加载中…</div>
      </div>
    </body>
  </html>`;
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  instagramMaskView.webContents.loadURL(dataUrl).catch(() => { });

  return instagramMaskView;
}

function isMaskAttached() {
  if (!mainWindow || !instagramMaskView) return false;
  try {
    return mainWindow.getBrowserViews().includes(instagramMaskView);
  } catch {
    return false;
  }
}

function setMaskOnTop() {
  if (!mainWindow || !instagramMaskView) return;
  try {
    // Electron 支持将某个 BrowserView 置顶，确保遮罩盖住 Instagram BrowserView
    if (typeof mainWindow.setTopBrowserView === 'function') {
      mainWindow.setTopBrowserView(instagramMaskView);
    }
  } catch { }
}

async function adjustInstagramMaskBounds() {
  if (!mainWindow || !instagramMaskView || instagramMaskView.webContents.isDestroyed()) return;

  // 先同步设置一个“立即可用”的 fallback bounds，避免等待 DOM 查询导致露底
  const immediate = getImmediateFallbackBoundsSync();
  if (immediate) {
    try {
      instagramMaskView.setBounds(immediate);
    } catch { }
  }

  // 再尝试用更精确的 content bounds（跟 BrowserView 的边界一致）
  try {
    const bounds = await getContentBounds();
    if (bounds) {
      const zoomFactor = mainWindow.webContents.getZoomFactor();
      const adjustedBounds = {
        x: Math.floor(bounds.x * zoomFactor),
        y: Math.floor(bounds.y * zoomFactor),
        width: Math.floor(bounds.width * zoomFactor),
        height: Math.floor(bounds.height * zoomFactor)
      };
      instagramMaskView.setBounds(adjustedBounds);
    }
  } catch { }
}

function showInstagramMask(durationMs = INSTAGRAM_MASK_DURATION_MS) {
  if (!mainWindow) return;

  ensureInstagramMaskView();

  // 清理旧计时器
  if (instagramMaskTimeout) {
    clearTimeout(instagramMaskTimeout);
    instagramMaskTimeout = null;
  }

  // 先把遮罩加到窗口上并置顶（即使当前还是别的平台，也先盖住，避免切换瞬间露出导航）
  try {
    if (!isMaskAttached()) {
      mainWindow.addBrowserView(instagramMaskView);
    }
  } catch { }

  setMaskOnTop();
  adjustInstagramMaskBounds();

  instagramMaskTimeout = setTimeout(() => {
    hideInstagramMask();
  }, Math.max(0, durationMs));
}

function hideInstagramMask() {
  if (instagramMaskTimeout) {
    clearTimeout(instagramMaskTimeout);
    instagramMaskTimeout = null;
  }
  if (!mainWindow || !instagramMaskView) return;
  try {
    if (isMaskAttached()) {
      mainWindow.removeBrowserView(instagramMaskView);
    }
  } catch { }
}

/**
 * 工具函数：安全发送消息到渲染进程
 */
function sendToRenderer(channel, ...args) {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function canSyncSessions() {
  if (!config.app.enableSync) {
    logger.debug('Sync', 'Session sync disabled: ENABLE_SYNC is false');
    return false;
  }
  if (!currentUser) {
    logger.debug('Sync', 'Session sync skipped: no currentUser');
    return false;
  }
  const gh = config.github;
  const ok = !!(gh && gh.owner && gh.repo && gh.branch && gh.basePath && gh.pat);
  if (!ok) {
    logger.warn('Sync', 'Session sync disabled: GitHub config incomplete', {
      owner: gh?.owner,
      repo: gh?.repo,
      branch: gh?.branch,
      basePath: gh?.basePath,
      hasPat: !!gh?.pat,
    });
  }
  return ok;
}

function getUserDataPaths() {
  const userData = app.getPath('userData');
  return {
    userData,
    configPath: path.join(userData, 'config.json'),
    partitionsPath: path.join(userData, 'Partitions'),
  };
}

function getUserRemoteBasePath() {
  if (!currentUser) return null;
  const base = config.github.basePath || 'users';
  return `${base}/${currentUser.id}`;
}

/**
 * 從 GitHub 下行同步瀏覽器會話資料
 */
async function syncSessionsDownForCurrentUser() {
  try {
    if (!canSyncSessions()) return;

    const remoteBase = getUserRemoteBasePath();
    if (!remoteBase) return;

    const { configPath, partitionsPath } = getUserDataPaths();
    sendToRenderer('sync-status', { direction: 'down', state: 'syncing', message: '正在同步会话数据…' });

    let localConfig = {};
    try {
      const localConfigContent = await fs.readFile(configPath, 'utf-8').catch(() => null);
      if (localConfigContent) {
        localConfig = JSON.parse(localConfigContent);
        logger.debug('SyncDown', `Loaded local config.json with ${Object.keys(localConfig).length} accounts`);
      }
    } catch (e) {
      logger.debug('SyncDown', 'Local config.json not found or invalid, will download all');
    }

    const dbAccounts = await getAccountsByUserId(currentUser.id);
    const dbPartitions = new Set(dbAccounts.map(acc => acc.partition));
    logger.debug('SyncDown', `Database has ${dbPartitions.size} accounts`);

    const localPartitions = new Set(Object.keys(localConfig));
    const newPartitions = [...dbPartitions].filter(p => !localPartitions.has(p));

    if (newPartitions.length === 0) {
      logger.info('SyncDown', 'No new accounts, skipping download');
      sendToRenderer('sync-status', { direction: 'down', state: 'done', message: '会话已是最新，无需同步' });
      return;
    }

    logger.info('SyncDown', `Found ${newPartitions.length} new accounts to download: ${newPartitions.join(', ')}`);
    sendToRenderer('sync-status', { direction: 'down', state: 'syncing', message: `发现 ${newPartitions.length} 个账号需要同步…`, progress: { current: 0, total: newPartitions.length } });
    // 提前把“待同步”状态发给 UI：这些账号在同步完成前应不可点击
    for (const partition of newPartitions) {
      sendToRenderer('sync-status', {
        direction: 'down',
        state: 'queued',
        partition,
        message: `待同步：${partition}`,
        progress: { current: 0, total: newPartitions.length }
      });
    }

    // 4. 下载全局 config.json（如果存在）
    try {
      const remoteConfigPath = `${remoteBase}/config.json`;
      const remoteConfigContent = await ghGetFile(remoteConfigPath).catch(() => null);
      if (remoteConfigContent) {
        const remoteConfig = JSON.parse(remoteConfigContent);
        // 合并远程配置到本地配置（保留本地已有的账号配置）
        for (const [partition, accountConfig] of Object.entries(remoteConfig)) {
          if (newPartitions.includes(partition)) {
            localConfig[partition] = accountConfig;
          }
        }
        logger.debug('SyncDown', 'Downloaded global config.json from GitHub');
      }
    } catch (e) {
      logger.debug('SyncDown', 'No global config.json found on GitHub, using database info');
    }

    // 5. 对每个新增账号，从 Partitions 目录下载

    for (const partition of newPartitions) {
      try {
        syncingDownPartitions.add(partition);
        sendToRenderer('sync-status', {
          direction: 'down',
          state: 'syncing',
          message: `正在同步账号：${partition}`,
          progress: { current: newPartitions.indexOf(partition) + 1, total: newPartitions.length },
          partition
        });
        const remotePartitionPath = `${remoteBase}/Partitions/${partition}`;
        const localPartitionPath = path.join(partitionsPath, partition);

        logger.info('SyncDown', `Downloading account: ${partition}`);
        logger.debug('SyncDown', `Remote: ${remotePartitionPath}, Local: ${localPartitionPath}`);

        // 如果远程没有配置，使用数据库信息
        if (!localConfig[partition]) {
          const account = dbAccounts.find(acc => acc.partition === partition);
          if (account) {
            localConfig[partition] = {
              name: account.name,
              platform: account.platform,
              phoneNumber: account.phoneNumber,
              status: account.status || 'running',
              createdAt: account.createdAt || new Date().toISOString()
            };
          }
        }

        // 下载账号的完整 partition 内容
        // GitHub: users/{userId}/Partitions/ (整个文件夹)
        // 本地: C:\Users\Administrator\AppData\Roaming\crm-multi-account\Partitions\ (整个文件夹)
        // 会将 GitHub 上的 partition 文件夹完整下载到本地 Partitions 目录下
        try {
          await fs.mkdir(localPartitionPath, { recursive: true });

          await ghDownloadDirectory(remotePartitionPath, localPartitionPath, {
            overwrite: true,
            skipUnchanged: true,
            maxFileSizeBytes: 10 * 1024 * 1024
          });

          try {
            const stat = await fs.stat(localPartitionPath);
            if (stat.isDirectory()) {
              const files = await fs.readdir(localPartitionPath);
              logger.info('SyncDown', `Successfully downloaded partition for ${partition} (${files.length} items)`);
            }
          } catch (verifyErr) {
            logger.warn('SyncDown', `Could not verify download for ${partition}: ${verifyErr.message}`);
          }

          // 单个账号同步完成：通知 UI 解除“待同步/同步中”的禁用态
          sendToRenderer('sync-status', {
            direction: 'down',
            state: 'done',
            partition,
            message: `同步完成：${partition}`,
            progress: { current: newPartitions.indexOf(partition) + 1, total: newPartitions.length }
          });
        } catch (e) {
          if (e.response?.status === 404 || e.message?.includes('404') || e.message?.includes('not found')) {
            logger.debug('SyncDown', `No partition found for ${partition} on GitHub (account may not have logged in yet)`);
            // 远端不存在：也视为该账号“同步完成”（没有可下载内容）
            sendToRenderer('sync-status', {
              direction: 'down',
              state: 'done',
              partition,
              message: `无远端数据：${partition}`,
              progress: { current: newPartitions.indexOf(partition) + 1, total: newPartitions.length }
            });
          } else {
            logger.error('SyncDown', `Failed to download partition for ${partition}`, e);
            // 单个账号同步失败：通知 UI 解除禁用，允许用户点击/重试（整体流程继续）
            sendToRenderer('sync-status', {
              direction: 'down',
              state: 'error',
              partition,
              message: `同步失败：${partition}（可稍后重试）`,
              progress: { current: newPartitions.indexOf(partition) + 1, total: newPartitions.length }
            });
          }
        }
      } catch (e) {
        logger.error('SyncDown', `Failed to download account ${partition}`, e);
        sendToRenderer('sync-status', {
          direction: 'down',
          state: 'error',
          partition,
          message: `同步失败：${partition}（可稍后重试）`,
          progress: { current: newPartitions.indexOf(partition) + 1, total: newPartitions.length }
        });
      } finally {
        syncingDownPartitions.delete(partition);
        if (pendingSwitchPartition === partition) {
          pendingSwitchPartition = null;
          setTimeout(() => {
            try {
              switchToAccount(partition);
              sendToRenderer('sync-status', { direction: 'down', state: 'done', partition, message: `已切换：${partition}` });
            } catch { }
          }, 0);
        }
      }
    }

    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(localConfig, null, 2), 'utf-8');
      logger.debug('SyncDown', `Updated local config.json with ${Object.keys(localConfig).length} accounts`);
    } catch (e) {
      logger.error('SyncDown', 'Failed to save local config.json', e);
    }

    logger.info('SyncDown', `Incremental sync completed: ${newPartitions.length} accounts downloaded`);
    sendToRenderer('sync-status', { direction: 'down', state: 'done', message: '会话同步完成' });
  } catch (error) {
    logger.error('SyncDown', 'Sync error', error);
    sendToRenderer('sync-status', { direction: 'down', state: 'error', message: `会话同步失败：${error?.message || 'unknown'}` });
  }
}

function startBackgroundSyncDown() {
  if (syncDownInProgress) return;
  syncDownInProgress = true;
  Promise.resolve()
    .then(() => syncSessionsDownForCurrentUser())
    .catch((e) => {
      logger.error('SyncDown', 'Background sync error', e);
      sendToRenderer('sync-status', { direction: 'down', state: 'error', message: `会话同步失败：${e?.message || 'unknown'}` });
    })
    .finally(() => {
      syncDownInProgress = false;
    });
}

/**
 * 將當前裝置的瀏覽器會話資料上傳到 GitHub
 * 增量同步：只上传新增账号，只删除已删除账号
 */
async function syncSessionsUpForCurrentUser() {
  try {
    if (!canSyncSessions()) {
      logger.debug('SyncUp', 'Session sync skipped: sync disabled or not logged in');
      return;
    }

    const remoteBase = getUserRemoteBasePath();
    if (!remoteBase) {
      logger.debug('SyncUp', 'Session sync skipped: no remote base path');
      return;
    }

    const { configPath, partitionsPath } = getUserDataPaths();
    logger.info('SyncUp', `Starting sync for user ${currentUser.id}`);

    const changeSet = await getSyncChangeSetForCurrentUser();
    const needsSync = accountsChangedDuringSession || changeSet.hasChanges;
    if (!needsSync) {
      logger.info('SyncUp', 'No local session changes detected, skipping upload');
      return;
    }

    let dbAccounts = [];
    try {
      dbAccounts = await getAccountsByUserId(currentUser.id);
      logger.debug('SyncUp', `Loaded ${dbAccounts.length} accounts from database`);
    } catch (e) {
      logger.error('SyncUp', 'Failed to get accounts from database', e);
      throw e;
    }

    // 2. 上传全局 config.json 并更新本地 config.json
    try {
      const configData = {};
      for (const acc of dbAccounts) {
        configData[acc.partition] = {
          name: acc.name,
          platform: acc.platform,
          phoneNumber: acc.phoneNumber,
          status: acc.status || 'running',
          createdAt: acc.createdAt || new Date().toISOString()
        };
      }
      const configContent = JSON.stringify(configData, null, 2);

      const remoteConfigPath = `${remoteBase}/config.json`;
      logger.debug('SyncUp', `Uploading global config.json to ${remoteConfigPath}`);

      const configExists = await ghFileExists(remoteConfigPath).catch(() => ({ exists: false }));
      const configSha = configExists.exists ? configExists.sha : null;

      await ghPutFile(
        remoteConfigPath,
        configContent,
        `Sync global config.json`,
        configSha
      );
      logger.info('SyncUp', 'Successfully uploaded global config.json');

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configContent, 'utf-8');
      logger.debug('SyncUp', `Updated local config.json with ${Object.keys(configData).length} accounts`);
    } catch (e) {
      logger.error('SyncUp', 'Failed to upload/update config.json', e);
    }

    const dbPartitions = new Set(dbAccounts.map(acc => acc.partition));

    const existingRemoteAccounts = new Set();
    try {
      const remotePartitionsPath = `${remoteBase}/Partitions`;
      const remoteItems = await ghListDirectory(remotePartitionsPath).catch(() => []);
      for (const item of remoteItems) {
        if (item.type === 'dir') {
          existingRemoteAccounts.add(item.name);
        }
      }
      logger.debug('SyncUp', `Found ${existingRemoteAccounts.size} existing remote accounts in Partitions/`);
    } catch (e) {
      logger.debug('SyncUp', 'Partitions directory not found or empty on GitHub');
    }

    const newPartitions = [...dbPartitions].filter(p => !existingRemoteAccounts.has(p));
    const deletedPartitions = [...existingRemoteAccounts].filter(p => !dbPartitions.has(p));

    logger.info('SyncUp', `New accounts: ${newPartitions.length}, Deleted accounts: ${deletedPartitions.length}`);

    // 需要上传的分区：新增 + 本地文件变更（即使账号没新增/删除，也可能 session 变了）
    const partitionsToUpload = new Set([...newPartitions, ...Array.from(changeSet.changedPartitions || [])]);
    // 删除的账号无需上传
    for (const p of deletedPartitions) partitionsToUpload.delete(p);

    if (deletedPartitions.length > 0) {
      logger.info('SyncUp', `Removing ${deletedPartitions.length} deleted accounts: ${deletedPartitions.join(', ')}`);

      for (const partition of deletedPartitions) {
        try {
          const remotePartitionPath = `${remoteBase}/Partitions/${partition}`;
          await ghDeleteDirectory(remotePartitionPath, `Delete account ${partition}`);
          logger.info('SyncUp', `Successfully deleted account ${partition}`);
        } catch (e) {
          logger.error('SyncUp', `Failed to delete account ${partition}`, e);
        }
      }
    }

    if (newPartitions.length === 0) {
      logger.info('SyncUp', 'No new accounts to upload');
    } else {
      logger.info('SyncUp', `Uploading ${newPartitions.length} new accounts: ${newPartitions.join(', ')}`);

      for (const partition of newPartitions) {
        try {
          const account = dbAccounts.find(acc => acc.partition === partition);
          if (!account) {
            logger.warn('SyncUp', `Account ${partition} not found in database, skipping`);
            continue;
          }

          const remotePartitionPath = `${remoteBase}/Partitions/${partition}`;
          const localPartitionPath = path.join(partitionsPath, partition);

          try {
            const stat = await fs.stat(localPartitionPath).catch(() => null);
            if (stat && stat.isDirectory()) {
              logger.info('SyncUp', `Uploading partition for account: ${partition}`);
              logger.debug('SyncUp', `Local: ${localPartitionPath}, Remote: ${remotePartitionPath}`);

              try {
                const files = await fs.readdir(localPartitionPath);
                logger.debug('SyncUp', `Local directory contains ${files.length} items`);
              } catch (listErr) {
                logger.warn('SyncUp', `Could not list local directory: ${listErr.message}`);
              }

              await ghUploadDirectory(localPartitionPath, remotePartitionPath, `Sync partition for account ${partition}`, {
                skipUnchanged: true,
                maxFileSizeBytes: 10 * 1024 * 1024,
              });
              logger.info('SyncUp', `Successfully uploaded partition for ${partition}`);
            } else {
              logger.warn('SyncUp', `Local partition not found for ${partition} at ${localPartitionPath}, skipping`);
            }
          } catch (e) {
            logger.error('SyncUp', `Failed to upload partition for ${partition}`, e);
          }
        } catch (e) {
          logger.error('SyncUp', `Failed to upload account ${partition}`, e);
        }
      }
    }

    // 上传“已有账号但会话变更”的分区（增量：由 ghUploadDirectory + skipUnchanged 控制）
    const changedExisting = [...partitionsToUpload].filter(p => !newPartitions.includes(p));
    if (changedExisting.length > 0) {
      logger.info('SyncUp', `Uploading ${changedExisting.length} changed accounts: ${changedExisting.join(', ')}`);
      for (const partition of changedExisting) {
        try {
          const remotePartitionPath = `${remoteBase}/Partitions/${partition}`;
          const localPartitionPath = path.join(partitionsPath, partition);
          const stat = await fs.stat(localPartitionPath).catch(() => null);
          if (!stat || !stat.isDirectory()) continue;
          await ghUploadDirectory(localPartitionPath, remotePartitionPath, `Sync partition for account ${partition}`, {
            skipUnchanged: true,
            maxFileSizeBytes: 10 * 1024 * 1024,
            concurrency: 6
          });
          logger.info('SyncUp', `Successfully uploaded changed partition for ${partition}`);
        } catch (e) {
          logger.error('SyncUp', `Failed to upload changed partition for ${partition}`, e);
        }
      }
    }

    logger.info('SyncUp', `Session sync finished for user: ${currentUser.id}`);
    // 只有在一次同步流程结束后才更新 manifest（避免无变化时也刷新）
    if (changeSet?.nextManifest && changeSet?.manifestPath) {
      await persistSyncManifestForCurrentUser(changeSet.nextManifest, changeSet.manifestPath);
    }
    accountsChangedDuringSession = false;
  } catch (error) {
    logger.error('SyncUp', 'Sync error', error);
  }
}

async function ensureRendererHasLegalDialog(timeoutMs = 8000) {
  if (!mainWindow?.webContents || mainWindow.webContents.isDestroyed()) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await mainWindow.webContents.executeJavaScript(
        `(() => !!document.getElementById('legal-dialog'))()`,
        true
      );
      if (ok) return true;
    } catch { }
    await delay(120);
  }
  return false;
}

async function openLegalDialogInSamePageAndWait(tab = 'terms') {
  if (!mainWindow?.webContents || mainWindow.webContents.isDestroyed()) return;

  const ready = await ensureRendererHasLegalDialog();
  if (!ready) return;

  const requestId = `legal_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      legalDialogWaiters.delete(requestId);
      resolve();
    }, 10 * 60 * 1000);

    legalDialogWaiters.set(requestId, () => {
      clearTimeout(timeout);
      legalDialogWaiters.delete(requestId);
      resolve();
    });

    sendToRenderer('open-legal-dialog', { tab, requestId });
  });
}

/**
 * 從快取中根據 partition 取得帳戶資訊
 */
function getAccountByPartition(partition) {
  if (!partition) return null;
  try {
    return accountsCache.find(acc => acc?.partition === partition) || null;
  } catch {
    return null;
  }
}

/**
 * 获取当前 BrowserView 所属平台
 * @returns {string|null}
 */
function getCurrentPlatformSafe() {
  if (!currentView) return null;
  try {
    for (const [partition, view] of browserViews.entries()) {
      if (view === currentView) {
        const account = getAccountByPartition(partition);
        return (account?.platform || '').toLowerCase() || null;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 获取平台对应的 URL
 */
function getUrlByPlatform(platform) {
  const key = (platform || 'whatsapp').toLowerCase();
  return PLATFORM_URLS[key] || PLATFORM_URLS.whatsapp;
}

/**
 * 创建主窗口
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: '多平台會話管理',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  // 整頁縮放：主窗口（側邊欄、頂欄、底欄）與內嵌頁使用同一比例
  mainWindow.webContents.once('did-finish-load', () => {
    const factor = getEmbeddedZoomFactor();
    mainWindow.webContents.setZoomFactor(factor);
    sendToRenderer('zoom-changed', factor);
  });

  // 窗口事件监听
  mainWindow.on('resize', () => {
    if (currentView) {
      setTimeout(adjustViewBounds, ADJUST_BOUNDS_DELAY);
    }
  });

  mainWindow.on('close', async (event) => {
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '確認關閉',
      message: '關閉應用將下線所有會話',
      detail: '確定要關閉應用嗎？所有正在執行的會話將會下線。',
      buttons: ['取消', '確定'],
      defaultId: 0,
      cancelId: 0
    });

    if (result.response === 1) {
      mainWindow.destroy();
      if (process.platform !== 'darwin') {
        app.quit();
      }
    }
  });

  return mainWindow;
}

/**
 * 获取内容区域边界
 * @returns {Promise<Object>} 边界对象 {x, y, width, height}
 */
async function getFallbackBounds() {
  if (!mainWindow || !currentView) return null;

  try {
    const [width, height] = mainWindow.getSize();
    let headerHeight = HEADER_HEIGHT;

    // 尝试从渲染进程获取 header 高度
    try {
      headerHeight = await mainWindow.webContents.executeJavaScript(
        `(() => {
          const header = document.querySelector('.content-header');
          return header ? header.offsetHeight : ${HEADER_HEIGHT};
        })()`,
        true
      ) || HEADER_HEIGHT;
    } catch {

    }

    return {
      x: SIDEBAR_WIDTH,
      y: headerHeight,
      width: Math.max(width - SIDEBAR_WIDTH, 0),
      height: Math.max(height - headerHeight, 0)
    };
  } catch {
    return null;
  }
}

/**
 * 降级调整视图边界
 */
async function fallbackAdjustBounds() {
  if (!mainWindow || !currentView) return;

  const bounds = await getFallbackBounds();
  if (bounds && currentView) {
    currentView.setBounds(bounds);
    // 若遮罩存在，也保持一致边界
    if (isMaskAttached() && instagramMaskView) {
      try {
        instagramMaskView.setBounds(bounds);
      } catch { }
    }
  }
}

/**
 * 获取内容区域边界（从 DOM 获取）
 * @returns {Promise<Object|null>} 边界对象或 null
 */
async function getContentBounds() {
  if (!mainWindow?.webContents) return null;

  try {
    const bounds = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('window-content');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.floor(rect.left),
          y: Math.floor(rect.top),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height)
        };
      })()`,
      true
    );

    if (bounds) {
      return {
        x: Math.max(bounds.x, 0),
        y: Math.max(bounds.y, 0),
        width: Math.max(bounds.width, 0),
        height: Math.max(bounds.height, 0)
      };
    }
  } catch {
  }

  return null;
}

/**
 * 调整 BrowserView 边界
 */
async function adjustViewBounds() {
  if (!mainWindow || !currentView) return;

  const bounds = await getContentBounds();
  if (bounds && currentView) {
    // 考虑缩放因子调整边界尺寸，使用更精确的计算
    const zoomFactor = mainWindow.webContents.getZoomFactor();
    // 使用 Math.floor 确保边界不会超出容器范围
    const adjustedBounds = {
      x: Math.floor(bounds.x * zoomFactor),
      y: Math.floor(bounds.y * zoomFactor),
      width: Math.floor(bounds.width * zoomFactor),
      height: Math.floor(bounds.height * zoomFactor)
    };

    // 立即设置边界，避免异步延迟导致的跳动
    if (currentView && !currentView.webContents.isDestroyed()) {
      currentView.setBounds(adjustedBounds);
    }
    // 若遮罩存在，也保持一致边界
    if (isMaskAttached() && instagramMaskView && !instagramMaskView.webContents.isDestroyed()) {
      try {
        instagramMaskView.setBounds(adjustedBounds);
      } catch { }
    }
  } else {
    await fallbackAdjustBounds();
  }
}

/**
 * 获取内嵌页（BrowserView）当前缩放比例
 */
function getEmbeddedZoomFactor() {
  return store.get(STORE_ZOOM_VIEW, ZOOM_DEFAULT);
}

/**
 * 对内嵌页应用缩放并持久化；同時對主窗口（側邊欄、頂欄、底欄）應用相同縮放，實現整頁一致縮放
 * @param {number} factor - 缩放系数
 */
function applyEmbeddedZoom(factor) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor));
  store.set(STORE_ZOOM_VIEW, clamped);

  // 同步设置主窗口和内嵌页的缩放
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(clamped);
  }

  if (currentView && currentView.webContents && !currentView.webContents.isDestroyed()) {
    currentView.webContents.setZoomFactor(clamped);
  }

  // 立即调整视图边界以确保缩放效果正确应用，避免跳动
  if (currentView) {
    adjustViewBounds();
  }

  sendToRenderer('zoom-changed', clamped);
}

/**
 * 内嵌页放大
 */
function zoomViewIn() {
  const next = getEmbeddedZoomFactor() + ZOOM_STEP;
  applyEmbeddedZoom(next);
}

/**
 * 内嵌页缩小
 */
function zoomViewOut() {
  const next = getEmbeddedZoomFactor() - ZOOM_STEP;
  applyEmbeddedZoom(next);
}

/**
 * 内嵌页重置缩放
 */
function zoomViewReset() {
  const platform = getCurrentPlatformSafe();

  // 只對 Instagram 做特別處理：先蓋遮罩，再延遲執行縮放與隱藏腳本，
  // 讓整個「重置縮放 + DOM 重排」過程都在遮罩之下完成，避免導航欄短暫露出。
  if (platform === 'instagram') {
    const view = currentView;
    const webContents = view?.webContents;

    // 稍微延遲再真正套用縮放，確保遮罩已經加上並完成一次 bounds 調整
    setTimeout(() => {
      applyEmbeddedZoom(ZOOM_DEFAULT);

      // 在縮放完成後，再多次強化隱藏導航欄的腳本注入，處理縮放導致的 DOM 重繪
      if (webContents && !webContents.isDestroyed()) {
        try {
          injectInstagramSidebarHide(webContents);
          setTimeout(() => injectInstagramSidebarHide(webContents), 120);
          setTimeout(() => injectInstagramSidebarHide(webContents), 600);
        } catch {
          // 忽略單次注入失敗
        }
      }
    }, 80);
    return;
  }

  // 其他平台保持原本行為
  applyEmbeddedZoom(ZOOM_DEFAULT);
}

/**
 * 对任意 webContents（如条款/隐私窗口）应用缩放
 * @param {Electron.WebContents} webContents - 目标 webContents
 * @param {'in'|'out'|'reset'} action - 操作
 */
function applyPageZoom(webContents, action) {
  if (!webContents || webContents.isDestroyed()) return;
  let factor = webContents.getZoomFactor();
  if (action === 'in') {
    factor = Math.min(ZOOM_MAX, factor + ZOOM_STEP);
  } else if (action === 'out') {
    factor = Math.max(ZOOM_MIN, factor - ZOOM_STEP);
  } else {
    factor = ZOOM_DEFAULT;
  }
  webContents.setZoomFactor(factor);
  try {
    webContents.send('page-zoom-changed', factor);
  } catch { }
}


/**
 * 创建 BrowserView
 */
function createBrowserView(partition) {
  const account = getAccountByPartition(partition);
  const platform = account?.platform || 'whatsapp';
  const targetUrl = getUrlByPlatform(platform);

  const view = new BrowserView({
    webPreferences: {
      partition: `persist:${partition}`,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const webContents = view.webContents;
  webContents.setUserAgent(CHROME_USER_AGENT);

  // Avoid MaxListenersExceededWarning when many views are created
  try {
    if (typeof webContents.setMaxListeners === 'function') {
      webContents.setMaxListeners(30);
    }
  } catch { }

  // Instagram：尽早注入隐藏逻辑（DOM-ready 时就装 observer），避免“进入后几秒才隐藏”
  webContents.on('dom-ready', () => {
    if (platform === 'instagram') {
      injectInstagramSidebarHide(webContents);
    }
  });

  webContents.once('did-finish-load', () => {
    if (mainWindow && currentView === view) {
      setTimeout(() => adjustViewBounds(), 50);
    }
  });

  // 每次內嵌頁加載完成後重新套用縮放，避免首次進入或切換時比例延遲
  webContents.on('did-finish-load', () => {
    if (mainWindow && currentView === view && !view.webContents.isDestroyed()) {
      const factor = getEmbeddedZoomFactor();
      view.webContents.setZoomFactor(factor);
      if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.setZoomFactor(factor);
      }
      sendToRenderer('zoom-changed', factor);
      // 立即调整视图边界以确保缩放效果正确应用
      if (currentView) {
        setTimeout(() => adjustViewBounds(), 50);
      }
      // Instagram：在缩放应用后再延迟注入侧栏隐藏，避免缩放触发的重绘覆盖隐藏
      if (platform === 'instagram') {
        // 先立即注入一次，再用很短延迟兜底，基本可做到“刚进入就隐藏”
        injectInstagramSidebarHide(view.webContents);
        setTimeout(() => injectInstagramSidebarHide(view.webContents), 60);
      }
    }
  });

  webContents.on('did-frame-finish-load', () => {
    if (platform === 'instagram') {
      // 延迟执行CSS注入，在缩放设置之后应用（延迟略长以避开 did-finish-load 的缩放时机）
      injectInstagramSidebarHide(webContents);
      setTimeout(() => injectInstagramSidebarHide(webContents), 60);
    }

    // 对所有平台启动消息检查（等待页面完全加载）
    if (mainWindow && currentView === view) {
      setTimeout(() => {
        messageChecker.startMessageCheck(partition, getAccountByPartition, browserViews, sendToRenderer);
      }, messageChecker.CHECK_DELAY);
    }
  });

  webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== 0) {
      logger.error('Account', `[${platform}] load failed`, { errorCode, errorDescription, url: validatedURL });
    }
  });

  webContents.loadURL(targetUrl);
  return view;
}

/**
 * 更新帳戶狀態（暫停 / 執行中），同步到 DB 與快取
 * @param {string} partition - 账户分区标识
 * @param {string} status - 狀態字串
 */
async function updateAccountStatus(partition, status = 'running') {
  try {
    if (!currentUser) return;
    await dbUpdateAccountStatus(currentUser.id, partition, status);
    // 更新快取
    accountsCache = accountsCache.map(acc =>
      acc.partition === partition ? { ...acc, status } : acc
    );
  } catch (error) {
    logger.error('Account', 'Error updating account status', error);
  }
}

/**
 * 切换到指定账户
 * @param {string} partition - 账户分区标识
 */
function switchToAccount(partition) {
  try {
    const targetAccount = getAccountByPartition(partition);
    const targetPlatform = (targetAccount?.platform || 'whatsapp').toLowerCase();

    // Instagram：僅在「第一次切換到該帳戶」時顯示一次載入遮罩（約 4 秒）
    if (targetPlatform === 'instagram' && !instagramInitialMaskShown.has(partition)) {
      instagramInitialMaskShown.add(partition);
      showInstagramMask(4000);
    }

    // 隐藏当前视图
    if (currentView && mainWindow) {
      mainWindow.removeBrowserView(currentView);
    }

    // 获取或创建 BrowserView
    let view = browserViews.get(partition);
    if (!view) {
      view = createBrowserView(partition);
      browserViews.set(partition, view);
    }

    // 显示新视图
    mainWindow.addBrowserView(view);
    currentView = view;
    view.setBackgroundColor('#ffffff');
    // 如果是 Instagram，确保遮罩仍在最上层
    if (targetPlatform === 'instagram') {
      setMaskOnTop();
    }

    // 更新账户状态
    updateAccountStatus(partition, 'running');

    // 启动消息检查（messageChecker 内部会处理平台配置）
    const account = getAccountByPartition(partition);
    if (account) {
      // 当前激活账号：高频轮询；其他账号：低频轮询（对多账号更友好）
      messageChecker.startMessageCheck(partition, getAccountByPartition, browserViews, sendToRenderer, {
        intervalMs: messageChecker.ACTIVE_CHECK_INTERVAL
      });

      for (const [otherPartition] of browserViews.entries()) {
        if (otherPartition === partition) continue;
        messageChecker.startMessageCheck(otherPartition, getAccountByPartition, browserViews, sendToRenderer, {
          intervalMs: messageChecker.INACTIVE_CHECK_INTERVAL
        });
      }
    }

    setTimeout(() => adjustViewBounds(), ADJUST_BOUNDS_DELAY);
    const zoomFactor = getEmbeddedZoomFactor();
    // 同步设置缩放和边界，避免跳动
    if (currentView.webContents) {
      currentView.webContents.setZoomFactor(zoomFactor);
    }
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(zoomFactor);
    }
    sendToRenderer('zoom-changed', zoomFactor);
    // 立即调整边界
    if (currentView) {
      adjustViewBounds();
    }

    // 对于Instagram平台，确保sidebar隐藏（延迟略长，在缩放和布局稳定后注入）
    if (account && account.platform === 'instagram') {
      // 立即注入 + 短延迟兜底，缩短可见时间
      injectInstagramSidebarHide(currentView?.webContents);
      setTimeout(() => injectInstagramSidebarHide(currentView?.webContents), 60);
    }

    sendToRenderer('account-switched', partition);
  } catch (error) {
    logger.error('Account', 'Error switching account', error);
  }
}

/**
 * 验证手机号格式
 */
function validatePhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return false;
  }
  // 移除所有非数字字符
  const cleaned = phoneNumber.replace(/\D/g, '');
  // 验证
  return cleaned.length >= 8 && cleaned.length <= 15;
}

/**
 * 清理手机号（只保留数字）
 */
function sanitizePhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return '';
  }
  return phoneNumber.replace(/\D/g, '');
}

/**
 * 生成唯一的账户名称
 * @param {string} platform - 平台名称
 * @param {string} phoneSuffix - 手机号后4位
 * @param {Array} existingAccounts - 现有账户列表
 * @returns {string} 唯一的账户名称
 */
function generateUniqueAccountName(platform, phoneSuffix, existingAccounts) {
  const baseName = `${platform.toUpperCase()} ${phoneSuffix}`;
  let accountNumber = 1;
  let finalName = baseName;

  while (existingAccounts.some(acc =>
    acc.name === finalName && acc.platform === platform
  )) {
    accountNumber++;
    finalName = `${baseName} (${accountNumber})`;
  }

  return finalName;
}

/**
 * 创建新账户（使用 MySQL 存儲）
 * @param {string} platform - 平台名称
 * @param {string} phoneNumber - 手机号
 * @returns {Promise<string>} 账户分区标识
 */
async function createNewAccount(platform = 'whatsapp', phoneNumber = '') {
  try {
    if (!currentUser) {
      throw new Error('尚未登入，無法建立帳戶');
    }

    const safePlatform = (platform || 'whatsapp').toLowerCase();

    // 验证手机号
    if (!phoneNumber || !validatePhoneNumber(phoneNumber)) {
      throw new Error('請輸入有效的手機號碼（8-15位數字）');
    }

    const cleanedPhone = sanitizePhoneNumber(phoneNumber);
    const partition = `${safePlatform}-${cleanedPhone}`;

    // 检查该手机号是否已存在（同一平台 + 同一使用者）
    const exists = await accountExists(currentUser.id, safePlatform, cleanedPhone);
    if (exists) {
      throw new Error(`該平台下手機號碼 ${cleanedPhone} 已存在`);
    }

    // 生成唯一的账户名称（基於目前快取）
    const phoneSuffix = cleanedPhone.slice(-4);
    const accountName = generateUniqueAccountName(
      safePlatform,
      phoneSuffix,
      accountsCache
    );

    // 寫入 DB
    const created = await createAccount(
      currentUser.id,
      safePlatform,
      cleanedPhone,
      accountName,
      partition
    );

    // 更新快取（最新建立的放前面）
    const newAccount = {
      partition,
      name: created.name,
      platform: created.platform,
      phoneNumber: created.phoneNumber,
      status: created.status || 'running',
      unreadCount: 0,
      latestMessageTime: 0,
      createdAt: created.createdAt || new Date().toISOString()
    };
    accountsCache = [newAccount, ...accountsCache];
    // Mark sync-needed per requirement (only when new/delete account happens)
    markAccountsChanged('create-account');

    sendToRenderer('accounts-updated', accountsCache);

    switchToAccount(partition);
    return partition;
  } catch (error) {
    logger.error('Account', 'Error creating account', error);
    throw error;
  }
}

/**
 * 從 DB 載入當前使用者的所有帳戶並更新快取
 */
async function loadAccountsForCurrentUser() {
  try {
    if (!currentUser) return [];
    const accounts = await getAccountsByUserId(currentUser.id);
    // 正規化為前端所需欄位
    accountsCache = accounts.map(acc => ({
      partition: acc.partition,
      name: acc.name,
      platform: acc.platform,
      phoneNumber: acc.phoneNumber,
      status: acc.status || 'running',
      unreadCount: acc.unreadCount || 0,
      latestMessageTime: acc.latestMessageTime || 0,
      createdAt: acc.createdAt || new Date().toISOString()
    }));
    return accountsCache;
  } catch (error) {
    logger.error('Account', 'Error getting all accounts', error);
    accountsCache = [];
    return [];
  }
}

/**
 * 暂停账户
 * @param {string} partition - 账户分区标识
 */
function pauseAccount(partition) {
  try {
    const view = browserViews.get(partition);
    if (view && currentView === view && mainWindow) {
      mainWindow.removeBrowserView(view);
      currentView = null;
    }

    updateAccountStatus(partition, 'paused');
    sendToRenderer('account-paused', partition);
  } catch (error) {
    logger.error('Account', 'Error pausing account', error);
  }
}

/**
 * 恢复账户
 * @param {string} partition - 账户分区标识
 */
function resumeAccount(partition) {
  try {
    switchToAccount(partition);
    sendToRenderer('account-resumed', partition);
  } catch (error) {
    logger.error('Account', 'Error resuming account', error);
  }
}

/**
 * 重命名账户
 */
async function renameAccount(partition, newName) {
  try {
    if (!newName || typeof newName !== 'string' || newName.trim().length === 0) {
      throw new Error('帳戶名稱不能為空');
    }

    const trimmedName = newName.trim();
    if (trimmedName.length > 50) {
      throw new Error('帳戶名稱不能超過 50 個字元');
    }

    const accountIndex = accountsCache.findIndex(acc => acc.partition === partition);
    if (accountIndex === -1 || !currentUser) {
      throw new Error('帳戶不存在');
    }

    const currentAccount = accountsCache[accountIndex];
    const currentPlatform = currentAccount.platform || 'whatsapp';

    // 检查名称是否与同一平台下的其他账户重复
    const duplicateAccount = accountsCache.find(
      (acc, index) =>
        acc.name === trimmedName &&
        index !== accountIndex &&
        (acc.platform || 'whatsapp') === currentPlatform
    );
    if (duplicateAccount) {
      throw new Error(`該平台下帳戶名稱 "${trimmedName}" 已存在`);
    }

    // 更新 DB
    const updated = await dbRenameAccount(currentUser.id, partition, trimmedName);
    if (!updated) {
      throw new Error('帳戶不存在或更新失敗');
    }

    // 更新快取
    accountsCache[accountIndex].name = trimmedName;
    sendToRenderer('accounts-updated', accountsCache);
    return accountsCache;
  } catch (error) {
    logger.error('Account', 'Error renaming account', error);
    throw error;
  }
}

/**
 * 删除账户
 */
async function deleteAccount(partition) {
  try {
    // 停止消息检查
    messageChecker.stopMessageCheck(partition);

    // 從 DB 刪除
    if (currentUser) {
      await dbDeleteAccount(currentUser.id, partition);
    }

    // 删除 BrowserView
    const view = browserViews.get(partition);
    if (view) {
      if (currentView === view) {
        currentView = null;
      }
      if (mainWindow) {
        mainWindow.removeBrowserView(view);
      }
      try {
        await view.webContents.session.clearStorageData();
        view.webContents.destroy();
      } catch { }
      browserViews.delete(partition);
    }

    // 更新快取
    accountsCache = accountsCache.filter(acc => acc.partition !== partition);
    // Mark sync-needed per requirement (only when new/delete account happens)
    markAccountsChanged('delete-account');

    sendToRenderer('accounts-updated', accountsCache);
    return accountsCache;
  } catch (error) {
    logger.error('Account', 'Error deleting account', error);
    return [];
  }
}

// IPC 处理
ipcMain.handle('get-accounts', () => {
  return loadAccountsForCurrentUser();
});

// 渲染进程通知面板宽度已变更 → 立即重新对齐 BrowserView 边界
let _panelResizeRafId = null;
ipcMain.on('panel-resized', () => {
  if (!mainWindow || !currentView) return;
  // 用 setImmediate 去掉同步阻塞，同时天然合并同一帧内的多次通知
  if (_panelResizeRafId) return;
  _panelResizeRafId = setImmediate(() => {
    _panelResizeRafId = null;
    adjustViewBounds();
  });
});



ipcMain.handle('remove-account', async (event, partition) => {
  return await deleteAccount(partition);
});

ipcMain.handle('rename-account', (event, partition, newName) => {
  try {
    return renameAccount(partition, newName);
  } catch (error) {
    throw error;
  }
});

ipcMain.on('switch-account', (event, partition) => {
  if (syncingDownPartitions.has(partition)) {
    pendingSwitchPartition = partition;
    sendToRenderer('sync-status', { direction: 'down', state: 'syncing', partition, blocked: true, message: `账号正在同步：${partition}，请稍后…` });
    return;
  }
  switchToAccount(partition);
});

ipcMain.on('create-new-account', (event, platform, phoneNumber) => {
  createNewAccount(platform, phoneNumber).catch((error) => {
    // 发送错误消息到渲染进程
    sendToRenderer('account-create-error', error.message || '建立帳戶失敗');
  });
});

ipcMain.on('refresh-account', (event, partition) => {
  try {
    const account = getAccountByPartition(partition);
    const platform = (account?.platform || '').toLowerCase();
    // Instagram：每次手動刷新時顯示約 3 秒的載入遮罩
    if (platform === 'instagram') {
      showInstagramMask(2800);
    }
  } catch {
    // 忽略單次錯誤，避免影響刷新本身
  }
  const view = browserViews.get(partition);
  view?.webContents.reload();
});

// 内嵌页（BrowserView）缩放
ipcMain.on('zoom-view-in', () => zoomViewIn());
ipcMain.on('zoom-view-out', () => zoomViewOut());
ipcMain.on('zoom-view-reset', () => zoomViewReset());
ipcMain.handle('get-zoom-factor', () => getEmbeddedZoomFactor());

// 当前窗口页缩放（条款/隐私等弹窗）
ipcMain.on('zoom-page-in', (event) => applyPageZoom(event.sender, 'in'));
ipcMain.on('zoom-page-out', (event) => applyPageZoom(event.sender, 'out'));
ipcMain.on('zoom-page-reset', (event) => applyPageZoom(event.sender, 'reset'));

ipcMain.on('hide-browser-view', () => {
  if (currentView && mainWindow) {
    mainWindow.removeBrowserView(currentView);
  }
  // 对话框出现时也把遮罩移除，避免残留
  hideInstagramMask();
});

ipcMain.on('show-browser-view', () => {
  if (currentView && mainWindow) {
    mainWindow.addBrowserView(currentView);
    setTimeout(() => adjustViewBounds(), ADJUST_BOUNDS_DELAY);
  }
});

ipcMain.on('pause-account', (event, partition) => {
  pauseAccount(partition);
});

ipcMain.on('resume-account', (event, partition) => {
  resumeAccount(partition);
});

ipcMain.on('legal-dialog-closed', (event, requestId) => {
  try {
    const resolver = legalDialogWaiters.get(requestId);
    if (resolver) resolver();
  } catch { }
});

// 登入：使用 MySQL users 表校驗帳號密碼；不自動註冊新使用者
ipcMain.handle('login', async (event, payload) => {
  try {
    const { username, password } = payload || {};
    if (!username || !password) {
      return { success: false, message: '請輸入帳號與密碼' };
    }

    const trimmedUsername = String(username).trim();
    const plainPassword = String(password);

    // 初始化資料庫（若尚未初始化）
    await initDatabase();

    const user = await findUserByUsername(trimmedUsername);

    if (!user) {
      return { success: false, message: '帳號或密碼錯誤' };
    }

    // 已存在：校驗密碼
    const ok = await verifyPassword(plainPassword, user.password_hash);
    if (!ok) {
      return { success: false, message: '帳號或密碼錯誤' };
    }

    currentUser = {
      id: user.id,
      username: trimmedUsername
    };

    // 登入成功後：立即返回并进入主界面；GitHub 下行同步放后台执行
    startBackgroundSyncDown();
    await loadAccountsForCurrentUser();

    return {
      success: true,
      userId: user.id,
      username: trimmedUsername
    };
  } catch (error) {
    logger.error('Auth', 'Login error', error);
    return { success: false, message: '登入失敗，請聯繫管理員或稍後再試' };
  }
});

// 注册新用户
ipcMain.handle('register', async (event, payload) => {
  try {
    const { fullName, email, username, password } = payload || {};
    if (!username || !password || !fullName || !email) {
      return { success: false, message: '請填寫完整資訊' };
    }

    const trimmedUsername = String(username).trim();
    const trimmedEmail = String(email).trim();
    const trimmedFullName = String(fullName).trim();

    await initDatabase();

    // Check if username already exists
    const existing = await findUserByUsername(trimmedUsername);
    if (existing) {
      return { success: false, message: '帳號已存在，請使用其他帳號名稱' };
    }

    const newUser = await createUser(trimmedUsername, trimmedEmail, trimmedFullName, password);
    return {
      success: true,
      userId: newUser.id,
      username: trimmedUsername,
      email: trimmedEmail,
      fullName: trimmedFullName
    };
  } catch (error) {
    logger.error('Auth', 'Register error', error);
    return { success: false, message: '註冊失敗，請稍後再試' };
  }
});

// 发邮件 - 用于重置密码
ipcMain.handle('reset-password', async (event, data) => {
  try {
    // const email = data.forgotEmail?.trim();
    const email = "phangyeemun@gmail.com";
    if (!email) {
      return { error: true, message: "Email is required" };
    }

    // Check if user exists
    const user = await getUserByEmail(email);
    if (!user) {
      return { error: true, message: "Email not registered" };
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 15 * 60 * 1000; // 15 minutes
    await saveResetToken(user.id, token, expiry);

    // Create a "link-safe" key by hashing email + token
    const key = await hashToken(email, token);

    // Send email with only email + key in URL
    const resetLink = `${process.env.DOMAIN_URL}/all-in-one/reset-password.html?email=${encodeURIComponent(email)}&key=${key}`;
    console.log("Reset link:", resetLink);
    await sendResetEmail(email, resetLink);

    return { success: true };

  } catch (err) {
    console.error(err);
    return { error: true, message: "Failed to send reset email" };
  }
});

ipcMain.handle("validate-reset-token", async (event, { email, key }) => {
  const user = await getUserByEmail(email);
  if (!user) return { valid: false };

  const expectedKey = await hashToken(email, user.reset_token);
  const valid = (key === expectedKey && Date.now() <= user.reset_token_expiry);
  return { valid };
});

// 打開服務條款 / 隱私權政策視窗
ipcMain.handle('open-terms', () => {
  // 保留接口但改为同頁彈窗
  openLegalDialogInSamePageAndWait('terms');
});

ipcMain.handle('open-privacy', () => {
  // 保留接口但改为同頁彈窗
  openLegalDialogInSamePageAndWait('privacy');
});

/**
 * 首次啟動檢查：要求使用者同意服務條款與隱私權政策
 * 流程：
 *  - 使用者可以反覆「查看條款」
 *  - 只有按「同意並繼續」才會寫入同意紀錄
 *  - 按「退出應用」或關閉對話框則直接退出
 */
async function ensureTermsAccepted() {
  try {
    const hasAccepted = store.get('hasAcceptedTerms', false);
    if (hasAccepted || !mainWindow) {
      return;
    }

    // 迴圈直到使用者「同意」或「退出」
    // 0: 同意並繼續, 1: 查看條款, 2: 退出應用 / 關閉對話框
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '使用條款確認',
        message: '在使用 CS-AI-CRM 之前，請先閱讀並同意服務條款與隱私權政策。',
        detail: '您可以點擊「查看條款」閱讀詳細內容，或於主視窗右下角隨時再次查看。',
        buttons: ['同意並繼續', '查看條款', '退出應用'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });

      if (response === 0) {
        // 使用者同意
        store.set('hasAcceptedTerms', true);
        return;
      }

      if (response === 1) {
        // 查看條款：在同一頁面彈出條款視窗，關閉後再回到迴圈重新詢問
        await openLegalDialogInSamePageAndWait('terms');
        continue;
      }

      // 退出應用或關閉對話框
      if (process.platform !== 'darwin') {
        app.quit();
      } else {
        app.hide();
      }
      return;
    }
  } catch (error) {
    logger.error('Auth', 'Error in ensureTermsAccepted', error);
  }
}

// function getCloudflaredPath() {
//   if (app.isPackaged) {
//     // When built into exe
//     return path.join(process.resourcesPath, "cloudflared.exe");
//   } else {
//     // When running npm start
//     return path.join(__dirname, "cloudflared", "cloudflared.exe");
//   }
// }

// function startTunnel() {
//   const cloudflaredPath = getCloudflaredPath();
//   console.log("Cloudflared path:", cloudflaredPath);

//   const tunnel = spawn(cloudflaredPath, ["tunnel", "--url", "http://localhost:3000"], {
//     stdio: 'pipe',
//     windowsHide: true
//   });

//   tunnel.stdout.on("data", handleTunnelData);
//   tunnel.stderr.on("data", handleTunnelData);

//   function handleTunnelData(data) {
//     const text = data.toString();
//     console.log("cloudflared output:", text);

//     const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
//     if (match) {
//       const tunnelUrl = match[0];
//       console.log("Tunnel URL detected:", tunnelUrl);
//       updateConfigFile(tunnelUrl);
//     }
//   }
// }

// async function updateConfigFile(url) {
//   const config = { api: url };
//   await fs.writeFile(path.join(__dirname, "tunnel-config.json"), JSON.stringify(config, null, 2));

//   // optional: call pushConfig if you want
//   await pushConfig();
// }

// async function pushConfig() {
//   try {
//     await git.add("tunnel-config.json");
//     await git.commit("Update tunnel URL");
//     await git.push();
//     console.log("Tunnel config pushed successfully!");
//   } catch (err) {
//     console.error("Git push failed:", err);
//   }
// }

// 应用生命周期
app.whenReady().then(async () => {
  // startTunnel();
  createMainWindow();
  await ensureTermsAccepted();

  // 全局快捷键：内嵌页缩放（类似浏览器 Ctrl+Plus/Minus/0）
  globalShortcut.register('CommandOrControl+=', () => {
    if (currentView) zoomViewIn();
  });
  globalShortcut.register('CommandOrControl+-', () => {
    if (currentView) zoomViewOut();
  });
  globalShortcut.register('CommandOrControl+0', () => {
    if (currentView) zoomViewReset();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('before-quit', async (event) => {
  if (isQuitting) {
    if (syncInProgress) {
      logger.debug('Quit', 'Sync in progress, preventing quit and waiting...');
      event.preventDefault();
      let waited = 0;
      while (syncInProgress && waited < 65000) {
        await delay(1000);
        waited += 1000;
      }
    }
    return;
  }
  isQuitting = true;

  if (currentUser) {
    event.preventDefault();
    logger.info('Quit', `Syncing sessions for user: ${currentUser.id}`);

    try {
      globalShortcut.unregisterAll();
      messageChecker.stopAllMessageChecks();

      syncInProgress = true;

      const syncPromise = syncSessionsUpForCurrentUser()
        .then(() => {
          syncInProgress = false;
          return 'completed';
        })
        .catch((err) => {
          logger.error('Quit', 'Sync promise rejected', err);
          syncInProgress = false;
          return 'error';
        });

      const timeoutPromise = delay(120000).then(() => {
        logger.warn('Quit', 'Session sync timeout after 120 seconds, forcing exit');
        syncInProgress = false;
        return 'timeout';
      });

      const result = await Promise.race([syncPromise, timeoutPromise]);
      logger.info('Quit', `Session sync result: ${result}`);

      await delay(1000);
    } catch (e) {
      syncInProgress = false;
      logger.error('Quit', 'Error during cleanup', e);
    }
  } else {
    logger.debug('Quit', 'No user logged in, skipping sync');
    globalShortcut.unregisterAll();
    messageChecker.stopAllMessageChecks();
  }

  try {
    hideInstagramMask();
    browserViews.forEach(view => {
      try {
        if (mainWindow) {
          mainWindow.removeBrowserView(view);
        }
      } catch { }
    });
  } catch (err) {
    logger.error('Quit', 'Error cleaning up views', err);
  }

  await new Promise(resolve => {
    if (process.stdout.write('')) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
    }
  });

  // if (tunnel) tunnel.kill();

  await delay(1000);

  setTimeout(() => {
    app.exit(0);
  }, 100);
});
