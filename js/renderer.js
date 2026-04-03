/**
 * 渲染进程：账户列表与 UI 交互的状态管理器
 * - 通过 `window.electronAPI` 与主进程通信
 * - 只负责 UI 状态与交互，不直接触碰文件系统/数据库
 */
class AccountManager {
  constructor() {
    this.accounts = [];
    this.currentAccount = null;
    this.currentFilterPlatform = 'whatsapp';
    this.accountStatus = {};
    this.syncStatus = {};
    this.syncStatusEl = null;
    this.syncPartitionState = new Map();
    this.isInitialized = false;
    this.pinnedAccounts = new Set(
      JSON.parse(localStorage.getItem('pinned_accounts') || '[]')
    );
    this.init();
  }

  async init() {
    try {
      if (!window.electronAPI) {
        throw new Error('electronAPI 未定義，請檢查 preload.js 設定');
      }

      if (this.isInitialized) return;

      this.accounts = await window.electronAPI.getAccounts();
      this.accounts.forEach(acc => {
        this.accountStatus[acc.partition] = 'running';
      });

      // Fetch cloud preferences
      const prefs = await window.electronAPI.getPreferences();
      if (prefs) {
        if (prefs.pinnedAccounts) {
          this.pinnedAccounts = new Set(prefs.pinnedAccounts);
          // Sync back to localStorage for offline cache
          localStorage.setItem('pinned_accounts', JSON.stringify([...this.pinnedAccounts]));
        }
        if (prefs.platformOrder) {
          localStorage.setItem('csai_platform_order', JSON.stringify(prefs.platformOrder));
        }
      }

      this.renderAccounts();
      this.bindEvents();
      this.bindPlatformTabs();
      this.setupEventListeners();
      this.setupZoomControls();
      this.setupSyncStatusIndicator();
      this.setupLangSwitcher();
      this.setupPanelResize();
      this.setupRailDrag();
      if (window.i18n) window.i18n.applyTranslations();
      
      // Listen for remote preference updates (from sync-down)
      window.electronAPI.onPreferencesUpdated((newPrefs) => {
        if (newPrefs.pinnedAccounts) {
          this.pinnedAccounts = new Set(newPrefs.pinnedAccounts);
          localStorage.setItem('pinned_accounts', JSON.stringify([...this.pinnedAccounts]));
        }
        if (newPrefs.platformOrder) {
          localStorage.setItem('csai_platform_order', JSON.stringify(newPrefs.platformOrder));
          // Trigger a re-render of the rail if order changed
          this.setupRailDrag(); 
        }
        this.renderAccounts(document.getElementById('search-input')?.value || '');
      });

      this.isInitialized = true;
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errInit') + error.message);
    }
  }

  findAccountByPartition(partition) {
    return this.accounts.find(acc => acc.partition === partition);
  }

