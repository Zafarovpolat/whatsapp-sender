const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════
//  ГЛОБАЛЬНАЯ ЗАЩИТА ОТ ПАДЕНИЙ
// ═══════════════════════════════════════════════════════

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ═══════════════════════════════════════════════════════
//  ИМПОРТЫ
// ═══════════════════════════════════════════════════════

let Client, LocalAuth;
try {
  const wwebjs = require('whatsapp-web.js');
  Client = wwebjs.Client;
  LocalAuth = wwebjs.LocalAuth;
  console.log('[OK] whatsapp-web.js loaded');
} catch (err) {
  console.error('[ERR] whatsapp-web.js:', err.message);
  process.exit(1);
}

let parseSpintax, generateRandomMessage;
try {
  parseSpintax = require('./spintax').parseSpintax;
  generateRandomMessage = require('./randomMessages').generateRandomMessage;
  console.log('[OK] Helpers loaded');
} catch (err) {
  parseSpintax = (text) => text;
  generateRandomMessage = () => 'Test message';
}

let proxyChain;
try {
  proxyChain = require('proxy-chain');
  console.log('[OK] proxy-chain loaded');
} catch (err) {
  console.warn('[WARN] proxy-chain not installed — proxy auth will not work');
}

// ═══════════════════════════════════════════════════════
//  EXPRESS
// ═══════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 120000,
  pingInterval: 25000,
  transports: ['polling', 'websocket']
});

// ═══════════════════════════════════════════════════════
//  АУТЕНТИФИКАЦИЯ
// ═══════════════════════════════════════════════════════

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const authTokens = new Set();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  if (!AUTH_PASSWORD) return next();
  if (req.path === '/auth/login' || req.path === '/auth/check') return next();

  const token = req.headers['x-auth-token'];
  if (!token || !authTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

io.use((socket, next) => {
  if (!AUTH_PASSWORD) return next();
  const token = socket.handshake.auth?.token;
  if (!token || !authTokens.has(token)) {
    return next(new Error('Unauthorized'));
  }
  next();
});

// ═══════════════════════════════════════════════════════
//  SOCKET.IO + SCREENCAST
// ═══════════════════════════════════════════════════════

io.on('connection', (sock) => {
  console.log(`[WS] Client connected: ${sock.id}`);
  sock.emit('sessions:update', getSessionsList());

  // ═══ Восстановить состояние для переподключившегося клиента ═══
  const token = sock.handshake.auth?.token;
  if (token) {
    const userId = token !== 'no-auth' ? `user_${token.substring(0, 16)}` : 'unknown';

    if (senderTasks.has(userId) && senderLastProgress.has(userId)) {
      sock.emit('sender:running', true);
      sock.emit('sender:progress', senderLastProgress.get(userId));
    }

    if (senderLastComplete.has(userId)) {
      sock.emit('sender:complete', senderLastComplete.get(userId));
      senderLastComplete.delete(userId);
    }
  }

  // ═══════════════════════════════════════════════════
  //  SCREENCAST: Запуск трансляции
  // ═══════════════════════════════════════════════════

  sock.on('screencast:start', async ({ sessionId, quality, maxWidth, maxHeight }) => {
    try {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'ready' || !session.client) {
        return sock.emit('screencast:error', { sessionId, error: 'Аккаунт не готов' });
      }

      const page = session.client.pupPage;
      if (!page) {
        return sock.emit('screencast:error', { sessionId, error: 'Браузер не готов. Подождите полной загрузки.' });
      }

      const key = `${sessionId}_${sock.id}`;
      const existing = screencastState.get(key);
      if (existing) {
        try {
          await existing.cdpSession.send('Page.stopScreencast');
          await existing.cdpSession.detach();
        } catch (e) { }
        screencastState.delete(key);
      }

      const vw = maxWidth || 1280;
      const vh = maxHeight || 800;
      try {
        await page.setViewport({ width: vw, height: vh });
      } catch (e) {
        console.log(`[SCREENCAST] Viewport warning: ${e.message}`);
      }

      const cdpSession = await page.target().createCDPSession();

      cdpSession.on('Page.screencastFrame', async ({ data, metadata, sessionId: frameId }) => {
        try {
          await cdpSession.send('Page.screencastFrameAck', { sessionId: frameId });
          sock.emit('screencast:frame', { sessionId, data, metadata });
        } catch (e) { }
      });

      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: quality || 40,
        maxWidth: vw,
        maxHeight: vh,
        everyNthFrame: 1
      });

      screencastState.set(key, { cdpSession, sessionId });
      console.log(`[SCREENCAST] Started: ${session.displayName} → ${sock.id}`);
      sock.emit('screencast:started', { sessionId });

    } catch (err) {
      console.error(`[SCREENCAST] Start error:`, err.message);
      sock.emit('screencast:error', { sessionId, error: err.message });
    }
  });

  sock.on('screencast:stop', async ({ sessionId }) => {
    const key = `${sessionId}_${sock.id}`;
    const state = screencastState.get(key);
    if (state) {
      try {
        await state.cdpSession.send('Page.stopScreencast');
        await state.cdpSession.detach();
      } catch (e) { }
      screencastState.delete(key);
      console.log(`[SCREENCAST] Stopped: ${sessionId} → ${sock.id}`);
    }
  });

  sock.on('screencast:click', async ({ sessionId, x, y, button }) => {
    try {
      const session = sessions.get(sessionId);
      const page = session?.client?.pupPage;
      if (!page) return;
      await page.mouse.click(Math.round(x), Math.round(y), { button: button || 'left' });
    } catch (e) {
      console.log(`[SCREENCAST] Click error: ${e.message}`);
    }
  });

  sock.on('screencast:scroll', async ({ sessionId, x, y, deltaX, deltaY }) => {
    try {
      const session = sessions.get(sessionId);
      const page = session?.client?.pupPage;
      if (!page) return;
      await page.mouse.move(Math.round(x), Math.round(y));
      await page.mouse.wheel({ deltaX: deltaX || 0, deltaY: deltaY || 0 });
    } catch (e) {
      console.log(`[SCREENCAST] Scroll error: ${e.message}`);
    }
  });

  sock.on('screencast:type', async ({ sessionId, text }) => {
    try {
      const session = sessions.get(sessionId);
      const page = session?.client?.pupPage;
      if (!page) return;
      await page.keyboard.type(text, { delay: 30 });
    } catch (e) {
      console.log(`[SCREENCAST] Type error: ${e.message}`);
    }
  });

  sock.on('screencast:keypress', async ({ sessionId, key }) => {
    try {
      const session = sessions.get(sessionId);
      const page = session?.client?.pupPage;
      if (!page) return;
      await page.keyboard.press(key);
    } catch (e) {
      console.log(`[SCREENCAST] Keypress error: ${e.message}`);
    }
  });

  sock.on('disconnect', (reason) => {
    console.log(`[WS] Client disconnected: ${sock.id} (${reason})`);

    for (const [key, state] of screencastState) {
      if (key.endsWith(`_${sock.id}`)) {
        try {
          state.cdpSession.send('Page.stopScreencast').catch(() => { });
          state.cdpSession.detach().catch(() => { });
        } catch (e) { }
        screencastState.delete(key);
        console.log(`[SCREENCAST] Cleaned up: ${key}`);
      }
    }
  });
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/api', authMiddleware);

