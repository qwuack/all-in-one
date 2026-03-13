/**
 * 消息检查与未读数提取
 * - 主进程周期性向各 BrowserView 注入脚本，读取未读数/最新时间
 * - 选择器随各平台页面更新而变化：此处配置的“稳定性”比“完美”更重要
 */
const Store = require('electron-store');

const store = new Store();

const messageCheckIntervals = new Map();

const ACTIVE_CHECK_INTERVAL = 3000;
const INACTIVE_CHECK_INTERVAL = 10000;

const CHECK_DELAY = 5000;

/**
 * 每个平台提供一组选择器与策略：
 * - `unreadIndicatorSelectors`: 未读数量/红点等指示元素
 * - `sidebarContainerSelectors`: 对话列表容器（可选）
 * - `messageListSelectors`: 对话列表项
 * - `timeSelectors`: 列表项时间元素（用于推断最新消息时间）
 * - `unreadMarkerSelectors`: 备选未读判断（如通过背景/样式）
 * - `checkStyleBackground`: 是否需要检测背景色/样式
 * - `extractFromTitle`: 是否尝试从页面标题提取未读数
 */
const PLATFORM_CONFIGS = {
  whatsapp: {
    unreadIndicatorSelectors: [
      '[data-testid="icon-unread-count"]',
      '[data-testid="unread-count"]',
      '.unread-count',
      '[aria-label*="unread"]',
      '[aria-label*="未读"]'
    ],
    sidebarContainerSelectors: [
      '#side',
      '[data-testid="chatlist"]',
      'div[role="complementary"]',
      'div[data-testid="chatlist"]'
    ],
    messageListSelectors: [
      '[data-testid="cell-frame-container"]',
      '[role="listitem"]'
    ],
    timeSelectors: [
      '[data-testid="msg-time"]',
      'time',
      'span[title*=":"]'
    ],
    unreadMarkerSelectors: null,
    checkStyleBackground: false,
    extractFromTitle: false
  },
  messenger: {
    unreadIndicatorSelectors: [
      '[aria-label*="unread"]',
      '[aria-label*="未读"]',
      '[role="listitem"] [style*="background"]',
      'div[class*="unread"]',
      'span[class*="unread"]'
    ],
    messageListSelectors: [
      '[role="listitem"]',
      'div[class*="conversation"]',
      'div[class*="thread"]'
    ],
    // 时间元素选择器（用于排序）
    timeSelectors: [
      'span[title*=":"]',
      'time',
      'div[class*="timestamp"]',
      'div[class*="time"]'
    ],
    unreadMarkerSelectors: [
      'div[style*="background"]',
      'span[style*="background"]',
      'div[class*="unread"]',
      'span[class*="unread"]'
    ],
    checkStyleBackground: true,
    extractFromTitle: true
  },
  instagram: {
    unreadIndicatorSelectors: [
      '[aria-label*="unread"]',
      '[aria-label*="未读"]',
      'div[class*="unread"]',
      'span[class*="unread"]',
      'div[role="button"][class*="unread"]'
    ],
    messageListSelectors: [
      'div[role="button"][tabindex="0"]',
      'div[class*="thread"]',
      'div[class*="conversation"]'
    ],
    timeSelectors: [
      'time',
      'span[title*=":"]',
      'div[class*="timestamp"]',
      'div[class*="time"]'
    ],
    unreadMarkerSelectors: [
      'div[style*="background"]',
      'span[style*="background"]',
      'div[class*="unread"]',
      'span[class*="unread"]',
      'div[class*="active"]'
    ],
    checkStyleBackground: false,
    extractFromTitle: true
  },
  wechat: {
    unreadIndicatorSelectors: [
      '[class*="unread"]',
      '[class*="badge"]',
      '[class*="count"]',
      'span[class*="red"]',
      'div[class*="unread"]',
      '[aria-label*="未读"]',
      '[aria-label*="unread"]'
    ],
    messageListSelectors: [
      '[class*="chat-item"]',
      '[class*="conversation"]',
      '[class*="message-item"]',
      '[role="listitem"]',
      'div[class*="list-item"]'
    ],
    timeSelectors: [
      '[class*="time"]',
      '[class*="timestamp"]',
      'time',
      'span[title*=":"]',
      'div[class*="date"]'
    ],
    unreadMarkerSelectors: [
      '[class*="unread"]',
      '[class*="badge"]',
      '[class*="dot"]',
      'span[class*="red"]',
      'div[style*="background"]'
    ],
    checkStyleBackground: true,
    extractFromTitle: true
  },

  telegram: {
    unreadIndicatorSelectors: [
      '.unread-count',
      '.badge-badge',
      '[class*="unread-count"]',
      '[class*="badge"]',
      '[class*="unread"]'
    ],
    sidebarContainerSelectors: [
      '.chatlist-container',
      '.left-column',
      '#column-left',
      '.chat-list'
    ],
    messageListSelectors: [
      '.chat-item',
      '.ListItem',
      '[class*="chat-item"]',
      '[class*="list-item"]'
    ],
    timeSelectors: [
      '.time',
      '.message-time',
      'time',
      '[class*="time"]'
    ],
    unreadMarkerSelectors: [
      '.unread-count',
      '.badge-badge',
      '[class*="badge"]',
      '[class*="unread"]'
    ],
    checkStyleBackground: false,
    extractFromTitle: true
  }
};