  /**
   * Drag-to-resize the account panel.
   * Persists the chosen width in localStorage so it survives restarts.
   * Notifies main process via IPC so the BrowserView bounds update live.
   */
  setupPanelResize() {
    const handle = document.getElementById('panel-resize-handle');
    const panel = document.querySelector('.account-panel');
    if (!handle || !panel) return;

    const STORAGE_KEY = 'csai_panel_width';
    const MIN_W = 160;
    const MAX_W = 420;

    // Restore saved width
    const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (saved && saved >= MIN_W && saved <= MAX_W) {
      panel.style.width = saved + 'px';
      // Tell main process immediately so the BrowserView starts in the right spot
      window.electronAPI?.panelResized?.();
    }

    let startX = 0;
    let startW = 0;
    // rAF-throttle the IPC call so we send at most once per animation frame
    let rafPending = false;
    const notifyMain = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        window.electronAPI?.panelResized?.();
      });
    };

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newW = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
      panel.style.width = newW + 'px';
      notifyMain(); // re-align BrowserView on every drag frame
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('is-resizing');
      const finalW = parseInt(panel.style.width, 10);
      if (finalW) localStorage.setItem(STORAGE_KEY, finalW);
      // One final notification to ensure the BrowserView snaps to the final width
      window.electronAPI?.panelResized?.();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('is-resizing');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  refreshUI() {
    this.renderAccounts();
    this.updatePlatformBadges();
  }

  cleanupDeletedAccountStatus(accounts) {
    const currentPartitions = new Set(accounts.map(acc => acc.partition));
    Object.keys(this.accountStatus).forEach(partition => {
      if (!currentPartitions.has(partition)) {
        delete this.accountStatus[partition];
      }
    });
  }

  initializeAccountStatus(accounts) {
    accounts.forEach(acc => {
      if (!this.accountStatus[acc.partition]) {
        this.accountStatus[acc.partition] = 'running';
      }
    });
  }

  updateCurrentAccountDisplay() {
    if (!this.currentAccount) return;

    const updatedAccount = this.findAccountByPartition(this.currentAccount.partition);
    if (updatedAccount) {
      this.currentAccount = updatedAccount;
      const accountNameEl = document.getElementById('current-account-name');
      if (accountNameEl) {
        accountNameEl.textContent = this.escapeHtml(updatedAccount.name);
      }
    }
  }

  setupEventListeners() {
    window.electronAPI.onAccountsUpdated((accounts) => {
      this.accounts = accounts;
      this.cleanupDeletedAccountStatus(accounts);
      this.initializeAccountStatus(accounts);
      this.updateCurrentAccountDisplay();
      this.refreshUI();
    });

    window.electronAPI.onAccountSwitched((partition) => {
      const account = this.findAccountByPartition(partition);
      if (account) {
        this.currentAccount = account;
        if (!this.accountStatus[partition]) {
          this.accountStatus[partition] = 'running';
        }
        this.updateUIAfterSwitch(account);
        this.renderAccounts();
      }
    });

    window.electronAPI.onMessagesUpdated((partition, messageData) => {
      const account = this.findAccountByPartition(partition);
      if (account) {
        account.unreadCount = messageData.unreadCount || 0;
        if (messageData.latestTime && messageData.latestTime > 0) {
          account.latestMessageTime = messageData.latestTime;
        }
        this.refreshUI();
      }
    });

    window.electronAPI.onAccountCreateError((errorMessage) => {
      this.showError(errorMessage);
    });

    if (window.electronAPI.onSyncStatus) {
      window.electronAPI.onSyncStatus((payload) => {
        this.handleSyncStatus(payload);
      });
    }
  }

  setupSyncStatusIndicator() {
    const el = document.getElementById('sync-status-header');
    if (!el) return;
    el.textContent = window.i18n ? window.i18n.t('syncReady') : 'Sync: Idle';
    this.syncStatusEl = el;
    this.renderSyncStatus();
  }

  handleSyncStatus(payload) {
    if (!payload || payload.direction !== 'down') return;

    const state = payload.state || 'idle';
    const message = payload.message || '';
    const progress = payload.progress;

    this.syncStatus = { state, message, progress };
    this.renderSyncStatus();

    // 账户级同步状态：用于禁用“待同步/同步中”的账户点击
    if (payload.partition) {
      if (state === 'queued' || state === 'syncing') {
        this.syncPartitionState.set(payload.partition, { state, message, progress });
        this.renderAccounts();
      } else if (state === 'done' || state === 'error') {
        // 同步完成/失败后解除禁用，并短暂保留状态提示
        this.syncPartitionState.set(payload.partition, { state, message, progress });
        this.renderAccounts();
        setTimeout(() => {
          // 如果后续又进入 queued/syncing，不要覆盖
          const cur = this.syncPartitionState.get(payload.partition);
          if (cur && (cur.state === 'done' || cur.state === 'error')) {
            this.syncPartitionState.delete(payload.partition);
            this.renderAccounts();
          }
        }, 8000);
      }
    }

    if (payload.blocked && payload.partition) {
      this.showError(message || `账号正在同步：${payload.partition}，请稍后…`);
    }
  }

  isPartitionSyncLocked(partition) {
    const st = this.syncPartitionState.get(partition);
    return st && (st.state === 'queued' || st.state === 'syncing');
  }

  renderSyncStatus() {
    if (!this.syncStatusEl) return;

    const { state, message, progress } = this.syncStatus || {};
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    
    // Update manual sync button state
    const manualSyncBtn = document.getElementById('manual-sync-btn');
    if (manualSyncBtn) {
      if (state === 'syncing') {
        manualSyncBtn.classList.add('syncing');
        manualSyncBtn.disabled = true;
      } else {
        manualSyncBtn.classList.remove('syncing');
        manualSyncBtn.disabled = false;
      }
    }

    if (state === 'syncing') {
      const p = progress && progress.total ? ` (${progress.current}/${progress.total})` : '';
      this.syncStatusEl.textContent = `${_t('syncInProgress')}${p}${message ? ' · ' + message : ''}`;
      this.syncStatusEl.style.color = '#0b6b56';
      return;
    }
    if (state === 'done') {
      this.syncStatusEl.textContent = `${_t('syncDone')}${message ? ' · ' + message : ''}`;
      this.syncStatusEl.style.color = '#0b6b56';
      return;
    }
    if (state === 'error') {
      this.syncStatusEl.textContent = `${_t('syncError')}${message ? ' · ' + message : ''}`;
      this.syncStatusEl.style.color = '#b42318';
      return;
    }

    this.syncStatusEl.textContent = _t('syncReady');
    this.syncStatusEl.style.color = '';
  }

  /**
   * 缩放控件：只更新“显示百分比”，实际缩放由主进程统一对主窗口 + BrowserView 生效。
   */
  async setupZoomControls() {
    const zoomOutBtn = document.getElementById('zoom-out-btn');
    const zoomInBtn = document.getElementById('zoom-in-btn');
    const zoomResetBtn = document.getElementById('zoom-reset-btn');
    const zoomLevelEl = document.getElementById('zoom-level');
    if (!zoomLevelEl) return;

    const updateDisplay = (factor) => {
      zoomLevelEl.textContent = Math.round(factor * 100) + '%';
    };

    window.electronAPI.onZoomChanged((factor) => {
      localStorage.setItem('csai_zoom_factor', factor);
      updateDisplay(factor);
    });

    try {
      const savedZoom = localStorage.getItem('csai_zoom_factor');
      if (savedZoom !== null && !isNaN(parseFloat(savedZoom))) {
        const factor = parseFloat(savedZoom);
        if (window.electronAPI.setZoomFactor) {
          window.electronAPI.setZoomFactor(factor);
        }
        updateDisplay(factor);
      } else {
        const factor = await window.electronAPI.getZoomFactor();
        updateDisplay(factor);
      }
    } catch {
      updateDisplay(1);
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => window.electronAPI.zoomViewOut());
    }
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => window.electronAPI.zoomViewIn());
    }
    if (zoomResetBtn) {
      zoomResetBtn.addEventListener('click', () => window.electronAPI.zoomViewReset());
    }

    // Scrollwheel Zoom (Specific to Zoom Controls: No Ctrl needed)
    const zoomControls = document.getElementById('zoom-controls');
    if (zoomControls) {
      zoomControls.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) {
          window.electronAPI.zoomViewIn();
        } else if (e.deltaY > 0) {
          window.electronAPI.zoomViewOut();
        }
      }, { passive: false });
    }
  }

  bindEvents() {
    try {
      const addAccountBtn = document.getElementById('add-account-btn');
      if (addAccountBtn) {
        addAccountBtn.addEventListener('click', async () => {
          await this.promptPhoneNumberAndCreate(this.currentFilterPlatform);
        });
      }

      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          this.filterAccounts(e.target.value);
        });
      }

      const getStartedBtn = document.querySelector('.btn-get-started');
      if (getStartedBtn) {
        getStartedBtn.addEventListener('click', async () => {
          await this.promptPhoneNumberAndCreate(this.currentFilterPlatform);
        });
      }

      const railLogo = document.querySelector('.rail-brand');
      if (railLogo) {
        railLogo.style.cursor = 'pointer';
        railLogo.addEventListener('click', () => {
          this.goHome();
        });
      }

      const manualSyncBtn = document.getElementById('manual-sync-btn');
      if (manualSyncBtn) {
        manualSyncBtn.addEventListener('click', () => {
          if (window.electronAPI.manualSync) {
            window.electronAPI.manualSync();
          }
        });
      }


    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errBind') + error.message);
    }
  }

  /**
   * Return to the homepage (Hide BrowserView, deselect account)
   */
  goHome() {
    this.currentAccount = null;
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;

    const accountNameEl = document.getElementById('current-account-name');
    if (accountNameEl) {
      accountNameEl.setAttribute('data-i18n', 'selectAccount');
      accountNameEl.textContent = _t('selectAccount');
    }

    // Clear account list highlight
    document.querySelectorAll('.account-item').forEach(item => item.classList.remove('active'));

    const welcomeScreen = document.querySelector('.welcome-screen');
    if (welcomeScreen) {
      welcomeScreen.style.display = 'flex';
    }

    if (window.electronAPI && window.electronAPI.hideBrowserView) {
      window.electronAPI.hideBrowserView();
    }
  }

  /**
   * Set up language switcher buttons (both in login card and main header).
   * Also listens for the 'languageChanged' event to re-apply dynamic text.
   */
  setupLangSwitcher() {
    if (!window.i18n) return;
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const lang = btn.getAttribute('data-lang');
        if (lang) window.i18n.setLanguage(lang);
      });
    });
    // Re-render dynamic content whenever the language changes
    window.addEventListener('languageChanged', () => {
      if (window.i18n) window.i18n.applyTranslations();
      this.renderSyncStatus();
      this.updatePlatformHeader(this.currentFilterPlatform || 'whatsapp');
      // Re-render accounts to ensure all dynamic text (titles, badges, etc.) are updated
      const searchInput = document.getElementById('search-input');
      this.renderAccounts(searchInput?.value || '');
    });
  }

  /**
   * Updates the top label and subtitle of the account panel
   */
  updatePlatformHeader(platform) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    const panelLabel = document.getElementById('panel-platform-label');
    if (panelLabel) {
      // Map platform id to i18n key like platformWechat
      const key = `platform${platform.charAt(0).toUpperCase() + platform.slice(1)}`;
      panelLabel.textContent = _t(key);
    }

    const panelSubtitle = document.getElementById('panel-platform-subtitle');
    if (panelSubtitle) {
      if (platform === 'wechat') {
        panelSubtitle.textContent = _t('wechatSubtitle');
        panelSubtitle.style.display = 'block';
      } else {
        panelSubtitle.style.display = 'none';
      }
    }
  }

  bindPlatformTabs() {
    const tabs = document.querySelectorAll('.platform-tab');
    if (!tabs.length) return;

    // Platform display names for the panel label
    const platformNames = {
      whatsapp: 'WhatsApp',
      instagram: 'Instagram',
      messenger: 'Messenger',
      wechat: 'WeChat',
      telegram: 'Telegram',
    };

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const platform = tab.getAttribute('data-platform') || 'whatsapp';
        this.currentFilterPlatform = platform;

        document.querySelectorAll('.platform-tab').forEach(btn => {
          btn.classList.remove('active');
          btn.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        // Update the platform header (label & subtitle) using i18n
        this.updatePlatformHeader(platform);

        const searchInput = document.getElementById('search-input');
        this.renderAccounts(searchInput?.value || '');
      });
    });
  }
  /**
   * Drag-to-reorder the platform tabs in the rail.
   * Persists the custom order in localStorage.
   */
  setupRailDrag() {
    const rail = document.querySelector('.rail-tabs');
    if (!rail) return;

    const STORAGE_KEY = 'csai_platform_order';

    // Restore saved order
    const savedOrder = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (savedOrder && Array.isArray(savedOrder)) {
      savedOrder.forEach(platform => {
        const tab = rail.querySelector(`[data-platform="${platform}"]`);
        if (tab) rail.appendChild(tab); // re-append in saved order
      });
    }

    let dragSrc = null;

    const getOrder = () =>
      [...rail.querySelectorAll('.platform-tab')].map(t => t.getAttribute('data-platform'));

    rail.querySelectorAll('.platform-tab').forEach(tab => {
      tab.setAttribute('draggable', 'true');

      tab.addEventListener('dragstart', (e) => {
        dragSrc = tab;
        tab.classList.add('drag-src');
        document.body.classList.add('rail-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.getAttribute('data-platform'));
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (tab !== dragSrc) {
          // Remove all over markers then set on this one
          rail.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
          tab.classList.add('drag-over');
        }
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragSrc || dragSrc === tab) return;

        // Insert dragSrc before or after tab depending on position
        const srcRect = dragSrc.getBoundingClientRect();
        const tgtRect = tab.getBoundingClientRect();
        if (srcRect.top < tgtRect.top) {
          tab.after(dragSrc);   // drag down → put after target
        } else {
          tab.before(dragSrc);  // drag up  → put before target
        }

        // Persist
        const order = getOrder();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(order));

        // Sync to cloud
        window.electronAPI.updatePreferences({ platformOrder: order });

        tab.classList.remove('drag-over');
      });

      tab.addEventListener('dragend', () => {
        rail.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
        if (dragSrc) dragSrc.classList.remove('drag-src');
        document.body.classList.remove('rail-dragging');
        dragSrc = null;
      });
    });
  }


  async safeCallAPI(methodName, ...args) {
    try {
      if (!window.electronAPI || typeof window.electronAPI[methodName] !== 'function') {
        const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        throw new Error(_t('errNoMethod').replace('{method}', methodName));
      }
      return await window.electronAPI[methodName](...args);
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errOperation') + error.message);
      throw error;
    }
  }

  // 格式化未读数显示
  formatUnreadCount(count) {
    return count > 99 ? '99+' : count;
  }

  // 账户排序逻辑
  sortAccounts(accounts) {
    return accounts.sort((a, b) => {
      // Pinned accounts always first
      const aPinned = this.pinnedAccounts.has(a.partition) ? 1 : 0;
      const bPinned = this.pinnedAccounts.has(b.partition) ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      // then by latest message time
      const timeA = a.latestMessageTime || 0;
      const timeB = b.latestMessageTime || 0;
      if (timeB !== timeA) return timeB - timeA;
      // then by unread count
      const unreadA = a.unreadCount || 0;
      const unreadB = b.unreadCount || 0;
      if (unreadB !== unreadA) return unreadB - unreadA;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  renderAccounts(filter = '') {
    try {
      const accountList = document.getElementById('account-list');
      if (!accountList) {
        throw new Error('找不到帳戶列表元素 (#account-list)');
      }

      accountList.innerHTML = '';

      const filteredAccounts = this.accounts.filter(account => {
        const nameMatch = account.name.toLowerCase().includes(filter.toLowerCase());
        const platform = (account.platform || 'whatsapp').toLowerCase();
        const platformMatch = platform === this.currentFilterPlatform;
        return nameMatch && platformMatch;
      });

      if (filteredAccounts.length === 0) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'account-item empty';
        const _msg = window.i18n ? window.i18n.t('emptyAccounts') : 'No matching accounts';
        emptyItem.innerHTML = `<div class="empty-message">${_msg}</div>`;
        accountList.appendChild(emptyItem);
        return;
      }

      // 按最新消息时间排序
      const sortedAccounts = this.sortAccounts(filteredAccounts);

      sortedAccounts.forEach(account => {
        const li = this.createAccountItem(account);
        accountList.appendChild(li);
      });

      // 更新平台标签（在渲染完成后）
      this.updatePlatformBadges();
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errRender') + error.message);
    }
  }

  createAccountItem(account) {
    const isCurrent = this.currentAccount?.partition === account.partition;
    const unreadCount = account.unreadCount || 0;
    const syncState = this.syncPartitionState.get(account.partition);
    const locked = this.isPartitionSyncLocked(account.partition);
    const isPinned = this.pinnedAccounts.has(account.partition);
    const syncText = (() => {
      if (!syncState) return '';
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      if (syncState.state === 'queued') return _t('syncQueued');
      if (syncState.state === 'syncing') {
        const p = syncState.progress && syncState.progress.total ? `(${syncState.progress.current}/${syncState.progress.total})` : '';
        return `${_t('syncSyncing')}${p}`;
      }
      if (syncState.state === 'done') return _t('syncDone');
      if (syncState.state === 'error') return _t('syncError');
      return '';
    })();

    const li = document.createElement('li');
    li.className = `account-item${isCurrent ? ' active' : ''}${locked ? ' disabled' : ''}${isPinned ? ' pinned' : ''}`;
    li.setAttribute('role', 'listitem');

    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    li.innerHTML = `
      <div class="account-info">
        <div class="account-avatar">
          ${this.getAvatarText(account.name)}
          ${unreadCount > 0 ? `<span class="unread-badge">${this.formatUnreadCount(unreadCount)}</span>` : ''}
          ${isPinned ? `<span class="pin-badge" title="${_t('pinAccount')}" data-i18n-title="pinAccount">📌</span>` : ''}
        </div>
        <div class="account-details">
          <div class="account-name">
            ${this.escapeHtml(account.name)}
            ${unreadCount > 0 ? '<span class="unread-dot"></span>' : ''}
          </div>
          <div class="account-created">
            ${account.phoneNumber || _t('notSet')}
            ${syncText ? `<span class="account-sync-badge ${syncState?.state || ''}">${syncText}</span>` : ''}
          </div>
        </div>
        <div class="account-meta">
          <button class="inline-btn account-menu-btn" title="${_t('accountOptions')}" data-i18n-title="accountOptions" aria-label="${_t('accountOptions')}" data-i18n-aria="accountOptions" ${locked ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="3" r="1.5"/>
              <circle cx="8" cy="8" r="1.5"/>
              <circle cx="8" cy="13" r="1.5"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    this.bindAccountItemEvents(li, account);
    return li;
  }

  /**
   * 绑定账户项的事件处理器
   * @param {HTMLElement} li - 账户列表项元素
   * @param {Object} account - 账户对象
   */
  bindAccountItemEvents(li, account) {
    // Left-click: switch account (not on the menu button)
    li.addEventListener('click', (e) => {
      if (e.target.closest('.account-menu-btn')) return;
      if (this.isPartitionSyncLocked(account.partition)) {
        const st = this.syncPartitionState.get(account.partition);
        const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        this.showError(st?.state === 'queued' ? _t('errSyncQueued') : _t('errSyncInProgress'));
        return;
      }
      this.switchAccount(account);
    });

    // Right-click: open context menu
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showAccountMenu(li, account);
    });

    // ⋯ button: open context menu
    const menuBtn = li.querySelector('.account-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menuBtn.disabled) return;
        this.showAccountMenu(li, account);
      });
    }
  }

  /**
   * Show a floating context menu for the account item.
   * Reuses a singleton #account-ctx-menu element.
   */
  showAccountMenu(li, account) {
    // Close any existing open menu
    this.closeAccountMenu();

    const locked = this.isPartitionSyncLocked(account.partition);
    const isPinned = this.pinnedAccounts.has(account.partition);
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;

    const menu = document.createElement('div');
    menu.id = 'account-ctx-menu';
    menu.className = 'account-ctx-menu';
    menu.setAttribute('role', 'menu');

    const items = [
      { icon: isPinned ? '📌' : '📌', label: isPinned ? _t('unpinAccount') : _t('pinAccount'), action: 'pin', danger: false },
      { icon: '✏️', label: _t('renameTitle'), action: 'rename', danger: false, disabled: locked },
      { icon: '🔄', label: _t('refreshTitle'), action: 'refresh', danger: false, disabled: locked },
      { icon: '🗑️', label: _t('deleteTitle'), action: 'delete', danger: true, disabled: locked },
    ];

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`;
      btn.setAttribute('role', 'menuitem');
      btn.innerHTML = `<span class="ctx-icon">${item.icon}</span><span>${item.label}</span>`;
      if (!item.disabled) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeAccountMenu();
          if (item.action === 'pin') {
            if (isPinned) {
              this.pinnedAccounts.delete(account.partition);
            } else {
              this.pinnedAccounts.add(account.partition);
            }
            const pinnedList = [...this.pinnedAccounts];
            localStorage.setItem('pinned_accounts', JSON.stringify(pinnedList));
            
            // Sync to cloud
            window.electronAPI.updatePreferences({ pinnedAccounts: pinnedList });

            this.renderAccounts(document.getElementById('search-input')?.value || '');
          } else if (item.action === 'rename') {
            this.renameAccount(account);
          } else if (item.action === 'refresh') {
            this.safeCallAPI('refreshAccount', account.partition);
          } else if (item.action === 'delete') {
            this.deleteAccount(account);
          }
        });
      }
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    // Position below the li item
    const rect = li.getBoundingClientRect();
    const menuW = 180;
    let left = rect.right - menuW;
    let top = rect.bottom + 4;
    if (left < 4) left = 4;
    if (top + 180 > window.innerHeight) top = rect.top - 180;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // Animate in
    requestAnimationFrame(() => menu.classList.add('open'));

    // Close on outside click / Escape
    this._menuCloseHandler = (e) => {
      if (!menu.contains(e.target)) this.closeAccountMenu();
    };
    this._menuKeyHandler = (e) => {
      if (e.key === 'Escape') this.closeAccountMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', this._menuCloseHandler);
      document.addEventListener('keydown', this._menuKeyHandler);
    }, 0);
  }

  closeAccountMenu() {
    const existing = document.getElementById('account-ctx-menu');
    if (existing) existing.remove();
    if (this._menuCloseHandler) document.removeEventListener('click', this._menuCloseHandler);
    if (this._menuKeyHandler) document.removeEventListener('keydown', this._menuKeyHandler);
  }

  /**
   * 获取账户头像文本（首字母）
   * @param {string} name - 账户名称
   * @returns {string} 首字母大写
   */
  getAvatarText(name) {
    return name.charAt(0).toUpperCase();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }



  updatePlatformBadges() {
    // 更新平台标签的未读消息提示
    const platformTabs = document.querySelectorAll('.platform-tab');
    platformTabs.forEach(tab => {
      const platform = tab.getAttribute('data-platform');
      if (!platform) return;

      // 计算该平台“有未读的账号数”
      // 注意：这里不是未读消息总数，而是 unreadCount > 0 的账号数量
      const unreadAccountCount = this.accounts
        .filter(acc => acc.platform === platform)
        .filter(acc => (acc.unreadCount || 0) > 0)
        .length;

      // 移除旧的提示
      const oldBadge = tab.querySelector('.platform-unread-badge');
      if (oldBadge) oldBadge.remove();

      // 添加新的提示
      if (unreadAccountCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'platform-unread-badge';
        badge.textContent = this.formatUnreadCount(unreadAccountCount);
        tab.appendChild(badge);
      }
    });
  }

  filterAccounts(searchTerm) {
    this.renderAccounts(searchTerm);
  }

  async switchAccount(account) {
    if (this.isLoading) return;

    try {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.setLoading(true, _t('switchingAccount'));
      this.currentAccount = account;
      await this.safeCallAPI('switchAccount', account.partition);
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errSwitchAccount') + error.message);
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * 更新账户列表的高亮状态
   * @param {Object} account - 当前账户对象
   */
  updateAccountListHighlight(account) {
    document.querySelectorAll('.account-item').forEach(item => {
      const nameElement = item.querySelector('.account-name');
      if (nameElement?.textContent === account.name) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  /**
   * 切换账户后更新 UI
   * @param {Object} account - 账户对象
   */
  updateUIAfterSwitch(account) {
    try {
      const accountNameEl = document.getElementById('current-account-name');
      if (accountNameEl) {
        accountNameEl.removeAttribute('data-i18n');
        accountNameEl.textContent = this.escapeHtml(account.name);
      }

      this.updateAccountListHighlight(account);
      this.updateLoadingStatus('loaded');
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errUIUpdate') + error.message);
    }
  }

  updateLoadingStatus(status) {
    const welcomeScreen = document.querySelector('.welcome-screen');
    if (!welcomeScreen) return;

    if (status === 'loaded') {
      welcomeScreen.style.display = 'none';
    }
  }

  /**
   * 通用模态对话框函数
   * @param {Object} options - 对话框配置选项
   * @param {string} options.title - 对话框标题
   * @param {string} options.description - 对话框描述
   * @param {string} options.inputType - 输入框类型 ('tel' | 'text')
   * @param {string} options.placeholder - 输入框占位符
   * @param {number} options.maxLength - 最大长度
   * @param {string} options.initialValue - 初始值
   * @param {Function} options.validator - 验证函数，返回错误消息或 null
   * @param {Function} options.onConfirm - 确认回调函数
   * @returns {Promise<string|null>} 返回输入值或 null（取消时）
   */
  showModalDialog(options) {
    return new Promise((resolve) => {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      const {
        title = _t('phoneDialogTitle'),
        description = '',
        // Name field options
        showName = false,
        nameLabel = _t('accountNameLabel'),
        namePlaceholder = _t('accountNamePlaceholder'),
        initialName = '',
        // Identifier field options
        showIdentifier = true,
        identifierLabel = _t('phoneDialogPlaceholder'),
        identifierType = 'text',
        identifierPlaceholder = '',
        initialIdentifier = '',
        identifierMaxLength = 50,
        // Common
        validator = null,
        onConfirm = null
      } = options;

      const dialog = document.getElementById('phone-dialog');
      const titleEl = document.getElementById('phone-dialog-title');
      const descriptionEl = document.getElementById('phone-dialog-description');

      const nameInput = document.getElementById('phone-dialog-name');
      const nameGroup = nameInput?.closest('.modal-input-group');

      const identifierInput = document.getElementById('phone-dialog-input');
      const identifierGroup = identifierInput?.closest('.modal-input-group');
      const identifierLabelEl = document.getElementById('phone-dialog-input-label');

      const error = document.getElementById('phone-dialog-error');
      const confirmBtn = document.getElementById('phone-dialog-confirm');
      const cancelBtn = document.getElementById('phone-dialog-cancel');
      const closeBtn = document.getElementById('phone-dialog-close');

      // 初始化按钮状态
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = _t('confirmBtn') || 'Confirm';
      }

      // 初始化对话框内容
      titleEl.textContent = title;
      descriptionEl.textContent = description;

      // Name field
      if (nameGroup) {
        nameGroup.style.display = showName ? 'block' : 'none';
        nameInput.value = initialName;
        nameInput.placeholder = namePlaceholder;
      }

      // Identifier field
      if (identifierGroup) {
        identifierGroup.style.display = showIdentifier ? 'block' : 'none';
        identifierInput.type = identifierType;
        identifierInput.placeholder = identifierPlaceholder || identifierLabel;
        identifierInput.maxLength = identifierMaxLength;
        identifierInput.value = initialIdentifier;
        if (identifierLabelEl) identifierLabelEl.textContent = identifierLabel;
        if (identifierType === 'tel') {
          const handlePhoneInput = function () {
            this.value = this.value.replace(/\D/g, '');
          };
          identifierInput.removeEventListener('input', handlePhoneInput); // avoid duplicates if possible, though anonymous won't remove. Actually let's just do it directly.
          identifierInput.addEventListener('input', function () {
            this.value = this.value.replace(/\D/g, '');
          });
        }
      }

      error.style.display = 'none';
      error.textContent = '';

      // 显示对话框前，隐藏 BrowserView
      updateBrowserViewVisibility();

      // Prepare fields for the top-layer overlay
      const fields = [];
      if (showName) {
        fields.push({ id: 'name', label: nameLabel, placeholder: namePlaceholder, value: initialName });
      }
      if (showIdentifier) {
        fields.push({ id: 'identifier', label: identifierLabel, placeholder: identifierPlaceholder, value: initialIdentifier, type: identifierType });
      }

      // Show top-layer overlay
      window.electronAPI.showSystemOverlay({
        type: 'modal',
        title,
        description,
        fields,
        confirmText: _t('confirmBtn') || 'Confirm',
        cancelText: _t('cancelBtn') || 'Cancel'
      });

      // Handle response
      window.electronAPI.onSystemOverlayResponse(async (response) => {
        if (!response.confirmed) {
          window.electronAPI.hideSystemOverlay();
          resolve(null);
          return;
        }

        const { results } = response;
        const nameValue = (results.name || '').trim();
        const identifierValue = (results.identifier || '').trim();

        // 验证输入
        if (validator) {
          const errorMsg = validator(nameValue, identifierValue);
          if (errorMsg) {
            // If validation fails, we need to show error on the overlay.
            // For now, we'll hide overlay and show error alert, then resolve null.
            // Ideally we'd send error back to overlay, but that requires more IPC complexity.
            window.electronAPI.hideSystemOverlay();
            this.showError(errorMsg);
            resolve(null);
            return;
          }
        }

        if (onConfirm) {
          try {
            // onConfirm will likely call setLoading(true), which shows the loading overlay
            await onConfirm(nameValue, identifierValue);
            // If onConfirm succeeds, it will call setLoading(false) which hides overlay
            resolve({ name: nameValue, identifier: identifierValue });
          } catch (err) {
            window.electronAPI.hideSystemOverlay();
            this.showError(err.message || _t('errOperation'));
            resolve(null);
          }
        } else {
          window.electronAPI.hideSystemOverlay();
          resolve({ name: nameValue, identifier: identifierValue });
        }
      });
    });
  }

  /**
   * 显示确认对话框 (Top Layer)
   * @param {string} message - 消息内容
   * @param {boolean} showCancel - 是否显示取消按钮 (default: true)
   * @returns {Promise<boolean>}
   */
  showConfirmDialog(message, showCancel = true) {
    return new Promise((resolve) => {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;

      window.electronAPI.showSystemOverlay({
        type: 'confirm',
        title: _t('confirmTitle') || 'Confirm',
        text: message,
        showCancel: showCancel
      });

      window.electronAPI.onSystemOverlayResponse((result) => {
        window.electronAPI.hideSystemOverlay();
        resolve(result.confirmed);
      });
    });
  }

  /**
   * 重命名账户
   * @param {Object} account - 账户对象
   */
  async renameAccount(account) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    const platformLower = (account.platform || 'whatsapp').toLowerCase();

    let identifierLabel = _t('phoneDialogPlaceholder');
    let identifierPlaceholder = _t('phoneNumberPlaceholder');
    let identifierType = 'tel';

    if (platformLower === 'instagram') {
      identifierLabel = _t('instagramUsernameLabel');
      identifierPlaceholder = _t('instagramUsernameLabel');
      identifierType = 'text';
    } else if (platformLower === 'messenger') {
      identifierLabel = _t('facebookUsernameLabel');
      identifierPlaceholder = _t('facebookUsernameLabel');
      identifierType = 'text';
    }

    await this.showModalDialog({
      title: _t('renameModalTitle'),
      description: _t('renameModalDesc'),
      showName: true,
      initialName: account.name || '',
      showIdentifier: true,
      identifierLabel: identifierLabel,
      identifierPlaceholder: identifierPlaceholder,
      identifierType: identifierType,
      initialIdentifier: account.phoneNumber || '',
      validator: (name, identifier) => {
        if (!name) return _t('renameModalErrEmpty');
        if (name.length > 50) return _t('renameModalErrLong');

        // Identifier validation
        if (identifier && identifierType === 'tel') {
          const cleaned = identifier.replace(/\D/g, '');
          if (cleaned.length < 8 || cleaned.length > 15) return _t('createModalErrInvalid');
        }
        return null;
      },
      onConfirm: async (newName, newIdentifier) => {
        try {
          this.setLoading(true, _t('renamingAccount'));
          const result = await this.safeCallAPI('renameAccount', account.partition, newName, newIdentifier);
          if (result && !result.success) {
            throw new Error(result.message || _t('errRenameAccount'));
          }
        } finally {
          this.setLoading(false);
        }
      }
    });
  }

  async deleteAccount(account) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    try {
      const msg = _t('deleteConfirm').replace('{name}', account.name);
      const confirmed = await this.showConfirmDialog(msg);

      if (confirmed) {
        this.setLoading(true, _t('deletingAccount'));
        await this.safeCallAPI('removeAccount', account.partition);
        delete this.accountStatus[account.partition];

        if (this.currentAccount?.partition === account.partition) {
          this.currentAccount = null;
          const accountNameEl = document.getElementById('current-account-name');
          if (accountNameEl) {
            accountNameEl.setAttribute('data-i18n', 'selectAccount');
            accountNameEl.textContent = _t('selectAccount');
          }

          const welcomeScreen = document.querySelector('.welcome-screen');
          if (welcomeScreen) {
            welcomeScreen.style.display = 'flex';
          }
        }
      }
    } catch (error) {
      const _t2 = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t2('errDeleteAccount') + error.message);
    } finally {
      this.setLoading(false);
    }
  }

  async showError(message) {
    try {
      await this.showConfirmDialog(message, false);
    } catch (e) {
      console.error('Error showing error dialog:', e);
    }
  }

  /**
   * 设置加载状态
   * @param {boolean} loading - 是否加载中
   * @param {string} text - 加载文本
   */
  setLoading(loading, text) {
    if (text === undefined) {
      text = window.i18n ? window.i18n.t('loading') : 'Processing...';
    }
    this.isLoading = loading;
    const overlay = document.getElementById('loading-overlay');
    const loadingText = overlay?.querySelector('.loading-text');

    if (overlay) {
      overlay.style.display = loading ? 'flex' : 'none';
      if (loadingText && loading) {
        loadingText.textContent = text;
      }
      updateBrowserViewVisibility();
    }

    // Top-layer overlay for BrowserView coverage
    if (loading) {
      window.electronAPI.showSystemOverlay({ type: 'loading', text });
    } else {
      window.electronAPI.hideSystemOverlay();
    }
  }

  /**
   * 弹出手机号输入对话框并创建账户
   * @param {string} platform - 平台名称
   */
  async promptPhoneNumberAndCreate(platform) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    const platformLower = (platform || 'whatsapp').toLowerCase();
    const platformUpper = platformLower.toUpperCase();

    let identifierLabel = _t('phoneDialogPlaceholder');
    let identifierPlaceholder = _t('phoneNumberPlaceholder');
    let identifierType = 'tel';

    if (platformLower === 'instagram') {
      identifierLabel = _t('instagramUsernameLabel');
      identifierPlaceholder = _t('instagramUsernameLabel');
      identifierType = 'text';
    } else if (platformLower === 'messenger') {
      identifierLabel = _t('facebookUsernameLabel');
      identifierPlaceholder = _t('facebookUsernameLabel');
      identifierType = 'text';
    }

    await this.showModalDialog({
      title: `${platformUpper}`,
      description: _t('createModalDesc'),
      showName: true,
      initialName: '',
      showIdentifier: true,
      identifierLabel: identifierLabel,
      identifierPlaceholder: identifierPlaceholder,
      identifierType: identifierType,
      validator: (name, identifier) => {
        if (!name) return _t('nameRequiredErr');

        // Identifier is optional, but if provided, validate it if it's a phone number
        if (identifier && identifierType === 'tel') {
          const cleaned = identifier.replace(/\D/g, '');
          if (cleaned.length < 8 || cleaned.length > 15) return _t('createModalErrInvalid');
        }
        return null;
      },
      onConfirm: async (name, identifier) => {
        try {
          this.setLoading(true, _t('creatingAccount'));
          const result = await this.safeCallAPI('createNewAccount', platform, identifier, name);
          if (result && !result.success) {
            throw new Error(result.message || _t('errOperation'));
          } else if (result && result.success && result.accounts) {
            this.accounts = result.accounts;
            this.initializeAccountStatus(result.accounts);
            this.refreshUI();
          }
        } finally {
          this.setLoading(false);
        }
      }
    });
  }
}