const upload = multer({ dest: 'uploads/' });

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DATA_DIR = path.join(DATA_DIR, '.wwebjs_auth');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

['data', 'uploads'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ─── Хранилище ──────────────────────────────────────────
const sessions = new Map();

// ═══════════════════════════════════════════════════════
//  МНОГОПОЛЬЗОВАТЕЛЬСКИЕ ЗАДАЧИ
//  Каждый socket.id имеет свою независимую задачу
// ═══════════════════════════════════════════════════════

const senderTasks = new Map(); // socketId → { controller, running }
const checkerTasks = new Map(); // socketId → { controller, running }
const warmerTasks = new Map(); // socketId → { controller, running }

// ═══ НОВОЕ: кеш последнего прогресса для переподключившихся клиентов ═══
const senderLastProgress = new Map(); // userId → { sent, remaining, account }
const senderLastComplete = new Map(); // userId → { totalSent }

// ═══════════════════════════════════════════════════════
//  CDP SCREENCAST (Live View)
// ═══════════════════════════════════════════════════════

const screencastState = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
//  ОЧИСТКА ФАЙЛОВ CHROMIUM
// ═══════════════════════════════════════════════════════

function cleanupStaleLocks(sessionId) {
  const profileDir = path.join(AUTH_DATA_DIR, `session-${sessionId}`);
  if (!fs.existsSync(profileDir)) return;

  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

  function removeLocks(dir) {
    lockFiles.forEach(f => {
      const p = path.join(dir, f);
      try {
        fs.lstatSync(p);
        fs.unlinkSync(p);
        console.log(`[CLEANUP] Removed lock: ${p}`);
      } catch (e) { }
    });
  }

  removeLocks(profileDir);

  try {
    fs.readdirSync(profileDir, { withFileTypes: true })
      .filter(d => {
        try { return d.isDirectory(); } catch (e) { return false; }
      })
      .forEach(d => removeLocks(path.join(profileDir, d.name)));
  } catch (e) { }
}

function cleanupCacheFiles(sessionId) {
  const profileDir = path.join(AUTH_DATA_DIR, `session-${sessionId}`);
  if (!fs.existsSync(profileDir)) return;

  // ═══ ИСПРАВЛЕНО: убраны IndexedDB, Local Storage, Session Storage ═══
  // Они содержат данные авторизации WhatsApp!
  const cacheDirs = [
    'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache',
    'ShaderCache'
  ];

  function cleanDir(baseDir) {
    cacheDirs.forEach(dir => {
      const p = path.join(baseDir, dir);
      try {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch (e) { }
    });
  }

  cleanDir(profileDir);
  const defaultDir = path.join(profileDir, 'Default');
  if (fs.existsSync(defaultDir)) cleanDir(defaultDir);

  console.log(`[CLEANUP] Caches cleared for ${sessionId}`);
}

function removeSessionDir(sessionId) {
  const profileDir = path.join(AUTH_DATA_DIR, `session-${sessionId}`);
  try {
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
      console.log(`[CLEANUP] Removed dir: session-${sessionId}`);
    }
  } catch (e) {
    console.error(`[CLEANUP] Failed:`, e.message);
  }
}

function cleanupAllOnStartup() {
  if (!fs.existsSync(AUTH_DATA_DIR)) return;
  console.log('[CLEANUP] Cleaning stale locks and caches...');
  try {
    const dirs = fs.readdirSync(AUTH_DATA_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('session-'));
    dirs.forEach(d => {
      const sessId = d.name.replace('session-', '');
      cleanupStaleLocks(sessId);
      cleanupCacheFiles(sessId);
    });
    console.log(`[CLEANUP] Done. Processed ${dirs.length} session dirs`);
  } catch (e) {
    console.error('[CLEANUP] Error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════
//  СЕССИИ: сохранение/загрузка
// ═══════════════════════════════════════════════════════

function saveSessions() {
  try {
    const data = [];
    sessions.forEach(s => {
      if (s.status === 'ready') {
        data.push({
          id: s.id,
          displayName: s.displayName,
          proxy: s.proxy
        });
      }
    });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    console.log(`[SAVE] ${data.length} sessions`);
  } catch (e) {
    console.error('[SAVE] Error:', e.message);
  }
}

function loadSavedSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    console.log('[RESTORE] No saved sessions');
    return;
  }

  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    if (!raw.trim()) return;

    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length === 0) return;

    console.log(`[RESTORE] Will load ${data.length} sessions sequentially...`);

    // ═══ ПОСЛЕДОВАТЕЛЬНАЯ ЗАГРУЗКА ═══
    // Ждём пока текущая сессия станет ready или упадёт,
    // только потом запускаем следующую
    (async () => {
      for (let i = 0; i < data.length; i++) {
        const sess = data[i];
        if (!sess.id || !sess.displayName) continue;

        console.log(`[RESTORE] ${i + 1}/${data.length}: ${sess.displayName}...`);

        await createSession(sess.id, sess.displayName, sess.proxy);

        // Ждём пока сессия станет ready, auth_failure или пройдёт таймаут
        const maxWait = 120000; // 2 минуты максимум на одну сессию
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
          const session = sessions.get(sess.id);
          if (!session) break;

          if (session.status === 'ready') {
            console.log(`[RESTORE] ${sess.displayName} → ready ✓`);
            break;
          }

          if (session.status === 'auth_failure' || session.status === 'disconnected') {
            console.log(`[RESTORE] ${sess.displayName} → ${session.status} ✗`);
            break;
          }

          await sleep(2000);
        }

        // Проверяем память перед следующей
        const memUsage = process.memoryUsage();
        const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        console.log(`[RESTORE] Memory: ${heapMB}MB heap used`);

        // Пауза между сессиями
        if (i < data.length - 1) {
          console.log(`[RESTORE] Waiting 5s before next...`);
          await sleep(5000);
        }
      }

      console.log(`[RESTORE] All sessions loaded.`);
    })();

  } catch (err) {
    console.error('[RESTORE] Error:', err.message);
  }
}

