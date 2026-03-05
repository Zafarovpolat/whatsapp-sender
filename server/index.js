const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  transports: ['websocket', 'polling']
});

// При каждом подключении (и переподключении) — сразу шлём текущее состояние
io.on('connection', (sock) => {
  console.log(`[WS] Client connected: ${sock.id}`);
  sock.emit('sessions:update', getSessionsList());
  sock.on('disconnect', (reason) => {
    console.log(`[WS] Client disconnected: ${sock.id} (${reason})`);
  });
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: 'uploads/' });

const DATA_DIR = path.join(__dirname, 'data');
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
//  СЕССИИ: сохранение/загрузка
// ═══════════════════════════════════════════════════════

function saveSessions() {
  try {
    const data = [];
    sessions.forEach(s => {
      // Сохраняем ТОЛЬКО авторизованные сессии
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
        }, index * 5000); // 5 секунд между сессиями
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
    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions'
    ];

    if (proxy) puppeteerArgs.push(`--proxy-server=${proxy}`);

const client = new Client({
  authStrategy: new LocalAuth({ clientId: sessionId }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
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
      '--js-flags="--max-old-space-size=256"'
    ],
    timeout: 120000
  },
  qrMaxRetries: 10
});

    sessionData.client = client;

    // ─── QR ─────────────────────────────────────────
    client.on('qr', (qr) => {
      console.log(`[QR] ${displayName}`);
      sessionData.status = 'qr';
      sessionData.qr = qr;
      broadcastSessions();
    });

    // ─── Authenticated ──────────────────────────────
    client.on('authenticated', () => {
      console.log(`[AUTH] ${displayName}`);
      sessionData.status = 'authenticated';
      sessionData.qr = null;
      broadcastSessions();
      
      // Таймер на случай если ready не сработает
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
      }, 30000); // 30 секунд таймаут
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
      console.log(`[DC] ${displayName}:`, reason);
      sessionData.status = 'disconnected';
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
      broadcastSessions();
    });

  } catch (err) {
    console.error(`[CREATE-ERR] ${displayName}:`, err.message);
    sessionData.status = 'auth_failure';
    broadcastSessions();
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

app.delete('/api/sessions/:id', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Не найдено' });

  try {
    if (session.client) await session.client.destroy();
  } catch (e) {}

  sessions.delete(req.params.id);
  broadcastSessions();
  saveSessions();
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

    const desktop = path.join(os.homedir(), 'Desktop');
    const outPath = path.join(fs.existsSync(desktop) ? desktop : DATA_DIR, `valid_${Date.now()}.txt`);
    fs.writeFileSync(outPath, valid.join('\n'));

    io.emit('checker:complete', { total: numbers.length, valid: valid.length });
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

// ═══════════════════════════════════════════════════════
//  СТАРТ
// ═══════════════════════════════════════════════════════

// Раздача статики (билд клиента)
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  
  // Все остальные запросы → index.html (SPA)
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
  setTimeout(loadSavedSessions, 2000);
});