/**
* 更新 BrowserView 的可见性。
* 如果 loading overlay 或任何模态对话框显示，则隐藏 BrowserView。
*/
function updateBrowserViewVisibility() {
  if (!window.electronAPI) return;

  const loadingOverlay = document.getElementById('loading-overlay');
  const isLoadingVisible = loadingOverlay && loadingOverlay.style.display === 'flex';

  const phoneDialog = document.getElementById('phone-dialog');
  const isPhoneDialogOpen = phoneDialog && phoneDialog.style.display === 'flex';

  const confirmDialog = document.getElementById('confirm-dialog');
  const isConfirmDialogOpen = confirmDialog && confirmDialog.style.display === 'flex';

  const legalDialog = document.getElementById('legal-dialog');
  const isLegalDialogOpen = legalDialog && legalDialog.style.display === 'flex';

  const startupTerms = document.getElementById('startup-terms-screen');
  const isStartupTermsOpen = startupTerms && startupTerms.style.display === 'flex';

  if (isLoadingVisible || isPhoneDialogOpen || isConfirmDialogOpen || isLegalDialogOpen || isStartupTermsOpen) {
    if (window.electronAPI.hideBrowserView) window.electronAPI.hideBrowserView();
  } else {
    const loginScreen = document.querySelector('.login-screen');
    const isLoginVisible = loginScreen && loginScreen.style.display !== 'none';
    // Only show BrowserView if we are NOT on the login screen
    if (!isLoginVisible && window.electronAPI.showBrowserView) {
      window.electronAPI.showBrowserView();
    }
  }
}

