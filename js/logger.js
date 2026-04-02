/**
 * 统一日志模块
 * 支持日志级别控制：DEBUG < INFO < WARN < ERROR < FATAL
 * 通过环境变量 LOG_LEVEL 控制日志级别（默认：INFO）
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const LOG_LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const DEFAULT_LOG_LEVEL = process.env.LOG_LEVEL?.toUpperCase() || 'INFO';
const currentLogLevel = LOG_LEVELS[DEFAULT_LOG_LEVEL] ?? LOG_LEVELS.INFO;

// Best-effort: make sure Node writes UTF-8 to stdout/stderr (Windows console still depends on CodePage)
try {
  process.stdout?.setDefaultEncoding?.('utf8');
  process.stderr?.setDefaultEncoding?.('utf8');
} catch {}

function formatTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 23);
}

function formatMessage(level, module, message, ...args) {
  const timestamp = formatTimestamp();
  const levelName = LOG_LEVEL_NAMES[level];
  const modulePrefix = module ? `[${module}]` : '';
  const mainMessage = typeof message === 'string' ? message : JSON.stringify(message);
  
  let fullMessage = `${timestamp} [${levelName}]${modulePrefix} ${mainMessage}`;
  
  if (args.length > 0) {
    const extra = args.map(arg => {
      if (arg instanceof Error) {
        return `${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
      }
      return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
    }).join(' ');
    fullMessage += ' ' + extra;
  }
  
  return fullMessage;
}

function shouldLog(level) {
  return level >= currentLogLevel;
}

const logger = {
  debug(module, message, ...args) {
    if (shouldLog(LOG_LEVELS.DEBUG)) {
      process.stdout.write(formatMessage(LOG_LEVELS.DEBUG, module, message, ...args) + '\n');
    }
  },

  info(module, message, ...args) {
    if (shouldLog(LOG_LEVELS.INFO)) {
      process.stdout.write(formatMessage(LOG_LEVELS.INFO, module, message, ...args) + '\n');
    }
  },

  warn(module, message, ...args) {
    if (shouldLog(LOG_LEVELS.WARN)) {
      process.stderr.write(formatMessage(LOG_LEVELS.WARN, module, message, ...args) + '\n');
    }
  },

  error(module, message, ...args) {
    if (shouldLog(LOG_LEVELS.ERROR)) {
      process.stderr.write(formatMessage(LOG_LEVELS.ERROR, module, message, ...args) + '\n');
    }
  },

  fatal(module, message, ...args) {
    if (shouldLog(LOG_LEVELS.FATAL)) {
      process.stderr.write(formatMessage(LOG_LEVELS.FATAL, module, message, ...args) + '\n');
    }
  }
};

module.exports = logger;
