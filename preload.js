const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程可用的最小 API 面
 * - 所有能力都通过 IPC 受控暴露，避免在渲染进程直接接触 Node 权限
 * - 这里的函数命名尽量与主进程的 channel 对齐，便于维护
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // 登录
  login: (username, password) => {
    return ipcRenderer.invoke('login', { username, password });
  },

  // 注册
  register: (data) => {
    return ipcRenderer.invoke('register', data);
  },

  // 修改密码 / 忘记密码
  resetPassword: (data) => {
    return ipcRenderer.invoke('reset-password', data);
  },

  // 账户：操作
  switchAccount: (partition) => {
    ipcRenderer.send('switch-account', partition);
  },
  createNewAccount: (platform, phoneNumber) => {
    ipcRenderer.send('create-new-account', platform, phoneNumber);
  },
  getAccounts: () => {
    return ipcRenderer.invoke('get-accounts');
  },
  removeAccount: (partition) => {
    return ipcRenderer.invoke('remove-account', partition);
  },
  renameAccount: (partition, newName) => {
    return ipcRenderer.invoke('rename-account', partition, newName);
  },
  refreshAccount: (partition) => {
    ipcRenderer.send('refresh-account', partition);
  },
  pauseAccount: (partition) => {
    ipcRenderer.send('pause-account', partition);
  },
  resumeAccount: (partition) => {
    ipcRenderer.send('resume-account', partition);
  },
  
  // 账户：事件
  onAccountsUpdated: (callback) => {
    ipcRenderer.on('accounts-updated', (event, accounts) => {
      callback(accounts);
    });
  },
  
  onAccountSwitched: (callback) => {
    ipcRenderer.on('account-switched', (event, partition) => {
      callback(partition);
    });
  },
  
  onAccountPaused: (callback) => {
    ipcRenderer.on('account-paused', (event, partition) => {
      callback(partition);
    });
  },
  
  onAccountResumed: (callback) => {
    ipcRenderer.on('account-resumed', (event, partition) => {
      callback(partition);
    });
  },
  
  // 消息：事件
  onMessagesUpdated: (callback) => {
    ipcRenderer.on('messages-updated', (event, partition, messageData) => {
      callback(partition, messageData);
    });
  },
  
  // 错误：事件
  onAccountCreateError: (callback) => {
    ipcRenderer.on('account-create-error', (event, errorMessage) => {
      callback(errorMessage);
    });
  },

  // 同步：状态事件（主进程 -> 渲染进程）
  onSyncStatus: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('sync-status', (event, payload) => callback(payload));
  },
  
  // 视图：对话框显示期间隐藏/恢复 BrowserView
  hideBrowserView: () => {
    ipcRenderer.send('hide-browser-view');
  },
  
  showBrowserView: () => {
    ipcRenderer.send('show-browser-view');
  },

  // 视图：内嵌页缩放（BrowserView）
  zoomViewIn: () => {
    ipcRenderer.send('zoom-view-in');
  },
  zoomViewOut: () => {
    ipcRenderer.send('zoom-view-out');
  },
  zoomViewReset: () => {
    ipcRenderer.send('zoom-view-reset');
  },
  getZoomFactor: () => {
    return ipcRenderer.invoke('get-zoom-factor');
  },
  onZoomChanged: (callback) => {
    ipcRenderer.on('zoom-changed', (event, factor) => callback(factor));
  },

  // 法律：主进程触发在当前页面打开条款/隐私弹窗（主 -> 渲染）
  onOpenLegalDialog: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('open-legal-dialog', (event, payload) => callback(payload));
  },

  // 法律：弹窗关闭回执（渲染 -> 主）
  notifyLegalDialogClosed: (requestId) => {
    ipcRenderer.send('legal-dialog-closed', requestId);
  },

  // 法律：手动打开（兼容旧接口）
  openTerms: () => {
    return ipcRenderer.invoke('open-terms');
  },

  openPrivacy: () => {
    return ipcRenderer.invoke('open-privacy');
  },

  // 面板拖拽调整大小 → 通知主进程重新对齐 BrowserView
  panelResized: () => {
    ipcRenderer.send('panel-resized');
  }
});