function startApp() {
  try {
    new AccountManager();
  } catch (error) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    document.body.innerHTML = `<div style="padding: 20px; color: red;">${_t('errAppInit')}${error.message}</div>`;
  }
}

/**
 * Set up zoom controls for the login screen
 */
function setupLoginZoomControls() {
  const loginZoomOutBtn = document.getElementById('login-zoom-out');
  const loginZoomInBtn = document.getElementById('login-zoom-in');
  const loginZoomResetBtn = document.getElementById('login-zoom-reset');
  const loginZoomLevelEl = document.getElementById('login-zoom-level');

  if (!loginZoomLevelEl) return;

  const updateLoginZoomDisplay = (factor) => {
    loginZoomLevelEl.textContent = Math.round(factor * 100) + '%';
  };

  // Listen for zoom changes from the main process
  if (window.electronAPI?.onZoomChanged) {
    window.electronAPI.onZoomChanged((factor) => {
      localStorage.setItem('csai_zoom_factor', factor);
      updateLoginZoomDisplay(factor);
    });
  }

  // Get initial zoom factor
  if (window.electronAPI?.getZoomFactor) {
    const savedZoom = localStorage.getItem('csai_zoom_factor');
    if (savedZoom !== null && !isNaN(parseFloat(savedZoom))) {
      const factor = parseFloat(savedZoom);
      if (window.electronAPI.setZoomFactor) {
        window.electronAPI.setZoomFactor(factor);
      }
      updateLoginZoomDisplay(factor);
    } else {
      window.electronAPI.getZoomFactor()
        .then(factor => updateLoginZoomDisplay(factor))
        .catch(() => updateLoginZoomDisplay(1));
    }
  } else {
    updateLoginZoomDisplay(1);
  }

  // Bind zoom control events
  if (loginZoomOutBtn && window.electronAPI?.zoomViewOut) {
    loginZoomOutBtn.addEventListener('click', () => window.electronAPI.zoomViewOut());
  }
  if (loginZoomInBtn && window.electronAPI?.zoomViewIn) {
    loginZoomInBtn.addEventListener('click', () => window.electronAPI.zoomViewIn());
  }
  if (loginZoomResetBtn && window.electronAPI?.zoomViewReset) {
    loginZoomResetBtn.addEventListener('click', () => window.electronAPI.zoomViewReset());
  }

  // Scrollwheel Zoom Over Login Zoom Controls (No Ctrl needed)
  const loginZoomControls = document.getElementById('login-zoom-controls');
  if (loginZoomControls && window.electronAPI?.zoomViewIn && window.electronAPI?.zoomViewOut) {
    loginZoomControls.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        window.electronAPI.zoomViewIn();
      } else if (e.deltaY > 0) {
        window.electronAPI.zoomViewOut();
      }
    }, { passive: false });
  }
}

