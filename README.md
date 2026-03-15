# CS-AI-CRM 部署文档
 
## 📋 项目简介

CS-AI-CRM 是一个基于 Electron 的多平台会话管理桌面应用，支持统一管理 WhatsApp、Instagram、Messenger、WeChat 等社交平台的客户对话。

### 主要特性

- ✅ 多平台支持：WhatsApp、Instagram、Messenger、WeChat Official Account
- ✅ 多账户管理：支持同一平台下管理多个账户
- ✅ 会话同步：基于 GitHub 的云端会话数据同步
- ✅ 实时消息监控：自动检测未读消息并显示计数
- ✅ 现代化 UI：响应式设计，支持整页缩放
- ✅ 用户认证：基于 MySQL 的用户登录系统

---

## 🖥️ 系统要求

### 最低配置

- **操作系统**：Windows 10/11、macOS 10.15+、Linux (Ubuntu 18.04+)
- **Node.js**：v16.0.0 或更高版本
- **MySQL**：5.7+ 或 8.0+
- **内存**：至少 4GB RAM
- **磁盘空间**：至少 500MB 可用空间

### 推荐配置

- **操作系统**：Windows 11、macOS 12+、Linux (Ubuntu 20.04+)
- **Node.js**：v18.0.0 或更高版本
- **MySQL**：8.0+
- **内存**：8GB RAM 或更多
- **磁盘空间**：2GB+ 可用空间

---

## 📦 环境准备

### 1. 安装 Node.js

