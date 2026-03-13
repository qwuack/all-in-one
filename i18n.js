/**
 * i18n.js - Lightweight internationalization module
 * Supports: English (en), Simplified Chinese (zh-CN), Traditional Chinese (zh-TW)
 * Default: English
 */

const I18N_STORAGE_KEY = 'csai-crm-language';

const translations = {
  en: {
    // App branding
    appSubtitle: 'Multi-Platform Chat Manager',

    // Login screen
    loginTitle: 'CS AI CRM',
    loginSubtitle: 'Multi-Platform Chat Manager',
    loginUsernameLabel: 'Username',
    loginUsernamePlaceholder: 'Enter username',
    loginPasswordLabel: 'Password',
    loginPasswordPlaceholder: 'Enter password',
    loginBtn: 'Sign In',

    // Register
    registerTitle: 'Create Account',
    registerSubtitle: 'Register a new user',
    registerFullNameLabel: 'Full Name',
    registerFullNamePlaceholder: 'Enter full name',
    registerEmailLabel: 'Email',
    registerEmailPlaceholder: 'Enter email address',
    registerUsernameLabel: 'Username',
    registerUsernamePlaceholder: 'Choose a username',
    registerPasswordLabel: 'Password',
    registerPasswordPlaceholder: 'Enter password',
    registerConfirmPasswordLabel: 'Confirm Password',
    registerConfirmPasswordPlaceholder: 'Confirm password',
    registerBtn: 'Register',
    registerHaveAccount: 'Already have an account?',
    registerLoginLink: 'Sign In',
    registerErrEmpty: 'Please fill in all fields',
    registerErrEmail: 'Please enter a valid email address',
    registerErrMismatch: 'Passwords do not match',
    registerSuccess: 'Account created successfully',

    // Forgot password
    forgotTitle: 'Forgot Password',
    forgotSubtitle: 'Reset your account password',
    forgotEmailLabel: 'Email',
    forgotEmailPlaceholder: 'Enter email address',
    forgotSubmitBtn: 'Reset Password',
    forgotErrEmpty: 'Please fill in all fields',
    forgotErrMismatch: 'Passwords do not match',
    forgotErrIncorrect: 'Old password is incorrect',
    forgotSuccess: 'Password reset successfully',

    // Sidebar
    addAccountTitle: 'Create New Account',
    addAccountAria: 'Create New Account',
    platformSelectorAria: 'Platform Selection',
    searchPlaceholder: 'Search accounts...',
    searchAria: 'Search Accounts',
    accountsListHeader: 'Account List',

    // Header / main
    selectAccount: 'Select an Account',
    statusReady: 'Ready',
    zoomTitle: 'Zoom (Ctrl+Plus/Minus/0 to reset)',
    zoomOutAria: 'Zoom Out',
    zoomInAria: 'Zoom In',
    zoomReset: 'Reset',
    zoomResetAria: 'Reset Zoom',

    // Welcome screen
    welcomeTitle: 'Welcome to CSAI-CRM',
    welcomeDescription: 'Manage customer conversations across multiple social platforms',
    welcomeFeature1: 'Supports WhatsApp, Instagram, Messenger, WeChat Official Account',
    welcomeFeature2: 'Manage multiple accounts simultaneously',
    welcomeFeature3: 'Real-time message sync',
    welcomeGetStarted: 'Get Started',

    // Footer
    termsBtn: 'Terms of Service',
    privacyBtn: 'Privacy Policy',

    // Phone/rename dialog
    phoneDialogTitle: 'Enter Phone Number',
    phoneDialogDescription: 'Please enter the account phone number',
    phoneDialogPlaceholder: 'Enter phone number (8–15 digits)',
    cancelBtn: 'Cancel',
    confirmBtn: 'Confirm',

    // Legal dialog
    legalTitle: 'Legal Information',
    legalSubtitle: 'View the Terms of Service and Privacy Policy for this application',
    legalTabTerms: 'Terms of Service',
    legalTabPrivacy: 'Privacy Policy',
    legalZoomTitle: 'Zoom legal content',

    // Loading
    loading: 'Processing...',

    // Sync status
    syncReady: 'Sync: Idle',
    syncInProgress: 'Sync: In Progress',
    syncDone: 'Sync: Done',
    syncError: 'Sync: Failed',
    syncQueued: 'Waiting...',
    syncSyncing: 'Syncing...',

    // Account actions (inline)
    renameTitle: 'Rename',
    renameAria: 'Rename Account',
    refreshTitle: 'Refresh',
    refreshAria: 'Refresh Account',
    deleteTitle: 'Delete',
    deleteAria: 'Delete Account',
    notSet: 'Not Set',

    // Account messages
    emptyAccounts: 'No matching accounts',
    switchingAccount: 'Switching account...',
    renamingAccount: 'Renaming...',
    deletingAccount: 'Deleting account...',
    creatingAccount: 'Creating account...',

    // Modal: Rename
    renameModalTitle: 'Rename Account',
    renameModalDesc: 'Please enter a new account name',
    renameModalPlaceholder: 'Enter account name',
    renameModalErrEmpty: 'Account name cannot be empty',
    renameModalErrLong: 'Account name cannot exceed 50 characters',

    // Modal: Create account
    createModalDesc: 'Enter the phone number (8–15 digits)',
    createModalPlaceholder: 'Enter phone number (8–15 digits)',
    createModalErrEmpty: 'Phone number cannot be empty',
    createModalErrInvalid: 'Please enter a valid phone number (8–15 digits)',

    // Delete confirm
    deleteConfirm: 'Are you sure you want to delete account "{name}"? This action cannot be undone.',

    // Errors
    errInit: 'Initialization failed: ',
    errBind: 'Event binding failed: ',
    errRender: 'Failed to render account list: ',
    errNoAPI: 'electronAPI is undefined, please check preload.js configuration',
    errNoList: 'Cannot find account list element (#account-list)',
    errNoMethod: 'API method {method} does not exist',
    errSwitchAccount: 'Failed to switch account: ',
    errRenameAccount: 'Failed to rename account: ',
    errDeleteAccount: 'Failed to delete account: ',
    errUIUpdate: 'UI update failed: ',
    errOperation: 'Operation failed: ',
    errNoMainProcess: 'Error: Cannot connect to main process',
    errAppInit: 'App initialization failed: ',
    errSyncBlocked: 'Account is syncing: {partition}, please wait...',
    errSyncQueued: 'This account is queued for sync, please wait...',
    errSyncInProgress: 'This account is currently syncing, please wait...',

    // Login errors
    loginErrEmpty: 'Please enter username and password',
    loginErrFailed: 'Login failed, please check your credentials',
    loginErrRetry: 'Login failed, please try again later',

    // Language switcher
    langSwitcherTitle: 'Switch Language',
  },

  'zh-CN': {
    appSubtitle: '多平台会话管理系统',

    loginTitle: 'CS AI CRM',
    loginSubtitle: '多平台会话管理系统',
    loginUsernameLabel: '帐号',
    loginUsernamePlaceholder: '输入登录帐号',
    loginPasswordLabel: '密码',
    loginPasswordPlaceholder: '输入登录密码',
    loginBtn: '登入',

    registerTitle: '创建账户',
    registerSubtitle: '注册新用户',
    registerFullNameLabel: '姓名',
    registerFullNamePlaceholder: '输入姓名',
    registerEmailLabel: '邮箱',
    registerEmailPlaceholder: '输入邮箱地址',
    registerUsernameLabel: '帐号',
    registerUsernamePlaceholder: '输入帐号',
    registerPasswordLabel: '密码',
    registerPasswordPlaceholder: '输入密码',
    registerConfirmPasswordLabel: '确认密码',
    registerConfirmPasswordPlaceholder: '再次输入密码',
    registerBtn: '注册',
    registerHaveAccount: '已有帐号？',
    registerLoginLink: '返回登入',
    registerErrEmpty: '请填写所有栏位',
    registerErrEmail: '请输入有效的邮箱地址',
    registerErrMismatch: '两次输入的密码不一致',
    registerSuccess: '账户创建成功',

    forgotTitle: '忘记密码',
    forgotSubtitle: '重设您的账户密码',
    forgotOldPasswordLabel: '旧密码',
    forgotOldPasswordPlaceholder: '输入旧密码',
    forgotNewPasswordLabel: '新密码',
    forgotNewPasswordPlaceholder: '输入新密码',
    forgotConfirmPasswordLabel: '确认密码',
    forgotConfirmPasswordPlaceholder: '再次输入新密码',
    forgotSubmitBtn: '重设密码',
    forgotErrEmpty: '请填写所有栏位',
    forgotErrMismatch: '两次输入的密码不一致',
    forgotErrIncorrect: '旧密码不正确',
    forgotSuccess: '密码重设成功',

    addAccountTitle: '建立新账户',
    addAccountAria: '建立新账户',
    platformSelectorAria: '平台选择',
    searchPlaceholder: '搜索账户...',
    searchAria: '搜索账户',
    accountsListHeader: '账户列表',

    selectAccount: '请选择账户',
    statusReady: '就绪',
    zoomTitle: '缩放（Ctrl+加号/减号/0 重置）',
    zoomOutAria: '缩小',
    zoomInAria: '放大',
    zoomReset: '重置',
    zoomResetAria: '重置缩放',

    welcomeTitle: '欢迎使用 CSAI-CRM',
    welcomeDescription: '统一管理多个社交平台的客户对话',
    welcomeFeature1: '支持 WhatsApp、Instagram、Messenger、WeChat Official Account',
    welcomeFeature2: '多账户并行管理',
    welcomeFeature3: '即时同步消息',
    welcomeGetStarted: '开始使用',

    termsBtn: '服务条款',
    privacyBtn: '隐私政策',

    phoneDialogTitle: '输入手机号码',
    phoneDialogDescription: '请输入账户的手机号码',
    phoneDialogPlaceholder: '请输入手机号码（8-15位数字）',
    cancelBtn: '取消',
    confirmBtn: '确认',

    legalTitle: '法律资讯',
    legalSubtitle: '您可以在此快速查看本应用的服务条款与隐私政策',
    legalTabTerms: '服务条款',
    legalTabPrivacy: '隐私政策',
    legalZoomTitle: '缩放法律条款内容',

    loading: '处理中...',

    syncReady: '同步：待机',
    syncInProgress: '同步：进行中',
    syncDone: '同步：完成',
    syncError: '同步：失败',
    syncQueued: '待同步…',
    syncSyncing: '同步中…',

    renameTitle: '重新命名',
    renameAria: '重新命名账户',
    refreshTitle: '重新整理',
    refreshAria: '重新整理账户',
    deleteTitle: '删除',
    deleteAria: '删除账户',
    notSet: '未设定',

    emptyAccounts: '暂无符合的账户',
    switchingAccount: '切换账户中...',
    renamingAccount: '重新命名中...',
    deletingAccount: '删除账户中...',
    creatingAccount: '建立账户中...',

    renameModalTitle: '重新命名账户',
    renameModalDesc: '请输入新的账户名称',
    renameModalPlaceholder: '请输入账户名称',
    renameModalErrEmpty: '账户名称不能为空',
    renameModalErrLong: '账户名称不能超过 50 个字元',

    createModalDesc: '请输入手机号码（8-15位数字）',
    createModalPlaceholder: '请输入手机号码（8-15位数字）',
    createModalErrEmpty: '手机号码不能为空',
    createModalErrInvalid: '请输入有效的手机号码（8-15位数字）',

    deleteConfirm: '确定要删除账户「{name}」吗？此操作无法复原。',

    errInit: '初始化失败: ',
    errBind: '事件绑定失败: ',
    errRender: '渲染账户列表失败: ',
    errNoAPI: 'electronAPI 未定义，请检查 preload.js 设定',
    errNoList: '找不到账户列表元素 (#account-list)',
    errNoMethod: 'API 方法 {method} 不存在',
    errSwitchAccount: '切换账户失败: ',
    errRenameAccount: '重新命名失败: ',
    errDeleteAccount: '删除账户失败: ',
    errUIUpdate: 'UI 更新失败: ',
    errOperation: '操作失败: ',
    errNoMainProcess: '错误：无法连线到主行程',
    errAppInit: '应用初始化失败: ',
    errSyncBlocked: '账号正在同步：{partition}，请稍后…',
    errSyncQueued: '该账号待同步中，请稍后…',
    errSyncInProgress: '该账号正在同步中，请稍后…',

    loginErrEmpty: '请输入帐号与密码',
    loginErrFailed: '登入失败，请确认帐号密码',
    loginErrRetry: '登入失败，请稍后再试',

    langSwitcherTitle: '切换语言',
  },

  'zh-TW': {
    appSubtitle: '多平台會話管理系統',

    loginTitle: 'CS AI CRM',
    loginSubtitle: '多平台會話管理系統',
    loginUsernameLabel: '帳號',
    loginUsernamePlaceholder: '輸入登入帳號',
    loginPasswordLabel: '密碼',
    loginPasswordPlaceholder: '輸入登入密碼',
    loginBtn: '登入',

    registerTitle: '建立帳戶',
    registerSubtitle: '註冊新使用者',
    registerFullNameLabel: '姓名',
    registerFullNamePlaceholder: '輸入姓名',
    registerEmailLabel: '電子郵件',
    registerEmailPlaceholder: '輸入電子郵件',
    registerUsernameLabel: '帳號',
    registerUsernamePlaceholder: '輸入帳號',
    registerPasswordLabel: '密碼',
    registerPasswordPlaceholder: '輸入密碼',
    registerConfirmPasswordLabel: '確認密碼',
    registerConfirmPasswordPlaceholder: '再次輸入密碼',
    registerBtn: '註冊',
    registerHaveAccount: '已有帳號？',
    registerLoginLink: '返回登入',
    registerErrEmpty: '請填寫所有欄位',
    registerErrEmail: '請輸入有效的電子郵件',
    registerErrMismatch: '兩次輸入的密碼不一致',
    registerSuccess: '帳戶建立成功',

    forgotTitle: '忘記密碼',
    forgotSubtitle: '重設您的帳戶密碼',
    forgotOldPasswordLabel: '舊密碼',
    forgotOldPasswordPlaceholder: '輸入舊密碼',
    forgotNewPasswordLabel: '新密碼',
    forgotNewPasswordPlaceholder: '輸入新密碼',
    forgotConfirmPasswordLabel: '確認密碼',
    forgotConfirmPasswordPlaceholder: '再次輸入新密碼',
    forgotSubmitBtn: '重設密碼',
    forgotErrEmpty: '請填寫所有欄位',
    forgotErrMismatch: '兩次輸入的密碼不一致',
    forgotErrIncorrect: '舊密碼不正確',
    forgotSuccess: '密碼重設成功',

    addAccountTitle: '建立新帳戶',
    addAccountAria: '建立新帳戶',
    platformSelectorAria: '平台選擇',
    searchPlaceholder: '搜尋帳戶...',
    searchAria: '搜尋帳戶',
    accountsListHeader: '帳戶列表',

    selectAccount: '請選擇帳戶',
    statusReady: '就緒',
    zoomTitle: '縮放（Ctrl+加號/減號/0 重置）',
    zoomOutAria: '縮小',
    zoomInAria: '放大',
    zoomReset: '重置',
    zoomResetAria: '重置縮放',

    welcomeTitle: '歡迎使用 CSAI-CRM',
    welcomeDescription: '統一管理多個社交平台的客戶對話',
    welcomeFeature1: '支持 WhatsApp、Instagram、Messenger、WeChat Official Account',
    welcomeFeature2: '多帳戶並行管理',
    welcomeFeature3: '即時同步訊息',
    welcomeGetStarted: '開始使用',

    termsBtn: '服務條款',
    privacyBtn: '隱私權政策',

    phoneDialogTitle: '輸入手機號碼',
    phoneDialogDescription: '請輸入帳戶的手機號碼',
    phoneDialogPlaceholder: '請輸入手機號碼（8-15位數字）',
    cancelBtn: '取消',
    confirmBtn: '確認',

    legalTitle: '法律資訊',
    legalSubtitle: '您可以在此快速查看本應用的服務條款與隱私權政策',
    legalTabTerms: '服務條款',
    legalTabPrivacy: '隱私權政策',
    legalZoomTitle: '縮放法律條款內容',

    loading: '處理中...',

    syncReady: '同步：待機',
    syncInProgress: '同步：進行中',
    syncDone: '同步：完成',
    syncError: '同步：失敗',
    syncQueued: '待同步…',
    syncSyncing: '同步中…',

    renameTitle: '重新命名',
    renameAria: '重新命名帳戶',
    refreshTitle: '重新整理',
    refreshAria: '重新整理帳戶',
    deleteTitle: '刪除',
    deleteAria: '刪除帳戶',
    notSet: '未設定',

    emptyAccounts: '暫無符合的帳戶',
    switchingAccount: '切換帳戶中...',
    renamingAccount: '重新命名中...',
    deletingAccount: '刪除帳戶中...',
    creatingAccount: '建立帳戶中...',

    renameModalTitle: '重新命名帳戶',
    renameModalDesc: '請輸入新的帳戶名稱',
    renameModalPlaceholder: '請輸入帳戶名稱',
    renameModalErrEmpty: '帳戶名稱不能為空',
    renameModalErrLong: '帳戶名稱不能超過 50 個字元',

    createModalDesc: '請輸入手機號碼（8-15位數字）',
    createModalPlaceholder: '請輸入手機號碼（8-15位數字）',
    createModalErrEmpty: '手機號碼不能為空',
    createModalErrInvalid: '請輸入有效的手機號碼（8-15位數字）',

    deleteConfirm: '確定要刪除帳戶「{name}」嗎？此操作無法復原。',

    errInit: '初始化失敗: ',
    errBind: '事件綁定失敗: ',
    errRender: '渲染帳戶列表失敗: ',
    errNoAPI: 'electronAPI 未定義，請檢查 preload.js 設定',
    errNoList: '找不到帳戶列表元素 (#account-list)',
    errNoMethod: 'API 方法 {method} 不存在',
    errSwitchAccount: '切換帳戶失敗: ',
    errRenameAccount: '重新命名失敗: ',
    errDeleteAccount: '刪除帳戶失敗: ',
    errUIUpdate: 'UI 更新失敗: ',
    errOperation: '操作失敗: ',
    errNoMainProcess: '錯誤：無法連線到主行程',
    errAppInit: '應用初始化失敗: ',
    errSyncBlocked: '帳號正在同步：{partition}，請稍後…',
    errSyncQueued: '該帳號待同步中，請稍後…',
    errSyncInProgress: '該帳號正在同步中，請稍後…',

    loginErrEmpty: '請輸入帳號與密碼',
    loginErrFailed: '登入失敗，請確認帳號密碼',
    loginErrRetry: '登入失敗，請稍後再試',

    langSwitcherTitle: '切換語言',
  }
};