function initLoginFlow() {
  const loginScreen = document.querySelector('.login-screen');
  const appRoot = document.querySelector('.app');
  const loadingOverlay = document.getElementById('loading-overlay');

  // Ensure window has focus
  if (window.focus) window.focus();

  // Auto-focus username with a slightly longer delay and retry if needed
  const ensureFocus = () => {
    if (usernameInput) {
      usernameInput.focus();
      // Fallback for some environments
      if (document.activeElement !== usernameInput) {
        setTimeout(() => {
          if (usernameInput) {
            usernameInput.focus();
            if (document.activeElement !== usernameInput) {
              usernameInput.click(); // Sometimes click helps
            }
          }
        }, 100);
      }
    }
  };

  const form = document.getElementById('login-form');
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');
  const showRegister = document.getElementById('show-register');
  const showForgot = document.getElementById('show-forgot');
  const registerForm = document.getElementById('register-form');
  const forgotForm = document.getElementById('forgot-form');

  // ── Session-based Auto-Login ─────────────────────────────────────────
  // Session is valid if:
  //   1. csai_session_expiry exists and is in the future
  //   2. csai_saved_username & csai_saved_password exist
  const SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
  const SESSION_KEY = 'csai_session_expiry';
  const savedUsername = localStorage.getItem('csai_saved_username');
  const savedPassword = localStorage.getItem('csai_saved_password');
  const sessionExpiry = parseInt(localStorage.getItem(SESSION_KEY) || '0', 10);
  const sessionValid = savedUsername && savedPassword && Date.now() < sessionExpiry;

  if (sessionValid) {
    // Skip login page entirely — show loading overlay instead
    if (loginScreen) loginScreen.style.display = 'none';
    if (appRoot) appRoot.style.display = 'flex';

    // Show loading while we silently authenticate
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = loadingOverlay?.querySelector('.loading-text');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'flex';
      if (loadingText) loadingText.textContent = window.i18n ? window.i18n.t('loading') : 'Loading...';
    }

    (async () => {
      try {
        const result = await window.electronAPI.login(savedUsername, savedPassword);
        if (result && result.success) {
          // Refresh session expiry on successful re-authentication
          localStorage.setItem(SESSION_KEY, Date.now() + SESSION_DURATION_MS);
          if (loadingOverlay) loadingOverlay.style.display = 'none';
          stopCarousel();
          startApp();
          return;
        }
      } catch { }
      // If silent login fails, clear the session and show the login page
      localStorage.removeItem(SESSION_KEY);
      if (appRoot) appRoot.style.display = 'none';
      if (loginScreen) loginScreen.style.display = 'flex';
      if (loadingOverlay) loadingOverlay.style.display = 'none';
    })();
    return; // Don't set up the rest of the login form yet — it will be set up only if silent login fails
  }

  if (!loginScreen || !appRoot || !form || !usernameInput || !passwordInput || !submitBtn) {
    // 如果登入元件不存在，直接進入主應用（兼容舊版）
    appRoot.style.display = 'flex';
    stopCarousel();
    startApp();
    return;
  }

  const showError = (msg) => {
    if (!errorEl) return;
    errorEl.textContent = msg || '';
    if (msg) {
      errorEl.classList.add('show');
      errorEl.classList.remove('none');
    }
    else {
      errorEl.classList.remove('show');
      errorEl.classList.add('none');
    }
  };

  const showSuccess = (msg) => {
    const successEl = document.getElementById('login-success');
    if (!successEl) return;
    successEl.textContent = msg || '';
    if (msg) {
      successEl.classList.add('show');
      successEl.classList.remove('none');
    } else {
      successEl.classList.remove('show');
      successEl.classList.add('none');
    }
  };

  const clearMessages = () => {
    showError('');
    showSuccess('');
    const errorReg = document.getElementById('register-error');
    if (errorReg) errorReg.style.display = 'none';
    const forgotErrorEl = document.getElementById('forgot-error');
    if (forgotErrorEl) forgotErrorEl.style.display = 'none';
  };

  // Setup password visibility toggles
  const toggleBtns = document.querySelectorAll('.password-toggle-btn');
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = btn.previousElementSibling;
      if (input && input.tagName === 'INPUT') {
        if (input.type === 'password') {
          input.type = 'text';
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eye-off-icon"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
        } else {
          input.type = 'password';
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        }
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;

    if (!username || !password) {
      showError(_t('loginErrEmpty'));
      return;
    }

    showError('');
    submitBtn.disabled = true;
    submitBtn.textContent = _t('loggingIn');

    try {
      const result = await window.electronAPI.login(username, password);
      if (!result?.success) {
        showError(_t(result?.message) || _t('loginErrFailed'));
        submitBtn.disabled = false;
        submitBtn.textContent = _t('loginBtn');
        return;
      }

      // Save credentials and set 5-day session expiry
      localStorage.setItem('csai_saved_username', username);
      localStorage.setItem('csai_saved_password', password);
      localStorage.setItem('csai_session_expiry', Date.now() + 5 * 24 * 60 * 60 * 1000);

      loginScreen.style.display = 'none';
      appRoot.style.display = 'flex';
      startApp();
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      showError(_t('loginErrRetry'));
      submitBtn.disabled = false;
    }
  });

  const globalBackContainer = document.getElementById('global-back-btn-container');
  const showGlobalBack = () => {
    if (globalBackContainer) globalBackContainer.style.display = 'flex';
  };
  const hideGlobalBack = () => {
    if (globalBackContainer) globalBackContainer.style.display = 'none';
  };

  if (showRegister) {
    showRegister.addEventListener('click', (e) => {
      e.preventDefault();
      clearMessages();
      form.style.display = 'none';
      if (registerForm) registerForm.style.display = 'flex';
      showGlobalBack();
    });
  }

  if (showForgot) {
    showForgot.addEventListener('click', (e) => {
      e.preventDefault();
      clearMessages();
      form.style.display = 'none';
      if (forgotForm) forgotForm.style.display = 'flex';
      showGlobalBack();
    });
  }

  const handleBackToLogin = (e) => {
    if (e) e.preventDefault();
    clearMessages();
    if (registerForm) {
      registerForm.reset();
      registerForm.style.display = 'none';
    }
    if (forgotForm) {
      forgotForm.reset();
      forgotForm.style.display = 'none';
    }
    form.style.display = 'flex';
    hideGlobalBack();
    setTimeout(() => usernameInput.focus(), 50);
  };

  const backToLogin = document.getElementById('back-to-login');
  if (backToLogin) backToLogin.addEventListener('click', handleBackToLogin);

  const backToLogin2 = document.getElementById('back-to-login-2');
  if (backToLogin2) backToLogin2.addEventListener('click', handleBackToLogin);

  const globalBackBtn = document.getElementById('global-back-btn');
  if (globalBackBtn) globalBackBtn.addEventListener('click', handleBackToLogin);

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const fullName = document.getElementById('reg-fullname').value.trim();
      const email = document.getElementById('reg-email').value.trim();
      const username = document.getElementById('reg-username').value.trim();
      const password = document.getElementById('reg-password').value;
      const confirm = document.getElementById('reg-confirm-password').value;

      const errorReg = document.getElementById('register-error');
      const showRegError = (msg) => {
        errorReg.style.display = 'flex';
        if (!errorReg) return;
        errorReg.textContent = msg || '';
        if (msg) errorReg.classList.add('show');
        else errorReg.classList.remove('show');
      };

      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;

      const isStrongPassword = (pw) => {
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/.test(pw);
      };

      if (!fullName || !email || !username || !password) {
        showRegError(_t('registerErrEmpty'));
        return;
      }

      if (!isStrongPassword(password)) {
        showRegError(_t('registerErrPasswordWeak'));
        return;
      }

      // Client-side: username and email must not be the same
      if (username.toLowerCase() === email.toLowerCase()) {
        showRegError(_t('registerErrUsernameSameAsEmail'));
        return;
      }

      if (password !== confirm) {
        showRegError(_t('registerErrMismatch'));
        return;
      }

      try {
        const result = await window.electronAPI.register({
          fullName,
          email,
          username,
          password
        });

        if (!result || result.success === false) {
          // Map server-side duplicate errors to translated messages
          const msg = result?.message || '';
          // If the message itself is a translation key (e.g. registerErrDuplicateUsername), t() will return translated text.
          // Otherwise fall back to a generic error.
          showRegError(_t(msg) || _t('registerErrFailed'));
          return;
        }

        // Success
        registerForm.reset();
        registerForm.style.display = 'none';
        form.style.display = 'flex';
        hideGlobalBack();

        showSuccess(_t('registerSuccess'));
        setTimeout(() => usernameInput.focus(), 50);

      } catch (err) {
        const _t2 = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        showRegError(_t2('registerErrRetry'));
      }
    });
  }

  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const forgotEmail = document.getElementById('forgot-email').value.trim();

      const forgotErrorEl = document.getElementById('forgot-error');

      const showForgotMessage = (msg, type = "error") => {
        if (!forgotErrorEl) return;

        if (!msg) {
          forgotErrorEl.classList.remove("show", "login-error", "login-success", "login-warning");
          forgotErrorEl.style.display = "none";
          return;
        }

        forgotErrorEl.style.display = "";
        forgotErrorEl.textContent = msg;
        forgotErrorEl.classList.add("show");

        forgotErrorEl.classList.remove("login-error", "login-success", "login-warning");
        if (type === "success") forgotErrorEl.classList.add("login-success");
        else if (type === "warning") forgotErrorEl.classList.add("login-warning");
        else forgotErrorEl.classList.add("login-error");
      };

      try {
        const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        showForgotMessage(_t('forgotWait'), 'warning');

        const forgotBtn = forgotForm.querySelector('button[type="submit"]');
        const originalBtnText = _t('forgotSubmitBtn') || "Reset Password";
        let isDone = false;
        let cooldownTimeout = null;

        if (forgotBtn) {
          forgotBtn.disabled = true;
          forgotBtn.textContent = "Sending...";

          cooldownTimeout = setTimeout(() => {
            if (!isDone) {
              isDone = true;
              forgotBtn.disabled = false;
              forgotBtn.textContent = originalBtnText;
            }
          }, 60000);
        }

        const result = await window.electronAPI.resetPassword({
          forgotEmail
        });

        if (forgotBtn && !isDone) {
          isDone = true;
          clearTimeout(cooldownTimeout);
          forgotBtn.disabled = false;
          forgotBtn.textContent = originalBtnText;
        }

        if (!result || result.error) {
          showForgotMessage(result?.message || _t('forgotErrEmail'), 'error');
          return;
        }

        showForgotMessage(_t('forgotSuccess'), 'success');

      } catch (err) {
        const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        const forgotBtn = forgotForm.querySelector('button[type="submit"]');
        if (forgotBtn) {
          forgotBtn.disabled = false;
          forgotBtn.textContent = _t('forgotSubmitBtn') || "Reset Password";
        }
        showForgotMessage(_t('forgotErrEmail'), 'error');
      }
    });
  }

  // 預設聚焦帳號輸入框
  // Initial focus
  setTimeout(() => ensureFocus(), 100);

  // Setup zoom controls for login screen
  setupLoginZoomControls();

  // Setup carousel
  initCarousel();
}