/**
 * 生成通用的消息检查脚本
 * @param {Object} config - 平台配置对象
 * @returns {string} 可执行的 JavaScript 代码字符串
 */
function generateMessageCheckScript(config) {
  const {
    unreadIndicatorSelectors,
    sidebarContainerSelectors,
    messageListSelectors,
    timeSelectors,
    unreadMarkerSelectors,
    checkStyleBackground,
    extractFromTitle
  } = config;

  // 构建选择器字符串
  const unreadSelectorStr = unreadIndicatorSelectors.join(', ');
  const sidebarSelectorStr = sidebarContainerSelectors ? sidebarContainerSelectors.join(', ') : '';
  const listSelectorStr = messageListSelectors.join(', ');
  const timeSelectorStr = timeSelectors ? timeSelectors.join(', ') : '';
  const markerSelectorStr = unreadMarkerSelectors ? unreadMarkerSelectors.join(', ') : '';

  return `
    (function() {
      try {
        let totalUnread = 0;
        let latestTime = null;
        const now = Date.now();
        
        // 辅助函数：解析时间字符串
        function parseTimeString(timeStr) {
          if (!timeStr || timeStr.trim() === '') return null;
          
          try {
            // 尝试直接解析为日期
            let time = new Date(timeStr).getTime();
            if (!isNaN(time) && time > 0) return time;
            
            // 解析相对时间
            const timeText = timeStr.toLowerCase().trim();
            
            // "X分钟前"
            const minutesMatch = timeText.match(/(\\d+)\\s*分钟前/);
            if (minutesMatch) {
              return now - parseInt(minutesMatch[1]) * 60 * 1000;
            }
            
            // "X小时前"
            const hoursMatch = timeText.match(/(\\d+)\\s*小时前/);
            if (hoursMatch) {
              return now - parseInt(hoursMatch[1]) * 60 * 60 * 1000;
            }
            
            // "昨天"
            if (timeText.includes('昨天') || timeText.includes('yesterday')) {
              return now - 24 * 60 * 60 * 1000;
            }
            
            // "今天" 或 "HH:mm" 格式
            const timeMatch = timeText.match(/(\\d{1,2}):(\\d{2})/);
            if (timeMatch) {
              const today = new Date();
              today.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
              const time = today.getTime();
              return time > now ? time - 24 * 60 * 60 * 1000 : time;
            }
          } catch(e) {
            return null;
          }
          
          return null;
        }
        
        // 方法1: 查找未读消息指示器
        ${sidebarSelectorStr ? `
        // 先查找侧边栏容器
        let sidebarContainer = null;
        const sidebarSelectors = '${sidebarSelectorStr}'.split(', ');
        for (const selector of sidebarSelectors) {
          const container = document.querySelector(selector.trim());
          if (container) {
            sidebarContainer = container;
            break;
          }
        }
        
        const searchRoot = sidebarContainer || document;
        const unreadIndicators = searchRoot.querySelectorAll('${unreadSelectorStr}');
        ` : `

        const unreadIndicators = document.querySelectorAll('${unreadSelectorStr}');
        `}
        
        unreadIndicators.forEach(indicator => {
          ${sidebarSelectorStr ? `
  
          if (sidebarContainer && !sidebarContainer.contains(indicator)) {
            return; 
          }
          ` : ''}
          const text = indicator.textContent || indicator.innerText || indicator.getAttribute('aria-label') || '';
          const num = text.match(/\\d+/);
          if (num) {
            totalUnread += parseInt(num[0]);
          }
          ${checkStyleBackground ? `
  
          const style = indicator.getAttribute('style') || '';
          if (style.includes('background') && !text.match(/\\d+/)) {
            totalUnread += 1;
          }` : ''}
        });
        
        // 方法2: 从消息列表中查找未读消息和时间（用于排序）
        const messageItems = document.querySelectorAll('${listSelectorStr}');
        
        messageItems.forEach(item => {
          // 提取时间信息（用于排序）
          ${timeSelectorStr ? `
          const timeElements = item.querySelectorAll('${timeSelectorStr}');
          for (const timeEl of timeElements) {
            const timeStr = timeEl.getAttribute('title') || 
                           timeEl.getAttribute('datetime') || 
                           timeEl.getAttribute('data-time') ||
                           timeEl.textContent || '';
            
            if (timeStr) {
              const parsed = parseTimeString(timeStr);
              if (parsed && (!latestTime || parsed > latestTime)) {
                latestTime = parsed;
              }
            }
            
            // 也尝试从父元素获取
            const parent = timeEl.parentElement;
            if (parent) {
              const parentTimeStr = parent.getAttribute('title') || 
                                   parent.getAttribute('datetime') || 
                                   parent.textContent || '';
              if (parentTimeStr) {
                const parsed = parseTimeString(parentTimeStr);
                if (parsed && (!latestTime || parsed > latestTime)) {
                  latestTime = parsed;
                }
              }
            }
          }
          
          // 如果时间元素中没找到，从整个消息项的文本中提取
          if (!latestTime) {
            const itemText = item.textContent || item.innerText || '';
            const patterns = [
              /(\\d{1,2}):(\\d{2})/,           // HH:mm
              /(\\d+)\\s*分钟前/,              // X分钟前
              /(\\d+)\\s*小时前/               // X小时前
            ];
            
            for (const pattern of patterns) {
              const match = itemText.match(pattern);
              if (match) {
                const parsed = parseTimeString(match[0]);
                if (parsed && (!latestTime || parsed > latestTime)) {
                  latestTime = parsed;
                }
              }
            }
          }` : ''}
          
          ${unreadMarkerSelectors ? `
          // 检查未读标记
          const hasUnreadMarker = item.querySelector('${markerSelectorStr}');
          if (hasUnreadMarker) {
            const text = item.textContent || '';
            const match = text.match(/\\d+/);
            if (match) {
              totalUnread += parseInt(match[0]);
            } else {
              totalUnread += 1;
            }
          }` : ''}
        });
        
        ${extractFromTitle ? `
        // 方法3: 从页面标题提取
        const pageTitle = document.title;
        const titleMatch = pageTitle.match(/\\((\\d+)\\)/);
        if (titleMatch) {
          totalUnread = Math.max(totalUnread, parseInt(titleMatch[1]));
        }` : ''}
        
        return {
          unreadCount: totalUnread,
          latestTime: latestTime,
          totalChats: messageItems.length
        };
      } catch(e) {
        return { unreadCount: 0, latestTime: null, totalChats: 0 };
      }
    })();
  `;
}