// ─── Core i18n state ────────────────────────────────────────────────────────

const SUPPORTED_LANGS = ['en', 'zh-CN', 'zh-TW'];
const DEFAULT_LANG = 'en';

let currentLang = (() => {
  try {
    const saved = localStorage.getItem(I18N_STORAGE_KEY);
    if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  } catch { }
  return DEFAULT_LANG;
})();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Translate a key, with optional variable interpolation.
 * e.g. t('errSyncBlocked', { partition: 'abc' })
 */
function t(key, vars) {
  const dict = translations[currentLang] || translations[DEFAULT_LANG];
  let str = dict[key] ?? translations[DEFAULT_LANG][key] ?? key;
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    });
  }
  return str;
}

/** Return the active language code. */
function getLanguage() {
  return currentLang;
}

/**
 * Switch language, persist to localStorage, and re-apply all translations.
 * Dispatches a custom 'languageChanged' event on window.
 */
function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return;
  currentLang = lang;
  try { localStorage.setItem(I18N_STORAGE_KEY, lang); } catch { }
  applyTranslations();
  updateLangSwitcherUI();
  window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
}

/**
 * Scan the DOM for [data-i18n] and replace text / attributes.
 * Supports:
 *   data-i18n="key"                → element.textContent
 *   data-i18n-placeholder="key"    → element.placeholder
 *   data-i18n-title="key"          → element.title
 *   data-i18n-aria-label="key"     → element.ariaLabel
 */
function applyTranslations() {
  // textContent
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  // placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });
  // title
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  });
  // aria-label
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
}

/** Highlight the active language button in all switcher widgets (fixed DOM order). */
function updateLangSwitcherUI() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    const isActive = btn.getAttribute('data-lang') === currentLang;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}


// ─── Expose globally ─────────────────────────────────────────────────────────
window.i18n = { t, getLanguage, setLanguage, applyTranslations };