function initLegalDialog() {
  const termsBtn = document.getElementById('btn-terms');
  const privacyBtn = document.getElementById('btn-privacy');
  const legalDialog = document.getElementById('legal-dialog');
  const legalCloseBtn = document.getElementById('legal-dialog-close');
  const legalTabTerms = document.getElementById('legal-tab-terms');
  const legalTabPrivacy = document.getElementById('legal-tab-privacy');
  const legalTermsContent = document.getElementById('legal-terms-content');
  const legalPrivacyContent = document.getElementById('legal-privacy-content');
  const legalZoomOutBtn = document.getElementById('legal-zoom-out');
  const legalZoomInBtn = document.getElementById('legal-zoom-in');
  const legalZoomResetBtn = document.getElementById('legal-zoom-reset');
  const legalZoomLevelEl = document.getElementById('legal-zoom-level');
  const legalModalBody = document.querySelector('.legal-modal-body');

  let legalZoomFactor = 1;
  let legalDialogRequestId = null;
  const LEGAL_ZOOM_MIN = 0.5;
  const LEGAL_ZOOM_MAX = 3;
  const LEGAL_ZOOM_STEP = 0.1;
  let legalKeydownHandler = null;

  const applyLegalZoom = (factor) => {
    if (!legalModalBody) return;
    legalZoomFactor = Math.max(LEGAL_ZOOM_MIN, Math.min(LEGAL_ZOOM_MAX, factor));
    legalModalBody.style.zoom = legalZoomFactor;
    if (legalZoomLevelEl) {
      legalZoomLevelEl.textContent = Math.round(legalZoomFactor * 100) + '%';
    }
  };

  const initLegalZoom = () => {
    legalZoomFactor = 1;
    applyLegalZoom(legalZoomFactor);
  };

  const fetchLegalContent = async (url, targetEl) => {
    if (targetEl.dataset.loaded) return;
    try {
      const response = await fetch(url);
      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const container = doc.querySelector('.container');
      if (container) {
        const h1 = container.querySelector('h1');
        if (h1) h1.remove();
        const subtitle = container.querySelector('.subtitle');
        if (subtitle) subtitle.remove();
        const footer = container.querySelector('.footer');
        if (footer) footer.remove();

        targetEl.innerHTML = container.innerHTML;
        targetEl.dataset.loaded = 'true';
      }
    } catch (e) {
      targetEl.innerHTML = '<p style="color:red">Failed to load content.</p>';
    }
  };

  const switchLegalTab = (tab) => {
    if (!legalTabTerms || !legalTabPrivacy || !legalTermsContent || !legalPrivacyContent) return;
    if (tab === 'terms') {
      legalTabTerms.classList.add('active');
      legalTabTerms.setAttribute('aria-selected', 'true');
      legalTabPrivacy.classList.remove('active');
      legalTabPrivacy.setAttribute('aria-selected', 'false');
      legalTermsContent.style.display = '';
      legalPrivacyContent.style.display = 'none';
      fetchLegalContent('view/legal/terms.html', legalTermsContent);
    } else {
      legalTabPrivacy.classList.add('active');
      legalTabPrivacy.setAttribute('aria-selected', 'true');
      legalTabTerms.classList.remove('active');
      legalTabTerms.setAttribute('aria-selected', 'false');
      legalPrivacyContent.style.display = '';
      legalTermsContent.style.display = 'none';
      fetchLegalContent('view/legal/privacy.html', legalPrivacyContent);
    }
  };

  const openLegalDialog = (tab, requestId = null) => {
    if (!legalDialog) return;
    legalDialogRequestId = requestId;
    switchLegalTab(tab);
    updateBrowserViewVisibility();
    initLegalZoom();
    legalDialog.style.display = 'flex';

    if (!legalKeydownHandler) {
      legalKeydownHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeLegalDialog();
        }
      };
      window.addEventListener('keydown', legalKeydownHandler);
    }
  };

  const closeLegalDialog = () => {
    if (!legalDialog) return;
    legalDialog.style.display = 'none';
    updateBrowserViewVisibility();
    if (legalKeydownHandler) {
      window.removeEventListener('keydown', legalKeydownHandler);
      legalKeydownHandler = null;
    }
    if (legalDialogRequestId && window.electronAPI?.notifyLegalDialogClosed) {
      window.electronAPI.notifyLegalDialogClosed(legalDialogRequestId);
    }
    legalDialogRequestId = null;
  };

  if (termsBtn) {
    termsBtn.addEventListener('click', () => openLegalDialog('terms'));
  }
  if (privacyBtn) {
    privacyBtn.addEventListener('click', () => openLegalDialog('privacy'));
  }

  const loginTermsBtn = document.getElementById('terms-btn');
  if (loginTermsBtn) {
    loginTermsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openLegalDialog('terms');
    });
  }
  const loginPrivacyBtn = document.getElementById('privacy-btn');
  if (loginPrivacyBtn) {
    loginPrivacyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openLegalDialog('privacy');
    });
  }
  if (legalCloseBtn) {
    legalCloseBtn.addEventListener('click', closeLegalDialog);
  }
  if (legalDialog) {
    legalDialog.addEventListener('click', (e) => {
      if (e.target === legalDialog) {
        closeLegalDialog();
      }
    });
  }
  if (legalTabTerms) {
    legalTabTerms.addEventListener('click', () => switchLegalTab('terms'));
  }
  if (legalTabPrivacy) {
    legalTabPrivacy.addEventListener('click', () => switchLegalTab('privacy'));
  }
  if (legalZoomOutBtn) {
    legalZoomOutBtn.addEventListener('click', () => applyLegalZoom(legalZoomFactor - LEGAL_ZOOM_STEP));
  }
  if (legalZoomInBtn) {
    legalZoomInBtn.addEventListener('click', () => applyLegalZoom(legalZoomFactor + LEGAL_ZOOM_STEP));
  }
  if (legalZoomResetBtn) {
    legalZoomResetBtn.addEventListener('click', () => applyLegalZoom(1));
  }

  // 首次啟動流程：主進程要求打開條款/隱私彈窗
  if (window.electronAPI?.onOpenLegalDialog) {
    window.electronAPI.onOpenLegalDialog((payload) => {
      const tab = payload?.tab === 'privacy' ? 'privacy' : 'terms';
      const requestId = payload?.requestId || null;
      openLegalDialog(tab, requestId);
    });
  }
}