/**
 * 根据平台获取对应的消息检查脚本
 * @param {string} platform - 平台名称
 * @returns {string|null} 消息检查脚本或 null（如果平台未配置）
 */
function getMessageCheckScript(platform) {
  const platformLower = (platform || '').toLowerCase();
  const config = PLATFORM_CONFIGS[platformLower];
  return config ? generateMessageCheckScript(config) : null;
}

/**
 * 检查账户的未读消息
 * @param {string} partition - 账户分区标识
 * @param {Function} getAccountByPartition - 获取账户信息的函数
 * @param {Map} browserViews - BrowserView 映射
 * @param {Function} sendToRenderer - 发送消息到渲染进程的函数
 */
async function checkAccountMessages(partition, getAccountByPartition, browserViews, sendToRenderer) {
  try {
    const account = getAccountByPartition(partition);
    if (!account) return;
    
    const platform = (account.platform || '').toLowerCase();
    
    const view = browserViews.get(partition);
    if (!view || !view.webContents) return;
    
    // 尝试获取平台特定的脚本，如果没有配置则跳过
    const script = getMessageCheckScript(platform);
    if (!script) {
      // 对于没有配置的平台，静默跳过
      return;
    }
    
    const result = await view.webContents.executeJavaScript(script);
    
    if (result) {
      // 更新账户的消息信息
      const accounts = store.get('accounts', []);
      const accountIndex = accounts.findIndex(acc => acc.partition === partition);
      
      if (accountIndex !== -1) {
        const oldUnread = accounts[accountIndex].unreadCount || 0;
        const prevLatestTime = accounts[accountIndex].latestMessageTime || 0;
        const newUnread = result.unreadCount || 0;

        accounts[accountIndex].unreadCount = newUnread;
        
        // 更新最新消息时间（用于排序，但不显示）
        // - 优先使用页面解析到的 latestTime
        // - 如果解析不到，但未读数增加，则用 Date.now() 作为兜底，确保“时间优先排序”生效
        const parsedLatestTime = (result.latestTime && result.latestTime > 0) ? result.latestTime : 0;
        let nextLatestTime = prevLatestTime;
        if (parsedLatestTime > 0) {
          nextLatestTime = Math.max(prevLatestTime, parsedLatestTime);
        } else if (newUnread > oldUnread) {
          nextLatestTime = Date.now();
        }
        accounts[accountIndex].latestMessageTime = nextLatestTime;
        accounts[accountIndex].lastChecked = Date.now();
        
        store.set('accounts', accounts);
        
        // 如果未读数有变化或时间有更新，通知渲染进程（时间用于排序但不显示）
        const latestTimeChanged = nextLatestTime !== prevLatestTime;
        if (oldUnread !== newUnread || latestTimeChanged) {
          sendToRenderer('messages-updated', partition, {
            unreadCount: accounts[accountIndex].unreadCount,
            latestTime: accounts[accountIndex].latestMessageTime
          });
        }
      }
    }
  } catch (error) {
    // 静默失败，不影响主流程
  }
}

