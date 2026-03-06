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

// Защита Socket.IO
io.use((socket, next) => {
  if (!AUTH_PASSWORD) return next();
  const token = socket.handshake.auth?.token;
  if (!token || !authTokens.has(token)) {
    return next(new Error('Unauthorized'));
  }
  next();
});

io.on('connection', (sock) => {
  console.log(`[WS] Client connected: ${sock.id}`);
  sock.emit('sessions:update', getSessionsList());
  sock.on('disconnect', (reason) => {
    console.log(`[WS] Client disconnected: ${sock.id} (${reason})`);
  });
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/api', authMiddleware);

const upload = multer({ dest: 'uploads/' });

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DATA_DIR = path.join(DATA_DIR, '.wwebjs_auth');   // ← ДОБАВЛЕНО: отдельная константа
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

['data', 'uploads'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ─── Хранилище ──────────────────────────────────────────
const sessions = new Map();

let senderState  = { running: false, controller: null };
let checkerState = { running: false, controller: null };
let warmerState  = { running: false, controller: null };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
//  ДОБАВЛЕНО: ОЧИСТКА ФАЙЛОВ CHROMIUM
// ═══════════════════════════════════════════════════════

/**
 * Удаляет stale lock-файлы Chromium (остаются после краша/рестарта)
 */
function cleanupStaleLocks(sessionId) {
  const profileDir = path.join(AUTH_DATA_DIR, `session-${sessionId}`);
  if (!fs.existsSync(profileDir)) return;

  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

  function removeLocks(dir) {
    lockFiles.forEach(f => {
      const p = path.join(dir, f);
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          console.log(`[CLEANUP] Removed lock: ${p}`);
        }
      } catch (e) {}
    });
  }

  removeLocks(profileDir);

  // Также вложенные директории
  try {
    fs.readdirSync(profileDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .forEach(d => removeLocks(path.join(profileDir, d.name)));
  } catch (e) {}
}

/**
 * Чистит кэш-директории Chromium (~200-500MB на сессию)
 */
function cleanupCacheFiles(sessionId) {
  const profileDir = path.join(AUTH_DATA_DIR, `session-${sessionId}`);
  if (!fs.existsSync(profileDir)) return;

  const cacheDirs = [
    'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache',
    'ShaderCache', 'Service Worker', 'blob_storage',
    'IndexedDB', 'Local Storage', 'Session Storage'
  ];

  function cleanDir(baseDir) {
    cacheDirs.forEach(dir => {
      const p = path.join(baseDir, dir);
      try {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch (e) {}
    });
  }

  cleanDir(profileDir);
  const defaultDir = path.join(profileDir, 'Default');
  if (fs.existsSync(defaultDir)) cleanDir(defaultDir);

  console.log(`[CLEANUP] Caches cleared for ${sessionId}`);
}

/**
 * Полностью удаляет директорию профиля сессии
 */
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

/**
 * Чистит ВСЕ lock-файлы и кэши при старте сервера
 */
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
    
    console.log(`[RESTORE] Loading ${data.length} sessions...`);
    
    data.forEach((sess, index) => {
      if (sess.id && sess.displayName) {
        setTimeout(() => {
          createSession(sess.id, sess.displayName, sess.proxy);
        }, index * 5000);
      }
    });
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
  } catch (e) {}
}

function createSession(sessionId, displayName, proxy) {
  if (sessions.has(sessionId)) {
    console.log(`[SKIP] ${sessionId} exists`);
    return;
  }

  console.log(`[CREATE] ${displayName}`);

  // ═══ ДОБАВЛЕНО: чистим lock-файлы и кэш ПЕРЕД запуском ═══
  cleanupStaleLocks(sessionId);
  cleanupCacheFiles(sessionId);

  const sessionData = {
    id: sessionId,
    displayName,
    client: null,
    status: 'initializing',
    info: null,
    proxy: proxy || null,
    qr: null
  };

  sessions.set(sessionId, sessionData);
  broadcastSessions();

  try {
    // ═══ ИСПРАВЛЕНО: один массив args, с прокси, с отключением кэша ═══
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

    if (proxy) puppeteerArgs.push(`--proxy-server=${proxy}`);

    const client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: sessionId,
        dataPath: AUTH_DATA_DIR
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: puppeteerArgs,   // ← ИСПРАВЛЕНО: был хардкод, прокси не применялся
        timeout: 120000
      },
      qrMaxRetries: 5          // ← ИЗМЕНЕНО: было 10, уменьшено чтобы не спамить
    });

    sessionData.client = client;

    // ─── QR ─────────────────────────────────────────
    client.on('qr', (qr) => {
      // ═══ ДОБАВЛЕНО: guard — не обрабатываем если уже отключен ═══
      if (sessionData.status === 'disconnected' || sessionData.status === 'auth_failure') return;
      console.log(`[QR] ${displayName}`);
      sessionData.status = 'qr';
      sessionData.qr = qr;
      broadcastSessions();
    });

    // ─── Authenticated ──────────────────────────────
    client.on('authenticated', () => {
      // ═══ ДОБАВЛЕНО: guard — не обрабатываем повторно ═══
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

    // ─── Auth Failure ───────────────────────────────
    client.on('auth_failure', (msg) => {
      console.error(`[AUTH-FAIL] ${displayName}:`, msg);
      sessionData.status = 'auth_failure';
      sessionData.qr = null;
      broadcastSessions();
    });

    // ─── Ready ──────────────────────────────────────
    client.on('ready', () => {
      // ═══ ДОБАВЛЕНО: guard ═══
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

    // ─── Loading Screen ─────────────────────────────
    client.on('loading_screen', (percent, message) => {
      console.log(`[LOADING] ${displayName}: ${percent}%`);
    });

    // ─── State Change (FALLBACK для ready) ──────────
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

    // ─── Disconnected ───────────────────────────────
    client.on('disconnected', (reason) => {
      // ═══ ДОБАВЛЕНО: guard ═══
      if (sessionData.status === 'disconnected') return;
      console.log(`[DC] ${displayName}:`, reason);
      sessionData.status = 'disconnected';
      sessionData.qr = null;
      broadcastSessions();
    });

    // ─── Message (для проверки что клиент работает) ─
    client.on('message', (msg) => {
      if (sessionData.status !== 'ready') {
        console.log(`[MSG-READY] ${displayName} - got message, marking ready`);
        sessionData.status = 'ready';
        try {
          sessionData.info = {
            phone: client.info?.wid?.user || 'Unknown',
            name: client.info?.pushname || displayName
          };
        } catch (e) {}
        broadcastSessions();
        saveSessions();
      }
    });

    // ─── Initialize ─────────────────────────────────
    console.log(`[INIT] ${displayName}...`);
    client.initialize().catch((err) => {
      console.error(`[INIT-ERR] ${displayName}:`, err.message);
      sessionData.status = 'auth_failure';
      sessionData.qr = null;
      broadcastSessions();
      // ═══ ДОБАВЛЕНО: чистим кэш при ошибке ═══
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
//  API
// ═══════════════════════════════════════════════════════

// ─── АУТЕНТИФИКАЦИЯ ─────────────────────────────────────

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

// ═══ ДОБАВЛЕНО: эндпоинт переподключения ═══
app.post('/api/sessions/:id/reconnect', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Не найдено' });

  const { displayName, proxy, id: sessionId } = session;

  console.log(`[RECONNECT] ${displayName}...`);

  // Уничтожаем старый клиент
  try {
    if (session.client) {
      await session.client.destroy().catch(() => {});
    }
  } catch (e) {
    console.log(`[RECONNECT] Destroy warning: ${e.message}`);
  }

  // Удаляем из Map
  sessions.delete(sessionId);
  broadcastSessions();

  // Чистим lock-файлы и кэш
  cleanupStaleLocks(sessionId);
  cleanupCacheFiles(sessionId);

  // Ждём чтобы процессы Chromium завершились
  await sleep(2000);

  // Пересоздаём сессию
  createSession(sessionId, displayName, proxy);

  res.json({ message: 'Переподключение...' });
});

// ═══ ИЗМЕНЕНО: при удалении чистим файлы на диске ═══
app.delete('/api/sessions/:id', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Не найдено' });

  const sessionId = req.params.id;

  try {
    if (session.client) await session.client.destroy().catch(() => {});
  } catch (e) {}

  sessions.delete(sessionId);
  broadcastSessions();
  saveSessions();

  // ═══ ДОБАВЛЕНО: удаляем директорию профиля ═══
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

// ─── РАССЫЛКА ───────────────────────────────────────────

app.post('/api/sender/start', (req, res) => {
  if (senderState.running) return res.status(400).json({ error: 'Уже запущено' });

  const { sessionIds, numbersFilePath, messageTemplate,
    msgsPerAccount, totalMessages, typingDelayMin, typingDelayMax,
    pauseAfterMsgs, pauseDurationMin, pauseDurationMax } = req.body;

  if (!fs.existsSync(numbersFilePath)) {
    return res.status(400).json({ error: 'Файл не найден' });
  }

  const numbers = fs.readFileSync(numbersFilePath, 'utf-8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Файл пустой' });

  const controller = { aborted: false };
  senderState = { running: true, controller };

  (async () => {
    let totalSent = 0;
    const accountMsgCounts = {};
    let currentIdx = 0;

    try {
      for (let i = 0; i < numbers.length; i++) {
        if (controller.aborted) { io.emit('sender:log', '-- Стоп'); break; }
        if (totalMessages > 0 && totalSent >= totalMessages) break;

        const found = getNextReadyAccount(sessionIds, accountMsgCounts, msgsPerAccount, currentIdx);
        if (!found) { io.emit('sender:log', '[!] Нет аккаунтов'); break; }

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
          } catch (_) {}

          const delay = (Math.random() * (typingDelayMax - typingDelayMin) + typingDelayMin) * 1000;
          const start = Date.now();
          while (Date.now() - start < delay && !controller.aborted) await sleep(200);
          if (controller.aborted) break;

          await session.client.sendMessage(chatId, message);
          totalSent++;
          accountMsgCounts[session.id] = (accountMsgCounts[session.id] || 0) + 1;

          io.emit('sender:progress', { sent: totalSent, remaining: numbers.length - i - 1, account: session.displayName });
          io.emit('sender:log', `[OK] ${session.displayName} -> +${num}`);

          if (pauseAfterMsgs > 0 && totalSent % pauseAfterMsgs === 0) {
            const dur = (Math.random() * (pauseDurationMax - pauseDurationMin) + pauseDurationMin) * 1000;
            io.emit('sender:log', `[PAUSE] ${Math.round(dur/1000)}s`);
            const ps = Date.now();
            while (Date.now() - ps < dur && !controller.aborted) await sleep(300);
          }
        } catch (err) {
          io.emit('sender:log', `[ERR] +${num}: ${err.message}`);
          currentIdx = (currentIdx + 1) % sessionIds.length;
        }
      }
    } catch (err) {
      io.emit('sender:error', err.message);
    } finally {
      senderState = { running: false, controller: null };
      io.emit('sender:complete', { totalSent });
      io.emit('sender:log', `[DONE] ${totalSent}`);
    }
  })();

  res.json({ message: 'Запущено' });
});

app.post('/api/sender/stop', (req, res) => {
  if (senderState.controller) senderState.controller.aborted = true;
  res.json({ message: 'Стоп' });
});

// ─── ЧЕКЕР ──────────────────────────────────────────────

app.post('/api/checker/start', (req, res) => {
  if (checkerState.running) return res.status(400).json({ error: 'Уже запущено' });

  const { sessionId, numbersFilePath } = req.body;

  if (!fs.existsSync(numbersFilePath)) return res.status(400).json({ error: 'Нет файла' });

  const numbers = fs.readFileSync(numbersFilePath, 'utf-8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Пусто' });

  const controller = { aborted: false };
  checkerState = { running: true, controller };

  (async () => {
    const session = sessions.get(sessionId);
    if (!session?.client || session.status !== 'ready') {
      io.emit('checker:error', 'Аккаунт не готов');
      checkerState = { running: false, controller: null };
      return;
    }

    const valid = [];
    let checked = 0;

    for (const raw of numbers) {
      if (controller.aborted) { io.emit('checker:log', '-- Стоп'); break; }

      const num = raw.replace(/[^\d]/g, '');
      if (!num) { checked++; continue; }

      try {
        const result = await session.client.getNumberId(num);
        if (result) {
          valid.push(num);
          io.emit('checker:log', `[YES] +${num}`);
        } else {
          io.emit('checker:log', `[NO] +${num}`);
        }
      } catch {
        io.emit('checker:log', `[ERR] +${num}`);
      }

      checked++;
      io.emit('checker:progress', { checked, total: numbers.length, valid: valid.length });

      const ws = Date.now();
      while (Date.now() - ws < 1500 && !controller.aborted) await sleep(200);
    }

    const resultFilename = `valid_${Date.now()}.txt`;
    const outPath = path.join(DATA_DIR, resultFilename);
    fs.writeFileSync(outPath, valid.join('\n'));

    io.emit('checker:complete', { total: numbers.length, valid: valid.length, filename: resultFilename });
    io.emit('checker:log', `[DONE] ${valid.length}/${numbers.length}`);
    checkerState = { running: false, controller: null };
  })();

  res.json({ message: 'Запущено' });
});

app.post('/api/checker/stop', (req, res) => {
  if (checkerState.controller) checkerState.controller.aborted = true;
  res.json({ message: 'Стоп' });
});

// ─── ПРОГРЕВ ────────────────────────────────────────────

app.post('/api/warmer/start', (req, res) => {
  if (warmerState.running) return res.status(400).json({ error: 'Уже запущено' });

  const { sessionIds, numbersFilePath, msgsPerAccount, totalMessages,
    typingDelayMin, typingDelayMax, pauseAfterMsgs, pauseDurationMin, pauseDurationMax } = req.body;

  if (!fs.existsSync(numbersFilePath)) return res.status(400).json({ error: 'Нет файла' });

  const numbers = fs.readFileSync(numbersFilePath, 'utf-8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);

  if (!numbers.length) return res.status(400).json({ error: 'Пусто' });

  const controller = { aborted: false };
  warmerState = { running: true, controller };

  (async () => {
    let totalSent = 0;
    const accountMsgCounts = {};
    let currentIdx = 0;

    for (let i = 0; i < numbers.length; i++) {
      if (controller.aborted) { io.emit('warmer:log', '-- Стоп'); break; }
      if (totalMessages > 0 && totalSent >= totalMessages) break;

      const found = getNextReadyAccount(sessionIds, accountMsgCounts, msgsPerAccount, currentIdx);
      if (!found) { io.emit('warmer:log', '[!] Нет аккаунтов'); break; }

      const { session, index } = found;
      currentIdx = index;

      const num = numbers[i].replace(/[^\d]/g, '');
      if (!num) continue;

      try {
        if (controller.aborted) break;

        try {
          const chat = await session.client.getChatById(`${num}@c.us`);
          await chat.sendStateTyping();
        } catch {}

        const delay = (Math.random() * (typingDelayMax - typingDelayMin) + typingDelayMin) * 1000;
        const ds = Date.now();
        while (Date.now() - ds < delay && !controller.aborted) await sleep(200);
        if (controller.aborted) break;

        await session.client.sendMessage(`${num}@c.us`, generateRandomMessage());
        totalSent++;
        accountMsgCounts[session.id] = (accountMsgCounts[session.id] || 0) + 1;

        io.emit('warmer:progress', { sent: totalSent, remaining: numbers.length - i - 1 });
        io.emit('warmer:log', `[OK] ${session.displayName} -> +${num}`);

        if (pauseAfterMsgs > 0 && totalSent % pauseAfterMsgs === 0) {
          const dur = (Math.random() * (pauseDurationMax - pauseDurationMin) + pauseDurationMin) * 1000;
          const ps = Date.now();
          while (Date.now() - ps < dur && !controller.aborted) await sleep(300);
        }
      } catch (err) {
        io.emit('warmer:log', `[ERR] ${err.message}`);
        currentIdx = (currentIdx + 1) % sessionIds.length;
      }
    }

    warmerState = { running: false, controller: null };
    io.emit('warmer:complete', { totalSent });
    io.emit('warmer:log', `[DONE] ${totalSent}`);
  })();

  res.json({ message: 'Запущено' });
});

app.post('/api/warmer/stop', (req, res) => {
  if (warmerState.controller) warmerState.controller.aborted = true;
  res.json({ message: 'Стоп' });
});

app.get('/api/status', (req, res) => {
  res.json({ sender: senderState.running, checker: checkerState.running, warmer: warmerState.running });
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
  // ═══ ДОБАВЛЕНО: чистим всё при старте ═══
  cleanupAllOnStartup();
  setTimeout(loadSavedSessions, 3000);
});