let carouselInterval = null;
let currentIndex = 1; // Start at 1 (first real slide)
const duration = 3000; // 3 seconds per slide

let track = null;
let progressBar = null;
let totalSlides = 0;
let isTransitioning = false;

async function initCarousel() {
  track = document.getElementById("carousel-track");
  const progressContainer = document.getElementById("carousel-progress-container");

  if (!track || !progressContainer) return;

  // Clear existing content
  track.innerHTML = '';
  progressContainer.innerHTML = '';
  stopCarousel();

  try {
    // Get images from the assets folder via IPC
    const images = await window.electronAPI.getCarouselImages();
    if (!images || images.length === 0) {
      console.warn('No carousel images found');
      return;
    }

    const N = images.length;

    // 1. Clone Last Slide
    const lastClone = document.createElement('div');
    lastClone.className = 'carousel-item';
    lastClone.style.backgroundImage = `url('${images[N - 1]}')`;
    track.appendChild(lastClone);

    // 2. Add All Real Slides
    images.forEach((imgSrc, index) => {
      const slide = document.createElement('div');
      slide.className = `carousel-item${index === 0 ? ' active' : ''}`;
      slide.style.backgroundImage = `url('${imgSrc}')`;
      track.appendChild(slide);
    });

    // 3. Clone First Slide
    const firstClone = document.createElement('div');
    firstClone.className = 'carousel-item';
    firstClone.style.backgroundImage = `url('${images[0]}')`;
    track.appendChild(firstClone);

    totalSlides = N; // Number of real slides
    currentIndex = 1; // Real first slide is at index 1

    // 4. Create Single Progress Bar
    const dotWrapper = document.createElement('div');
    dotWrapper.className = 'progress-dot-wrapper single-bar';
    progressBar = document.createElement('div');
    progressBar.className = 'progress-dot';
    dotWrapper.appendChild(progressBar);
    progressContainer.appendChild(dotWrapper);

    // Set initial position without transition
    track.classList.add('no-transition');
    track.style.transform = `translateX(-100%)`;
    // Force reflow
    track.offsetHeight;
    track.classList.remove('no-transition');

    startCarousel();
  } catch (error) {
    console.error('Failed to initialize carousel:', error);
  }
}