访问 [Node.js 官网](https://nodejs.org/) 下载并安装最新 LTS 版本。

验证安装：
```bash
node --version
npm --version
```

### 2. 安装 MySQL

#### Windows
1. 访问 [MySQL 官网](https://dev.mysql.com/downloads/mysql/) 下载 MySQL Installer
2. 运行安装程序，选择 "Developer Default" 配置
3. 设置 root 用户密码（请妥善保管）

#### macOS
```bash
# 使用 Homebrew
brew install mysql
brew services start mysql
```

#### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install mysql-server
sudo systemctl start mysql
sudo systemctl enable mysql
```

#### 创建数据库

登录 MySQL：
```bash
mysql -u root -p
```

创建数据库和用户（可选）：
```sql
CREATE DATABASE crm_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'crm_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON crm_db.* TO 'crm_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```


---

## 🚀 安装步骤

### 1. 克隆或下载项目

```bash
# 如果使用 Git
git clone <repository-url>
cd crm-demoV1.0.4

# 或直接解压项目压缩包
```

### 2. 安装依赖

```bash
npm install
```

如果安装过程中遇到网络问题，可以使用国内镜像：
```bash
npm install --registry=https://registry.npmmirror.com
```

### 3. 配置环境变量

复制环境变量模板文件：
```bash
# Windows
copy env.example env.local

# macOS/Linux
cp env.example env.local
```

编辑 `env.local` 文件，填入实际配置：

```env
### MySQL（必须：登录/账户功能依赖 DB）
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=crm_db

### GitHub 同步（可选：ENABLE_SYNC=true 才需要）
ENABLE_SYNC=true
GITHUB_OWNER=your_github_username
GITHUB_REPO=your_repo_name
GITHUB_BRANCH=main
GITHUB_BASE_PATH=users
GITHUB_PAT=ghp_your_personal_access_token

### SMTP Setup
SMTP_EMAIL=your_smtp_email
SMTP_PASSWORD=your_smtp_password

### 日志
LOG_LEVEL=INFO
```

**重要提示**：
- `env.local` 文件包含敏感信息，请勿提交到版本控制系统
- 如果不需要会话同步功能，可设置 `ENABLE_SYNC=false`
- `LOG_LEVEL` 可选值：`DEBUG`、`INFO`、`WARN`、`ERROR`、`FATAL`

### 4. 验证配置

启动应用前，确保：
- ✅ MySQL 服务正在运行
- ✅ 数据库已创建
- ✅ 环境变量配置正确
- ✅ GitHub PAT 有效（如果启用同步）

---

## 🏃 运行应用

### 开发模式

```bash
npm start
```

或使用调试模式：
```bash
npm run dev
```

### 生产模式

首次运行时会自动：
1. 初始化数据库表结构
2. 显示服务条款确认对话框
3. 进入登录界面

---

## 🔨 构建应用

### Windows

构建 Windows 安装包：
```bash
npm run build:win
```

生成的安装包位于 `dist/` 目录。

### macOS

构建 macOS 应用：
```bash
npm run build:mac
```

### 所有平台

```bash
npm run build:all
```

### 清理并重新安装依赖

```bash
npm run clean
```

---

## 📝 使用说明

### 首次启动

1. **同意服务条款**
   - 首次启动会显示服务条款确认对话框
   - 点击"查看条款"可阅读详细内容
   - 必须点击"同意并继续"才能使用应用

2. **登录系统**
   - 输入用户名和密码
   - 如果数据库中没有用户，需要先在数据库中手动创建用户（见下方"创建初始用户"）

3. **创建账户**
   - 登录后，点击侧边栏的"+"按钮
   - 选择平台（WhatsApp、Instagram、Messenger、WeChat）
   - 输入手机号码（8-15位数字）
   - 系统会自动创建账户并打开对应平台的网页版

### 创建初始用户

如果数据库中没有用户，需要手动创建：

```sql
-- 登录 MySQL
mysql -u root -p crm_db

-- 插入用户（密码为 'admin123' 的 SHA256 哈希值）
-- 注意：实际部署时请修改密码
INSERT INTO users (username, password_hash) 
VALUES ('admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9');
```

或者使用 Node.js 脚本创建用户（需要先实现创建用户的脚本）。

### 账户管理

- **切换账户**：点击侧边栏账户列表中的账户项
- **重命名账户**：点击账户项右侧的 ✏️ 按钮
- **刷新账户**：点击账户项右侧的 🔄 按钮
- **删除账户**：点击账户项右侧的 🗑️ 按钮

### 缩放控制

- **放大**：点击顶部工具栏的 `+` 按钮，或使用快捷键 `Ctrl/Cmd + =`
- **缩小**：点击顶部工具栏的 `-` 按钮，或使用快捷键 `Ctrl/Cmd + -`
- **重置**：点击"重置"按钮，或使用快捷键 `Ctrl/Cmd + 0`

---

## 🔧 配置说明

### MySQL 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `MYSQL_HOST` | MySQL 服务器地址 | `localhost` |
| `MYSQL_PORT` | MySQL 端口 | `3306` |
| `MYSQL_USER` | MySQL 用户名 | `root` |
| `MYSQL_PASSWORD` | MySQL 密码 | - |
| `MYSQL_DATABASE` | 数据库名称 | `crm_db` |

### GitHub 同步配置

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `ENABLE_SYNC` | 是否启用同步 | `true` |
| `GITHUB_OWNER` | GitHub 用户名或组织名 | - |
| `GITHUB_REPO` | 仓库名称 | - |
| `GITHUB_BRANCH` | 分支名称 | `main` |
| `GITHUB_BASE_PATH` | 存储路径前缀 | `users` |
| `GITHUB_PAT` | Personal Access Token | - |

### 日志配置

| 环境变量 | 说明 | 可选值 |
|---------|------|--------|
| `LOG_LEVEL` | 日志级别 | `DEBUG`、`INFO`、`WARN`、`ERROR`、`FATAL` |

---

## 🗄️ 数据库结构

应用会自动创建以下表：

### `users` 表
存储用户认证信息。

### `accounts` 表
存储账户信息，包括平台、手机号、名称、状态等。

### `account_sync_state` 表
跟踪账户同步状态。



## ❓ 常见问题

### Q1: 启动时提示 "MySQL 连接失败"

**解决方案**：
1. 检查 MySQL 服务是否运行
2. 验证 `env.local` 中的 MySQL 配置是否正确
3. 确认数据库已创建
4. 检查防火墙设置

### Q2: 登录时提示 "帐号或密码错误"

**解决方案**：
1. 确认数据库中已存在该用户
2. 检查密码是否正确（注意：密码是 SHA256 哈希值）
3. 查看应用日志获取详细错误信息

### Q3: 会话同步失败

**解决方案**：
1. 检查 GitHub PAT 是否有效
2. 确认仓库权限（需要 `repo` 权限）
3. 验证仓库路径配置是否正确
4. 查看网络连接是否正常

### Q4: Instagram 账户显示导航栏

**解决方案**：
- 这是已知问题，应用会自动尝试隐藏导航栏
- 如果仍然显示，可以尝试刷新账户或重启应用

### Q5: 消息未读数不更新

**解决方案**：
1. 检查网络连接
2. 确认对应平台的网页版是否正常加载
3. 查看应用日志中的错误信息
4. 尝试刷新账户

### Q6: 构建失败

**解决方案**：
1. 确保 Node.js 版本符合要求
2. 清理并重新安装依赖：`npm run clean`
3. 检查磁盘空间是否充足
4. Windows 构建可能需要安装 Visual Studio Build Tools

---

## 🐛 故障排除

### 查看日志

应用日志会输出到控制台。如果使用构建版本，日志位置：
- **Windows**: `%APPDATA%\crm-multi-account\logs\`
- **macOS**: `~/Library/Application Support/crm-multi-account/logs/`
- **Linux**: `~/.config/crm-multi-account/logs/`

### 重置应用数据

如果需要重置应用数据：

1. **Windows**:
   ```
   %APPDATA%\crm-multi-account\
   ```

2. **macOS**:
   ```
   ~/Library/Application Support/crm-multi-account/
   ```

3. **Linux**:
   ```
   ~/.config/crm-multi-account/
   ```

删除上述目录下的所有文件（保留 `config.json` 如果需要）。

### 数据库重置

如果需要重置数据库：

```sql
-- 警告：这将删除所有数据！
DROP DATABASE crm_db;
CREATE DATABASE crm_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

然后重新启动应用，数据库表会自动创建。

---

## 📞 技术支持

如遇到问题，请：

1. 查看本文档的"常见问题"和"故障排除"部分
2. 检查应用日志文件
3. 联系开发团队或提交 Issue

---

## 📄 许可证

MIT License

---

## 🔄 更新日志

### v1.0.4
- 支持多平台会话管理
- 实现 GitHub 云端同步
- 优化 Instagram 导航栏隐藏
- 改进消息监控机制

---

## 📚 相关文档

- [服务条款](terms.html)
- [隐私政策](privacy.html)
- [Electron 官方文档](https://www.electronjs.org/docs)
- [MySQL 官方文档](https://dev.mysql.com/doc/)

---

**最后更新**: 2026年2月