function generateSafeId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

// ═══════════════════════════════════════════════════════
//  СЕССИИ: управление
// ═══════════════════════════════════════════════════════

function getSessionsList() {
  const list = [];
  sessions.forEach(s => {
    list.push({
      id: s.id,
      displayName: s.displayName,
      status: s.status,
      info: s.info,
      proxy: s.proxy,
      qr: s.qr || null
    });
  });
  return list;
}

function broadcastSessions() {
  try {
    io.emit('sessions:update', getSessionsList());
  } catch (e) { }
}

async function createSession(sessionId, displayName, proxy) {
  if (sessions.has(sessionId)) {
    console.log(`[SKIP] ${sessionId} exists`);
    return;
  }

  console.log(`[CREATE] ${displayName}`);

  cleanupStaleLocks(sessionId);
  cleanupCacheFiles(sessionId);

  const sessionData = {
    id: sessionId,
    displayName,
    client: null,
    status: 'initializing',
    info: null,
    proxy: proxy || null,
    qr: null,
    anonymizedProxy: null
  };

  sessions.set(sessionId, sessionData);
  broadcastSessions();

  try {
    let actualProxy = proxy;

    if (proxy && proxy.includes('@') && proxyChain) {
      try {
        const anonymized = await proxyChain.anonymizeProxy(proxy);
        sessionData.anonymizedProxy = anonymized;
        actualProxy = anonymized;
        console.log(`[PROXY] Auth proxy anonymized: ${proxy.replace(/\/\/.*@/, '//***@')} -> ${anonymized}`);
      } catch (e) {
        console.error(`[PROXY] Anonymize failed: ${e.message}`);
      }
    }

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--disk-cache-size=0',
      '--media-cache-size=0',
      '--js-flags=--max-old-space-size=256'
    ];

    if (actualProxy) puppeteerArgs.push(`--proxy-server=${actualProxy}`);

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: AUTH_DATA_DIR
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: puppeteerArgs,
        timeout: 120000
      },
      qrMaxRetries: 5
    });

    sessionData.client = client;

    client.on('qr', (qr) => {
      if (sessionData.status === 'disconnected' || sessionData.status === 'auth_failure') return;
      console.log(`[QR] ${displayName}`);
      sessionData.status = 'qr';
      sessionData.qr = qr;
      broadcastSessions();
    });

    client.on('authenticated', () => {
      if (sessionData.status === 'authenticated' || sessionData.status === 'ready') return;
      console.log(`[AUTH] ${displayName}`);
      sessionData.status = 'authenticated';
      sessionData.qr = null;
      broadcastSessions();

      setTimeout(() => {
        if (sessionData.status === 'authenticated') {
          console.log(`[AUTH-TIMEOUT] ${displayName} - forcing ready check`);
          try {
            if (client.info && client.info.wid) {
              console.log(`[FORCE-READY] ${displayName}`);
              sessionData.status = 'ready';
              sessionData.info = {
                phone: client.info.wid.user || 'Unknown',
                name: client.info.pushname || displayName
              };
              broadcastSessions();
              saveSessions();
            }
          } catch (e) {
            console.log(`[AUTH-TIMEOUT-ERR] ${e.message}`);
          }
        }
      }, 30000);
    });

    client.on('auth_failure', (msg) => {
      console.error(`[AUTH-FAIL] ${displayName}:`, msg);
      sessionData.status = 'auth_failure';
      sessionData.qr = null;
      broadcastSessions();
    });

    client.on('ready', () => {
      if (sessionData.status === 'ready') return;
      console.log(`[READY] ${displayName}`);
      sessionData.status = 'ready';
      sessionData.qr = null;
      try {
        sessionData.info = {
          phone: client.info?.wid?.user || 'Unknown',
          name: client.info?.pushname || displayName
        };
      } catch (e) {
        sessionData.info = { phone: 'Unknown', name: displayName };
      }
      broadcastSessions();
      saveSessions();
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[LOADING] ${displayName}: ${percent}%`);
    });

    client.on('change_state', (state) => {
      console.log(`[STATE] ${displayName}: ${state}`);

      if (state === 'CONNECTED' && sessionData.status !== 'ready') {
        setTimeout(() => {
          if (sessionData.status !== 'ready') {
            console.log(`[STATE-READY] ${displayName}`);
            sessionData.status = 'ready';
            try {
              sessionData.info = {
                phone: client.info?.wid?.user || 'Unknown',
                name: client.info?.pushname || displayName
              };
            } catch (e) {
              sessionData.info = { phone: 'Unknown', name: displayName };
            }
            broadcastSessions();
            saveSessions();
          }
        }, 3000);
      }
    });

    client.on('disconnected', (reason) => {
      if (sessionData.status === 'disconnected') return;
      console.log(`[DC] ${displayName}:`, reason);
      sessionData.status = 'disconnected';
      sessionData.qr = null;
      broadcastSessions();
    });

    client.on('message', (msg) => {
      if (sessionData.status !== 'ready') {
        console.log(`[MSG-READY] ${displayName} - got message, marking ready`);
        sessionData.status = 'ready';
        try {
          sessionData.info = {
            phone: client.info?.wid?.user || 'Unknown',
            name: client.info?.pushname || displayName
          };
        } catch (e) { }
        broadcastSessions();
        saveSessions();
      }
    });

    console.log(`[INIT] ${displayName}...`);
    client.initialize().catch((err) => {
      console.error(`[INIT-ERR] ${displayName}:`, err.message);
      sessionData.status = 'auth_failure';
      sessionData.qr = null;
      broadcastSessions();
      cleanupCacheFiles(sessionId);
    });

  } catch (err) {
    console.error(`[CREATE-ERR] ${displayName}:`, err.message);
    sessionData.status = 'auth_failure';
    broadcastSessions();
    cleanupCacheFiles(sessionId);
  }
}

function getNextReadyAccount(sessionIds, accountMsgCounts, msgsPerAccount, startIdx) {
  for (let i = 0; i < sessionIds.length; i++) {
    const idx = (startIdx + i) % sessionIds.length;
    const id = sessionIds[idx];
    const session = sessions.get(id);
    if (session?.status === 'ready' && session.client &&
      (msgsPerAccount <= 0 || (accountMsgCounts[id] || 0) < msgsPerAccount)) {
      return { session, index: idx };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  Идентификация пользователя по auth-токену (стабильный)
//  socket.id меняется при переподключении — нельзя использовать
// ═══════════════════════════════════════════════════════

function getUserId(req) {
  const token = req.headers['x-auth-token'];
  if (token && token !== 'no-auth') return `user_${token.substring(0, 16)}`;
  const socketId = req.headers['x-socket-id'];
  if (socketId) return socketId;
  return 'unknown';
}

function createEmitter(req) {
  const authToken = req.headers['x-auth-token'];

  return function emitToUser(event, data) {
    try {
      // Ищем ЖИВОЙ сокет каждый раз при вызове (не один раз при старте)
      for (const [, sock] of io.sockets.sockets) {
        if (
          sock.connected &&
          sock.handshake.auth?.token === authToken
        ) {
          sock.emit(event, data);
          return;
        }
      }
      // Сокет не найден — клиент временно отключён, пропускаем
    } catch (e) {
      // Игнорируем ошибки эмита
    }
  };
}

// ═══════════════════════════════════════════════════════
//  API
// ═══════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!AUTH_PASSWORD) {
    return res.json({ token: 'no-auth', needsAuth: false });
  }
  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const token = generateToken();
  authTokens.add(token);
  res.json({ token, needsAuth: true });
});

app.get('/api/auth/check', (req, res) => {
  if (!AUTH_PASSWORD) {
    return res.json({ needsAuth: false, authenticated: true });
  }
  const token = req.headers['x-auth-token'];
  const isAuthenticated = !!(token && authTokens.has(token));
  res.json({ needsAuth: true, authenticated: isAuthenticated });
});

app.get('/api/sessions', (req, res) => {
  res.json(getSessionsList());
});

app.post('/api/sessions', (req, res) => {
  const { name, proxy } = req.body;
  const displayName = (name || '').trim();

  if (!displayName) {
    return res.status(400).json({ error: 'Введите название' });
  }

  for (const [, s] of sessions) {
    if (s.displayName === displayName) {
      return res.status(400).json({ error: 'Такое имя уже есть' });
    }
  }

  const sessionId = generateSafeId();
  createSession(sessionId, displayName, proxy || null);
  res.json({ message: 'Создание...', id: sessionId });
});

app.post('/api/sessions/:id/reconnect', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Не найдено' });

  const { displayName, proxy, id: sessionId } = session;

  console.log(`[RECONNECT] ${displayName}...`);

  try {
    if (session.client) {
      await session.client.destroy().catch(() => { });
    }
  } catch (e) {
    console.log(`[RECONNECT] Destroy warning: ${e.message}`);
  }

  if (session.anonymizedProxy && proxyChain) {
    try {
      await proxyChain.closeAnonymizedProxy(session.anonymizedProxy, true);
      console.log(`[PROXY] Closed anonymized proxy for ${displayName}`);
    } catch (e) { }
  }

  sessions.delete(sessionId);
  broadcastSessions();

  cleanupStaleLocks(sessionId);
  cleanupCacheFiles(sessionId);

  await sleep(2000);

  createSession(sessionId, displayName, proxy);

  res.json({ message: 'Переподключение...' });
});

app.delete('/api/sessions/:id', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Не найдено' });

  const sessionId = req.params.id;

  try {
    if (session.client) await session.client.destroy().catch(() => { });
  } catch (e) { }

  if (session.anonymizedProxy && proxyChain) {
    try {
      await proxyChain.closeAnonymizedProxy(session.anonymizedProxy, true);
      console.log(`[PROXY] Closed anonymized proxy for ${session.displayName}`);
    } catch (e) { }
  }

  sessions.delete(sessionId);
  broadcastSessions();
  saveSessions();

  setTimeout(() => {
    removeSessionDir(sessionId);
  }, 1000);

  res.json({ message: 'Удалено' });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const raw = fs.readFileSync(req.file.path, 'utf-8');
  const numbers = raw.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
  const filePath = path.join(DATA_DIR, `numbers_${Date.now()}.txt`);
  fs.writeFileSync(filePath, numbers.join('\n'));
  fs.unlinkSync(req.file.path);
  res.json({ path: filePath, count: numbers.length });
});

// ═══════════════════════════════════════════════════════
//  РАССЫЛКА (многопользовательская)
// ═══════════════════════════════════════════════════════

app.post('/api/sender/start', (req, res) => {
  const userId = getUserId(req);

  if (senderTasks.has(userId)) {
    return res.status(400).json({ error: 'У вас уже запущена рассылка' });
  }

  const { sessionIds, numbersFilePath, messageTemplate,
    msgsPerAccount, totalMessages, typingDelayMin, typingDelayMax,
    pauseAfterMsgs, pauseDurationMin, pauseDurationMax } = req.body;

  if (!numbersFilePath) {
    return res.status(400).json({ error: 'Файл не указан. Загрузите файл с номерами.' });
  }

  if (!fs.existsSync(numbersFilePath)) {
    return res.status(400).json({ error: 'Файл не найден на сервере. Загрузите файл заново.' });
  }

  if (!sessionIds || !sessionIds.length) {
    return res.status(400).json({ error: 'Не выбраны аккаунты' });
  }

  if (!messageTemplate || !messageTemplate.trim()) {
    return res.status(400).json({ error: 'Не указан шаблон сообщения' });
  }

  const numbers = fs.readFileSync(numbersFilePath, 'utf-8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Файл пустой' });

  const controller = { aborted: false };
  const emitToUser = createEmitter(req);
  senderTasks.set(userId, { controller, running: true });

  (async () => {
    let totalSent = 0;
    const accountMsgCounts = {};
    let currentIdx = 0;

    try {
      for (let i = 0; i < numbers.length; i++) {
        if (controller.aborted) {
          emitToUser('sender:log', '-- Стоп');
          break;
        }
        if (totalMessages > 0 && totalSent >= totalMessages) break;

        const found = getNextReadyAccount(sessionIds, accountMsgCounts, msgsPerAccount, currentIdx);
        if (!found) {
          emitToUser('sender:log', '[!] Нет доступных аккаунтов');
          break;
        }

        const { session, index } = found;
        currentIdx = index;

        const num = numbers[i].replace(/[^\d]/g, '');
        if (!num) continue;

        const chatId = `${num}@c.us`;
        const message = parseSpintax(messageTemplate);

        try {
          if (controller.aborted) break;

          try {
            const chat = await session.client.getChatById(chatId);
            await chat.sendStateTyping();
          } catch (_) { }

          const delay = (Math.random() * (typingDelayMax - typingDelayMin) + typingDelayMin) * 1000;
          const start = Date.now();
          while (Date.now() - start < delay && !controller.aborted) await sleep(200);
          if (controller.aborted) break;

          await session.client.sendMessage(chatId, message);
          totalSent++;
          accountMsgCounts[session.id] = (accountMsgCounts[session.id] || 0) + 1;
          currentIdx = (currentIdx + 1) % sessionIds.length;

          const progressData = { sent: totalSent, remaining: numbers.length - i - 1, account: session.displayName };
          senderLastProgress.set(userId, progressData);
          emitToUser('sender:progress', progressData);
          emitToUser('sender:log', `[OK] ${session.displayName} -> +${num}`);

          if (pauseAfterMsgs > 0 && totalSent % pauseAfterMsgs === 0) {
            const dur = (Math.random() * (pauseDurationMax - pauseDurationMin) + pauseDurationMin) * 1000;
            emitToUser('sender:log', `[PAUSE] ${Math.round(dur / 1000)}s`);
            const ps = Date.now();
            while (Date.now() - ps < dur && !controller.aborted) await sleep(300);
          }
        } catch (err) {
          emitToUser('sender:log', `[ERR] +${num}: ${err.message}`);
          currentIdx = (currentIdx + 1) % sessionIds.length;
        }
      }
    } catch (err) {
      emitToUser('sender:error', err.message);
    } finally {
      senderTasks.delete(userId);
      senderLastComplete.set(userId, { totalSent });
      senderLastProgress.delete(userId);
      emitToUser('sender:complete', { totalSent });
      // Очистить через 5 минут
      setTimeout(() => senderLastComplete.delete(userId), 5 * 60 * 1000);
      emitToUser('sender:log', `[DONE] Отправлено: ${totalSent}`);
      console.log(`[SENDER] Finished for ${userId}: ${totalSent} sent`);
    }
  })();

  res.json({ message: 'Запущено' });
});

app.post('/api/sender/stop', (req, res) => {
  const userId = getUserId(req);
  const task = senderTasks.get(userId);
  if (task) {
    task.controller.aborted = true;
  }
  res.json({ message: 'Стоп' });
});

// ═══════════════════════════════════════════════════════
//  ЧЕКЕР (многопользовательский)
// ═══════════════════════════════════════════════════════

app.post('/api/checker/start', (req, res) => {
  const userId = getUserId(req);

  if (checkerTasks.has(userId)) {
    return res.status(400).json({ error: 'У вас уже запущена проверка' });
  }

  const { sessionId, numbersFilePath } = req.body;

  if (!fs.existsSync(numbersFilePath)) return res.status(400).json({ error: 'Нет файла' });

  const numbers = fs.readFileSync(numbersFilePath, 'utf-8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Пусто' });

  const controller = { aborted: false };
  const emitToUser = createEmitter(req);
  checkerTasks.set(userId, { controller, running: true });

  (async () => {
    const session = sessions.get(sessionId);
    if (!session?.client || session.status !== 'ready') {
      emitToUser('checker:error', 'Аккаунт не готов');
      checkerTasks.delete(userId);
      return;
    }

    const valid = [];
    let checked = 0;

    for (const raw of numbers) {
      if (controller.aborted) {
        emitToUser('checker:log', '-- Стоп');
        break;
      }

      const num = raw.replace(/[^\d]/g, '');
      if (!num) { checked++; continue; }

      try {
        const result = await session.client.getNumberId(num);
        if (result) {
          valid.push(num);
          emitToUser('checker:log', `[YES] +${num}`);
        } else {
          emitToUser('checker:log', `[NO] +${num}`);
        }
      } catch {
        emitToUser('checker:log', `[ERR] +${num}`);
      }

      checked++;
      emitToUser('checker:progress', { checked, total: numbers.length, valid: valid.length });

      const ws = Date.now();
      while (Date.now() - ws < 1500 && !controller.aborted) await sleep(200);
    }

    const resultFilename = `valid_${Date.now()}.txt`;
    const outPath = path.join(DATA_DIR, resultFilename);
    fs.writeFileSync(outPath, valid.join('\n'));

    emitToUser('checker:complete', { total: numbers.length, valid: valid.length, filename: resultFilename });
    emitToUser('checker:log', `[DONE] ${valid.length}/${numbers.length}`);
    checkerTasks.delete(userId);
    console.log(`[CHECKER] Finished for ${userId}: ${valid.length}/${numbers.length}`);
  })();

  res.json({ message: 'Запущено' });
});

app.post('/api/checker/stop', (req, res) => {
  const userId = getUserId(req);
  const task = checkerTasks.get(userId);
  if (task) {
    task.controller.aborted = true;
  }
  res.json({ message: 'Стоп' });
});

// ═══════════════════════════════════════════════════════
//  ПРОГРЕВ (многопользовательский)
// ═══════════════════════════════════════════════════════

app.post('/api/warmer/start', (req, res) => {
  const userId = getUserId(req);

  if (warmerTasks.has(userId)) {
    return res.status(400).json({ error: 'У вас уже запущен прогрев' });
  }

  const { sessionIds, numbersFilePath, msgsPerAccount, totalMessages,
    typingDelayMin, typingDelayMax, pauseAfterMsgs, pauseDurationMin, pauseDurationMax } = req.body;

  if (!numbersFilePath) {
    return res.status(400).json({ error: 'Файл не указан. Загрузите файл с номерами.' });
  }

  if (!fs.existsSync(numbersFilePath)) {
    return res.status(400).json({ error: 'Файл не найден на сервере. Загрузите файл заново.' });
  }

  const numbers = fs.readFileSync(numbersFilePath, 'utf-8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Пусто' });

  const controller = { aborted: false };
  const emitToUser = createEmitter(req);
  warmerTasks.set(userId, { controller, running: true });

  (async () => {
    let totalSent = 0;
    const accountMsgCounts = {};
    let currentIdx = 0;

    for (let i = 0; i < numbers.length; i++) {
      if (controller.aborted) {
        emitToUser('warmer:log', '-- Стоп');
        break;
      }
      if (totalMessages > 0 && totalSent >= totalMessages) break;

      const found = getNextReadyAccount(sessionIds, accountMsgCounts, msgsPerAccount, currentIdx);
      if (!found) {
        emitToUser('warmer:log', '[!] Нет доступных аккаунтов');
        break;
      }

      const { session, index } = found;
      currentIdx = index;

      const num = numbers[i].replace(/[^\d]/g, '');
      if (!num) continue;

      try {
        if (controller.aborted) break;

        try {
          const chat = await session.client.getChatById(`${num}@c.us`);
          await chat.sendStateTyping();
        } catch { }

        const delay = (Math.random() * (typingDelayMax - typingDelayMin) + typingDelayMin) * 1000;
        const ds = Date.now();
        while (Date.now() - ds < delay && !controller.aborted) await sleep(200);
        if (controller.aborted) break;

        await session.client.sendMessage(`${num}@c.us`, generateRandomMessage());
        totalSent++;
        accountMsgCounts[session.id] = (accountMsgCounts[session.id] || 0) + 1;
        currentIdx = (currentIdx + 1) % sessionIds.length;

        emitToUser('warmer:progress', { sent: totalSent, remaining: numbers.length - i - 1 });
        emitToUser('warmer:log', `[OK] ${session.displayName} -> +${num}`);

        if (pauseAfterMsgs > 0 && totalSent % pauseAfterMsgs === 0) {
          const dur = (Math.random() * (pauseDurationMax - pauseDurationMin) + pauseDurationMin) * 1000;
          const ps = Date.now();
          while (Date.now() - ps < dur && !controller.aborted) await sleep(300);
        }
      } catch (err) {
        emitToUser('warmer:log', `[ERR] ${err.message}`);
        currentIdx = (currentIdx + 1) % sessionIds.length;
      }
    }

    warmerTasks.delete(userId);
    emitToUser('warmer:complete', { totalSent });
    emitToUser('warmer:log', `[DONE] Отправлено: ${totalSent}`);
    console.log(`[WARMER] Finished for ${userId}: ${totalSent} sent`);
  })();

  res.json({ message: 'Запущено' });
});

app.post('/api/warmer/stop', (req, res) => {
  const userId = getUserId(req);
  const task = warmerTasks.get(userId);
  if (task) {
    task.controller.aborted = true;
  }
  res.json({ message: 'Стоп' });
});

app.get('/api/status', (req, res) => {
  const userId = getUserId(req);
  res.json({
    sender: senderTasks.has(userId),
    checker: checkerTasks.has(userId),
    warmer: warmerTasks.has(userId)
  });
});

// ─── СКАЧИВАНИЕ РЕЗУЛЬТАТОВ ─────────────────────────────

app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  res.download(filePath, filename);
});

// ─── ТЕСТ ПРОКСИ ────────────────────────────────────────

app.post('/api/test-proxy', async (req, res) => {
  const { proxy } = req.body;
  if (!proxy) return res.status(400).json({ error: 'Укажите прокси' });

  console.log(`[PROXY-TEST] Testing: ${proxy.replace(/\/\/.*@/, '//***@')}`);

  const startTime = Date.now();

  try {
    let testTarget = proxy;
    let anonymized = null;

    if (proxy.includes('@') && proxyChain) {
      try {
        anonymized = await proxyChain.anonymizeProxy(proxy);
        testTarget = anonymized;
        console.log(`[PROXY-TEST] Anonymized for test: ${anonymized}`);
      } catch (e) {
        return res.json({ success: false, error: `Proxy auth failed: ${e.message}` });
      }
    }

    const url = new URL(testTarget);
    const httpModule = require('http');

    const options = {
      host: url.hostname,
      port: url.port,
      method: 'CONNECT',
      path: 'web.whatsapp.com:443',
      timeout: 15000
    };

    const testReq = httpModule.request(options);

    testReq.on('connect', (response) => {
      const elapsed = Date.now() - startTime;
      console.log(`[PROXY-TEST] OK: ${response.statusCode} in ${elapsed}ms`);
      testReq.destroy();
      if (anonymized && proxyChain) proxyChain.closeAnonymizedProxy(anonymized, true).catch(() => { });
      res.json({ success: true, status: response.statusCode, timeMs: elapsed });
    });

    testReq.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      console.log(`[PROXY-TEST] FAIL: ${err.message} in ${elapsed}ms`);
      if (anonymized && proxyChain) proxyChain.closeAnonymizedProxy(anonymized, true).catch(() => { });
      res.json({ success: false, error: err.message, timeMs: elapsed });
    });

    testReq.on('timeout', () => {
      const elapsed = Date.now() - startTime;
      console.log(`[PROXY-TEST] TIMEOUT in ${elapsed}ms`);
      testReq.destroy();
      if (anonymized && proxyChain) proxyChain.closeAnonymizedProxy(anonymized, true).catch(() => { });
      res.json({ success: false, error: 'Timeout (15s)', timeMs: elapsed });
    });

    testReq.end();
  } catch (err) {
    console.log(`[PROXY-TEST] ERROR: ${err.message}`);
    res.json({ success: false, error: err.message });
  }
});

// ─── ПОИСК РАБОЧИХ ПРОКСИ ──────────────────────────────

app.post('/api/find-proxy', async (req, res) => {
  console.log('[PROXY-FIND] Fetching proxy lists...');

  const https = require('https');
  const httpMod = require('http');

  function fetchList(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : httpMod;
      mod.get(url, { timeout: 10000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve(data));
      }).on('error', () => resolve(''));
    });
  }

  function testProxy(proxyHost, proxyPort, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const req = httpMod.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: 'web.whatsapp.com:443',
        timeout: timeoutMs
      });

      req.on('connect', (response) => {
        const elapsed = Date.now() - start;
        req.destroy();
        resolve({ host: proxyHost, port: proxyPort, ok: true, ms: elapsed, status: response.statusCode });
      });

      req.on('error', () => { req.destroy(); resolve({ host: proxyHost, port: proxyPort, ok: false }); });
      req.on('timeout', () => { req.destroy(); resolve({ host: proxyHost, port: proxyPort, ok: false }); });
      req.end();
    });
  }

  try {
    const [list1, list2, list3] = await Promise.all([
      fetchList('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'),
      fetchList('https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'),
      fetchList('https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt')
    ]);

    const allText = list1 + '\n' + list2 + '\n' + list3;
    const allProxies = [...new Set(
      allText.split('\n').map(l => l.trim()).filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
    )];

    console.log(`[PROXY-FIND] Got ${allProxies.length} unique proxies, testing...`);

    const working = [];
    const batchSize = 50;

    for (let i = 0; i < Math.min(allProxies.length, 500) && working.length < 5; i += batchSize) {
      const batch = allProxies.slice(i, i + batchSize).map(p => {
        const [host, port] = p.split(':');
        return testProxy(host, parseInt(port), 8000);
      });

      const results = await Promise.all(batch);
      results.filter(r => r.ok).forEach(r => working.push(r));

      console.log(`[PROXY-FIND] Tested ${Math.min(i + batchSize, allProxies.length)}/${Math.min(allProxies.length, 500)}, found ${working.length} working`);

      if (working.length >= 5) break;
    }

    console.log(`[PROXY-FIND] Done. Found ${working.length} working proxies`);
    working.sort((a, b) => a.ms - b.ms);

    res.json({
      tested: Math.min(allProxies.length, 500),
      found: working.length,
      proxies: working.slice(0, 10).map(p => ({
        proxy: `http://${p.host}:${p.port}`,
        responseMs: p.ms
      }))
    });
  } catch (err) {
    console.error('[PROXY-FIND] Error:', err.message);
    res.json({ tested: 0, found: 0, proxies: [], error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  СТАРТ
// ═══════════════════════════════════════════════════════

const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));

  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
      res.sendFile(path.join(clientBuildPath, 'index.html'));
    }
  });

  console.log('[OK] Serving client build');
}

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=== Server: http://localhost:${PORT} ===\n`);
  cleanupAllOnStartup();
  setTimeout(loadSavedSessions, 3000);
});