function goToSlide(index, useTransition = true) {
  if (!track) return;
  if (!useTransition) track.classList.add('no-transition');
  track.style.transform = `translateX(-${index * 100}%)`;

  if (!useTransition) {
    // Force reflow
    track.offsetHeight;
    track.classList.remove('no-transition');
  }
}

function startProgress() {
  if (!progressBar) return;

  // Reset bar animation
  progressBar.style.transition = "none";
  progressBar.style.width = "0%";

  // Animate bar
  requestAnimationFrame(() => {
    progressBar.style.transition = `width ${duration}ms linear`;
    progressBar.style.width = "100%";
  });
}

function nextSlide() {
  if (totalSlides === 0 || isTransitioning) return;
  isTransitioning = true;

  // 1. Remove active zoom from ALL items before sliding
  const items = track.querySelectorAll('.carousel-item');
  items.forEach(item => item.classList.remove('active'));

  // 2. Advance slide
  currentIndex++;
  goToSlide(currentIndex);

  // 3. Only apply zoom to the new slide if it's NOT a clone
  // This ensures that when we jump from Clone -> Real, both are in the same (flat) state.
  if (currentIndex <= totalSlides) {
    items[currentIndex].classList.add('active');
  }

  // 4. Handle clones via silent jump
  setTimeout(() => {
    if (currentIndex > totalSlides) {
      currentIndex = 1;
      goToSlide(currentIndex, false);
      // Now that we are on the real first slide, start its zoom
      items.forEach(item => item.classList.remove('active'));
      items[1].classList.add('active');
    }
    isTransitioning = false;
    startProgress();
  }, 820);
}

function startCarousel() {
  if (totalSlides <= 1) return;
  stopCarousel();
  startProgress();
  carouselInterval = setInterval(nextSlide, duration);
}

function stopCarousel() {
  if (carouselInterval) {
    clearInterval(carouselInterval);
    carouselInterval = null;
  }
}

async function loadComponent(id, file) {
  const el = document.getElementById(id);
  if (!el) return;

  const response = await fetch(file);
  const html = await response.text();
  el.innerHTML = html;
}

// 初始化应用
document.addEventListener('DOMContentLoaded', async () => {
  // load components
  await Promise.all([
    loadComponent("login", "view/auth/login.html"),
    loadComponent("app", "view/main/app.html"),
    loadComponent("legal", "view/legal/legal.html")
  ]);

  if (typeof window.electronAPI === 'undefined') {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    document.body.innerHTML = `<div style="padding: 20px; color: red;">${_t('errNoMainProcess')}</div>`;
    return;
  }

  // Apply saved language preference immediately on page load
  if (window.i18n) window.i18n.applyTranslations();

  // Bind all language switcher buttons (including login page)
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lang = btn.getAttribute('data-lang');
      if (lang && window.i18n) window.i18n.setLanguage(lang);
    });
  });

  // Scrollwheel Zoom (Global: Requires Ctrl)
  // This is added here so it is active on the login page as well.
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) {
        window.electronAPI.zoomViewIn();
      } else if (e.deltaY > 0) {
        window.electronAPI.zoomViewOut();
      }
    }
  }, { passive: false });

  // --- Startup Terms Screen Logic ---
  const startupTermsScreen = document.getElementById('startup-terms-screen');
  const startupTermsAgree = document.getElementById('startup-terms-agree');
  const privacyAndTermsView = document.getElementById('privacy-and-terms-view');
  const startupTermsQuit = document.getElementById('startup-terms-quit');
  if (window.electronAPI && window.electronAPI.onShowStartupTerms) {
    window.electronAPI.onShowStartupTerms(() => {

      if (localStorage.getItem("skipStartupTerms") === "1") {
        return;
      } else {
        startupTermsScreen.style.display = "flex";
        updateBrowserViewVisibility();
      }

    });
  }
  const loginCheckboxPrivacy = document.getElementById('login-checkbox-privacy');
  const loginCheckboxTerms = document.getElementById('login-checkbox-terms');

  const updateAgreeButtonState = () => {
    if (startupTermsAgree && loginCheckboxPrivacy && loginCheckboxTerms) {
      if (loginCheckboxPrivacy.checked && loginCheckboxTerms.checked) {
        startupTermsAgree.disabled = false;
        startupTermsAgree.style.opacity = '1';
        startupTermsAgree.style.cursor = 'pointer';
      } else {
        startupTermsAgree.disabled = true;
        startupTermsAgree.style.opacity = '0.5';
        startupTermsAgree.style.cursor = 'not-allowed';
      }
    }
  };

  if (loginCheckboxPrivacy) loginCheckboxPrivacy.addEventListener('change', updateAgreeButtonState);
  if (loginCheckboxTerms) loginCheckboxTerms.addEventListener('change', updateAgreeButtonState);

  // Set initial state
  updateAgreeButtonState();

  if (startupTermsAgree) {
    startupTermsAgree.addEventListener('click', () => {
      if (startupTermsAgree.disabled) return;
      if (window.electronAPI && window.electronAPI.sendStartupTermsResponse) {
        startupTermsScreen.style.display = 'none';
        updateBrowserViewVisibility();
        localStorage.setItem("skipStartupTerms", "1");
        window.electronAPI.sendStartupTermsResponse(0); // 0 = Agree
      }
    });
  }
  if (privacyAndTermsView) {
    privacyAndTermsView.addEventListener('click', (e) => {
      e.preventDefault();
      const privacyBtn = document.getElementById('privacy-btn');
      if (privacyBtn) privacyBtn.click();
    });
  }
  if (startupTermsQuit) {
    startupTermsQuit.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.quitApp) {
        window.electronAPI.quitApp();
      }
    });
  }

  // --- Shutdown Confirm Screen Logic (Moved to Main Process) ---
  // shutdown-confirm-screen logic is now handled in the main process via a separate BrowserView
  // which ensures it appears on top of everything without hiding background views.

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;

      // Show confirmation dialog first
      window.electronAPI.showSystemOverlay({
        type: 'confirm',
        title: _t('logoutConfirmTitle') || 'Confirm Logout',
        text: _t('logoutConfirmMessage') || 'Are you sure you want to log out?',
        showCancel: true
      });

      window.electronAPI.onSystemOverlayResponse(async (result) => {
        // We do NOT hide the overlay if they confirmed, because we immediately transition to 'loading' overlay.
        // But the previous implementation hid it and re-showed it. Let's hide it just to be safe.
        window.electronAPI.hideSystemOverlay();

        if (!result || !result.confirmed) {
          return;
        }

        // 1. Immediately hide the BrowserView so the loading overlay is visible in front
        updateBrowserViewVisibility();

        // 2. Show "Saving" overlay
        const savingMsg = _t('savingData') || 'Uploading your data...';

        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingText = loadingOverlay?.querySelector('.loading-text');
        if (loadingOverlay) {
          loadingOverlay.style.display = 'flex';
          loadingOverlay.classList.add('saving-state');
          if (loadingText) loadingText.textContent = savingMsg;
        }

        // Also show the top-layer loading overlay to cover BrowserViews
        window.electronAPI.showSystemOverlay({ type: 'loading', text: savingMsg });

        // Always clear the session BEFORE the API call
        localStorage.setItem("skipStartupTerms", "1");
        localStorage.removeItem('csai_session_expiry');
        localStorage.removeItem('csai_saved_username');
        localStorage.removeItem('csai_saved_password');

        try {
          // Wait for main process to finish syncing and clearing session
          await window.electronAPI.logout();
        } catch (e) {
          console.error('Logout sync failed:', e);
        }

        location.reload();
      });
    });
  }

  initLegalDialog();

  initLoginFlow();
});