/**
 * 启动消息检查定时器
 * @param {string} partition - 账户分区标识
 * @param {Function} getAccountByPartition - 获取账户信息的函数
 * @param {Map} browserViews - BrowserView 映射
 * @param {Function} sendToRenderer - 发送消息到渲染进程的函数
 */
function startMessageCheck(partition, getAccountByPartition, browserViews, sendToRenderer, options = {}) {
  // 清除旧的定时器
  stopMessageCheck(partition);
  
  // 立即检查一次
  checkAccountMessages(partition, getAccountByPartition, browserViews, sendToRenderer);
  
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : ACTIVE_CHECK_INTERVAL;
  
  // 定时检查
  const interval = setInterval(() => {
    checkAccountMessages(partition, getAccountByPartition, browserViews, sendToRenderer);
  }, intervalMs);
  
  messageCheckIntervals.set(partition, interval);
}

/**
 * 停止消息检查定时器
 * @param {string} partition - 账户分区标识
 */
function stopMessageCheck(partition) {
  const interval = messageCheckIntervals.get(partition);
  if (interval) {
    clearInterval(interval);
    messageCheckIntervals.delete(partition);
  }
}

/**
 * 停止所有消息检查
 */
function stopAllMessageChecks() {
  messageCheckIntervals.forEach((interval, partition) => {
    stopMessageCheck(partition);
  });
}

module.exports = {
  startMessageCheck,
  stopMessageCheck,
  stopAllMessageChecks,
  CHECK_DELAY,
  ACTIVE_CHECK_INTERVAL,
  INACTIVE_CHECK_INTERVAL
};
