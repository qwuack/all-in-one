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
      JSON.parse(localStorage.getItem('csai_pinned_accounts') || '[]')
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

      this.renderAccounts();
      this.bindEvents();
      this.setupEventListeners();
      this.setupZoomControls();
      this.setupSyncStatusIndicator();
      this.setupLangSwitcher();
      this.setupPanelResize();
      this.setupRailDrag();
      if (window.i18n) window.i18n.applyTranslations();
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
      updateDisplay(factor);
    });

    try {
      const factor = await window.electronAPI.getZoomFactor();
      updateDisplay(factor);
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
        // 使用 Chromium 支援的 zoom 屬性，僅作用於彈窗內容
        legalModalBody.style.zoom = legalZoomFactor;
        if (legalZoomLevelEl) {
          legalZoomLevelEl.textContent = Math.round(legalZoomFactor * 100) + '%';
        }
      };

      const initLegalZoom = () => {
        legalZoomFactor = 1;
        applyLegalZoom(legalZoomFactor);
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
        } else {
          legalTabPrivacy.classList.add('active');
          legalTabPrivacy.setAttribute('aria-selected', 'true');
          legalTabTerms.classList.remove('active');
          legalTabTerms.setAttribute('aria-selected', 'false');
          legalPrivacyContent.style.display = '';
          legalTermsContent.style.display = 'none';
        }
      };

      const openLegalDialog = (tab, requestId = null) => {
        if (!legalDialog) return;
        legalDialogRequestId = requestId;
        switchLegalTab(tab);
        if (window.electronAPI?.hideBrowserView) {
          window.electronAPI.hideBrowserView();
        }
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
        if (window.electronAPI?.showBrowserView) {
          window.electronAPI.showBrowserView();
        }
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

      this.bindPlatformTabs();
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      this.showError(_t('errBind') + error.message);
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
    });
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

        // Update the panel label for the new three-column layout
        const panelLabel = document.getElementById('panel-platform-label');
        if (panelLabel) {
          panelLabel.textContent = platformNames[platform] || platform;
        }

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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(getOrder()));
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
          ${isPinned ? '<span class="pin-badge" title="Pinned">📌</span>' : ''}
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
          <button class="inline-btn account-menu-btn" title="Options" aria-label="Account options" ${locked ? 'disabled' : ''}>
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
      { icon: isPinned ? '📌' : '📌', label: isPinned ? 'Unpin' : 'Pin to top', action: 'pin', danger: false },
      { icon: '✏️', label: _t ? _t('renameTitle') : 'Rename', action: 'rename', danger: false, disabled: locked },
      { icon: '🔄', label: _t ? _t('refreshTitle') : 'Refresh', action: 'refresh', danger: false, disabled: locked },
      { icon: '🗑️', label: _t ? _t('deleteTitle') : 'Delete', action: 'delete', danger: true, disabled: locked },
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
            localStorage.setItem('csai_pinned_accounts', JSON.stringify([...this.pinnedAccounts]));
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
        inputType = 'text',
        placeholder = '',
        maxLength = 50,
        initialValue = '',
        validator = null,
        onConfirm = null
      } = options;

      const dialog = document.getElementById('phone-dialog');
      const titleEl = document.getElementById('phone-dialog-title');
      const descriptionEl = document.getElementById('phone-dialog-description');
      const input = document.getElementById('phone-dialog-input');
      const error = document.getElementById('phone-dialog-error');
      const confirmBtn = document.getElementById('phone-dialog-confirm');
      const cancelBtn = document.getElementById('phone-dialog-cancel');
      const closeBtn = document.getElementById('phone-dialog-close');

      // 初始化对话框内容
      titleEl.textContent = title;
      descriptionEl.textContent = description;
      input.type = inputType;
      input.placeholder = placeholder;
      input.maxLength = maxLength;
      input.value = initialValue;
      error.style.display = 'none';
      error.textContent = '';

      // 显示对话框前，隐藏 BrowserView
      if (window.electronAPI.hideBrowserView) {
        window.electronAPI.hideBrowserView();
      }

      // 显示对话框并聚焦输入框
      dialog.style.display = 'flex';
      input.focus();
      if (initialValue) {
        input.select();
      }

      // 清理事件监听器
      const cleanup = () => {
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        closeBtn.onclick = null;
        input.onkeydown = null;
        input.oninput = null;
        dialog.onclick = null;
      };

      // 关闭对话框
      const closeDialog = () => {
        dialog.style.display = 'none';
        input.value = '';
        error.style.display = 'none';

        // Reset for next use
        const _t2 = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        input.type = 'tel';
        input.placeholder = _t2('phoneDialogPlaceholder');
        input.maxLength = 20;

        // 恢复 BrowserView
        if (window.electronAPI.showBrowserView) {
          window.electronAPI.showBrowserView();
        }

        cleanup();
        resolve(null);
      };

      // 验证并提交
      const handleConfirm = async () => {
        const value = input.value.trim();

        // 验证输入
        if (validator) {
          const errorMsg = validator(value);
          if (errorMsg) {
            error.textContent = errorMsg;
            error.style.display = 'block';
            error.classList.add('show');
            input.focus();
            return;
          }
        }

        // 关闭对话框
        closeDialog();

        // 执行确认回调
        if (onConfirm) {
          try {
            await onConfirm(value);
          } catch (error) {
            this.showError(error.message || '操作失敗');
          }
        } else {
          resolve(value);
        }
      };

      // 绑定事件
      confirmBtn.onclick = handleConfirm;
      cancelBtn.onclick = closeDialog;
      closeBtn.onclick = closeDialog;

      // 键盘事件
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleConfirm();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeDialog();
        }
      };

      // 点击遮罩层关闭
      dialog.onclick = (e) => {
        if (e.target === dialog) {
          closeDialog();
        }
      };

      // 清除错误提示
      input.oninput = () => {
        if (error.style.display === 'block') {
          error.style.display = 'none';
          error.classList.remove('show');
        }
      };
    });
  }

  /**
   * 重命名账户
   * @param {Object} account - 账户对象
   */
  async renameAccount(account) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    await this.showModalDialog({
      title: _t('renameModalTitle'),
      description: _t('renameModalDesc'),
      inputType: 'text',
      placeholder: _t('renameModalPlaceholder'),
      maxLength: 50,
      initialValue: account.name || '',
      validator: (value) => {
        if (!value) return _t('renameModalErrEmpty');
        if (value.length > 50) return _t('renameModalErrLong');
        return null;
      },
      onConfirm: async (newName) => {
        try {
          this.setLoading(true, _t('renamingAccount'));
          await this.safeCallAPI('renameAccount', account.partition, newName);
        } catch (error) {
          this.showError(_t('errRenameAccount') + error.message);
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
      const confirmed = confirm(msg);

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

  showError(message) {
    alert('錯誤: ' + message);
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
    }
  }

  /**
   * 弹出手机号输入对话框并创建账户
   * @param {string} platform - 平台名称
   */
  async promptPhoneNumberAndCreate(platform) {
    const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
    const platformName = (platform || 'whatsapp').toUpperCase();

    await this.showModalDialog({
      title: `${platformName}`,
      description: `${_t('createModalDesc')}`,
      inputType: 'tel',
      placeholder: _t('createModalPlaceholder'),
      maxLength: 20,
      initialValue: '',
      validator: (value) => {
        if (!value) return _t('createModalErrEmpty');
        const cleaned = value.replace(/\D/g, '');
        if (cleaned.length < 8 || cleaned.length > 15) return _t('createModalErrInvalid');
        return null;
      },
      onConfirm: async (phoneNumber) => {
        try {
          this.setLoading(true, _t('creatingAccount'));
          await this.safeCallAPI('createNewAccount', platform, phoneNumber);
        } catch (error) {
          this.showError(_t('errOperation') + error.message);
        } finally {
          this.setLoading(false);
        }
      }
    });
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

function initLoginFlow() {
  const loginScreen = document.getElementById('login-screen');
  const appRoot = document.querySelector('.app');
  const form = document.getElementById('login-form');
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');
  const showRegister = document.getElementById('show-register');
  const showForgot = document.getElementById('show-forgot');
  const registerForm = document.getElementById('register-form');
  const forgotForm = document.getElementById('forgot-form');

  if (!loginScreen || !appRoot || !form || !usernameInput || !passwordInput || !submitBtn) {
    // 如果登入元件不存在，直接進入主應用（兼容舊版）
    appRoot.style.display = 'flex';
    startApp();
    return;
  }

  const showError = (msg) => {
    if (!errorEl) return;
    errorEl.textContent = msg || '';
    errorEl.style.display = msg ? 'block' : 'none';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      showError(_t('loginErrEmpty'));
      return;
    }

    showError('');
    submitBtn.disabled = true;

    try {
      const result = await window.electronAPI.login(username, password);
      if (!result || !result.success) {
        const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
        showError(result?.message || _t('loginErrFailed'));
        submitBtn.disabled = false;
        return;
      }

      loginScreen.style.display = 'none';
      appRoot.style.display = 'flex';
      startApp();
    } catch (error) {
      const _t = window.i18n ? window.i18n.t.bind(window.i18n) : (k) => k;
      showError(_t('loginErrRetry'));
      submitBtn.disabled = false;
    }
  });

  if (showRegister) {
    showRegister.addEventListener('click', (e) => {
      e.preventDefault();
      form.style.display = 'none';
      if (registerForm) registerForm.style.display = 'block';
    });
  }

  if (showForgot) {
    showForgot.addEventListener('click', (e) => {
      e.preventDefault();
      form.style.display = 'none';
      if (forgotForm) forgotForm.style.display = 'block';
    });
  }

  const backToLogin = document.getElementById('back-to-login');
  if (backToLogin) {
    backToLogin.addEventListener('click', (e) => {
      e.preventDefault();
      if (registerForm) registerForm.style.display = 'none';
      form.style.display = 'block';
    });
  }

  const backToLogin2 = document.getElementById('back-to-login-2');
  if (backToLogin2) {
    backToLogin2.addEventListener('click', (e) => {
      e.preventDefault();
      if (forgotForm) forgotForm.style.display = 'none';
      form.style.display = 'block';
    });
  }

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
        if (!errorReg) return;
        errorReg.textContent = msg || '';
        errorReg.style.display = msg ? 'block' : 'none';
      };

      if (!fullName || !email || !username || !password) {
        showRegError('Please complete all fields');
        return;
      }

      if (password !== confirm) {
        showRegError('Passwords do not match');
        return;
      }

      try {
        const result = await window.electronAPI.register({
          fullName,
          email,
          username,
          password
        });

        if (!result || result.error) {
          showRegError(result?.message || 'Register failed');
          return;
        }

        alert('Account created successfully');

        registerForm.style.display = 'none';
        form.style.display = 'block';

      } catch (err) {
        showRegError('Registration error');
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
          forgotErrorEl.style.display = 'none'; // hide completely
          forgotErrorEl.classList.remove("login-error", "login-success", "login-warning");
          return;
        }

        forgotErrorEl.textContent = msg;
        forgotErrorEl.style.display = 'block';

        forgotErrorEl.classList.remove("login-error", "login-success", "login-warning");
        if (type === "success") forgotErrorEl.classList.add("login-success");
        else if (type === "warning") forgotErrorEl.classList.add("login-warning");
        else forgotErrorEl.classList.add("login-error");
      };

      try {
        showForgotMessage('Please wait, sending email...', 'warning');

        const result = await window.electronAPI.resetPassword({
          forgotEmail
        });

        if (!result || result.error) {
          showForgotMessage(result?.message || 'Please enter correct email address', 'error');
          return;
        }

        showForgotMessage('Email sent successfully. Please check your email for instructions.', 'success');

      } catch (err) {
        showForgotMessage('Please enter a valid email address', 'error');
      }
    });
  }

  // 預設聚焦帳號輸入框
  setTimeout(() => {
    usernameInput.focus();
  }, 0);
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
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

  initLoginFlow();
});
