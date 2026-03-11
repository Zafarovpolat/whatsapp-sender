# WhatsApp Sender — Полная документация проекта

> Веб-платформа для массовой рассылки сообщений через WhatsApp с поддержкой нескольких аккаунтов, прокси, проверки номеров и прогрева.

---

## Оглавление

1. [Обзор проекта](#1-обзор-проекта)
2. [Архитектура](#2-архитектура)
3. [Структура файлов](#3-структура-файлов)
4. [Backend (сервер)](#4-backend-сервер)
   - [Точка входа и инициализация](#41-точка-входа-и-инициализация)
   - [Аутентификация](#42-аутентификация)
   - [Управление сессиями WhatsApp](#43-управление-сессиями-whatsapp)
   - [Рассылка (Sender)](#44-рассылка-sender)
   - [Чекер (Checker)](#45-чекер-checker)
   - [Прогрев (Warmer)](#46-прогрев-warmer)
   - [Прокси](#47-прокси)
   - [Вспомогательные модули](#48-вспомогательные-модули)
   - [REST API — полный справочник](#49-rest-api--полный-справочник)
   - [Socket.IO события](#410-socketio-события)

5. [Frontend (клиент)](#5-frontend-клиент)
   - [Точка входа и роутинг](#51-точка-входа-и-роутинг)
   - [Аутентификация на клиенте](#52-аутентификация-на-клиенте)
   - [Socket.IO обёртка](#53-socketio-обёртка)
   - [Страница: Аккаунты (Accounts)](#54-страница-аккаунты-accounts)
   - [Страница: Рассылка (Sender)](#55-страница-рассылка-sender)
   - [Страница: Чекер (Checker)](#56-страница-чекер-checker)
   - [Страница: Прогрев (Warmer)](#57-страница-прогрев-warmer)
   - [Страница: Логин (Login)](#58-страница-логин-login)
   - [Стили и дизайн-система](#59-стили-и-дизайн-система)

6. [Переменные окружения](#6-переменные-окружения)
7. [Запуск и разработка](#7-запуск-и-разработка)
8. [Docker и деплой](#8-docker-и-деплой)
9. [Потоки данных](#9-потоки-данных)
10. [Известные особенности и ограничения](#10-известные-особенности-и-ограничения)

---

## 1. Обзор проекта

**WhatsApp Sender** — fullstack-приложение, позволяющее:

- Подключать несколько WhatsApp-аккаунтов через QR-код
- Массово рассылать сообщения с поддержкой спинтакса (рандомизация текста)
- Проверять списки номеров на наличие WhatsApp (чекер)
- Прогревать новые аккаунты случайными сообщениями
- Использовать прокси-серверы (включая с авторизацией)
- Управлять всем через веб-интерфейс в стиле WhatsApp

### Стек технологий

| Слой         | Технологии                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **Backend**  | Node.js 18, Express 4, Socket.IO 4, whatsapp-web.js 1.23, Puppeteer (Chromium), multer, proxy-chain |
| **Frontend** | React 19, Vite 7, React Router 7, Axios, socket.io-client 4, qrcode.react                           |
| **Стили**    | Кастомный CSS (Plus Jakarta Sans), WhatsApp-inspired design                                         |
| **Деплой**   | Docker (multi-stage), Railway                                                                       |

---

## 2. Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                        Браузер                              │
│                                                             │
│  ┌─────────┐  ┌────────┐  ┌─────────┐  ┌────────┐         │
│  │Accounts │  │ Sender │  │ Checker │  │ Warmer │         │
│  └────┬────┘  └───┬────┘  └────┬────┘  └───┬────┘         │
│       │           │            │            │               │
│       └───────────┴────────────┴────────────┘               │
│                        │                                    │
│              ┌─────────┴─────────┐                          │
│              │   App.jsx         │                          │
│              │ (Router + Auth)   │                          │
│              └─────────┬─────────┘                          │
│                        │                                    │
│           HTTP (Axios) │ WebSocket (socket.io-client)       │
└────────────────────────┼────────────────────────────────────┘
                        │
                    ┌────┴────┐
                    │  Vite   │  (dev proxy → :3001)
                    │  :5173  │
                    └────┬────┘
                        │
┌────────────────────────┼────────────────────────────────────┐
│                   Express :3001                             │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Auth MW     │  │  REST API    │  │  Socket.IO   │      │
│  │ (x-auth-token│  │  /api/*      │  │  server      │      │
│  │  middleware)  │  │              │  │              │      │
│  └──────────────┘  └──────┬───────┘  └──────┬───────┘      │
│                           │                 │               │
│                    ┌──────┴─────────────────┴──────┐        │
│                    │     Session Manager (Map)     │        │
│                    │                                │        │
│                    │  ┌─────────┐  ┌─────────┐     │        │
│                    │  │ Client1 │  │ Client2 │ ... │        │
│                    │  │ (wwebjs)│  │ (wwebjs)│     │        │
│                    │  └────┬────┘  └────┬────┘     │        │
│                    │       │            │           │        │
│                    └───────┼────────────┼───────────┘        │
│                            │            │                   │
│                    ┌───────┴────────────┴──────┐            │
│                    │  Puppeteer (headless Chrome)│           │
│                    │  + proxy-chain (optional)   │           │
│                    └─────────────────────────────┘           │
│                                                             │
│  Файловая система:                                          │
│  ├── server/data/sessions.json    (персистентные сессии)    │
│  ├── server/data/numbers_*.txt    (загруженные номера)      │
│  ├── server/data/valid_*.txt      (результаты чекера)       │
│  ├── server/uploads/              (temp multer)             │
│  └── server/.wwebjs_auth/         (Chromium profiles)       │
└─────────────────────────────────────────────────────────────┘
```

### Ключевые принципы

- **Монолитный сервер** — весь backend в одном файле `server/index.js` (~1100 строк)
- **In-memory состояние** — сессии хранятся в `Map`, персистентность через JSON-файл
- **Realtime** — все обновления статусов и прогресса через Socket.IO
- **Stateless auth** — токены хранятся в `Set` на сервере, в `localStorage` на клиенте
- **Graceful fallbacks** — приложение работает без `proxy-chain`, без `AUTH_PASSWORD`

---

## 3. Структура файлов

```
whatsapp-sender/
├── Dockerfile                    # Multi-stage Docker build
├── package.json                  # Root: scripts start/build
├── readme.md                     # Краткая документация
├── DOCUMENTATION.md              # ← ВЫ ЗДЕСЬ
│
├── server/
│   ├── package.json              # Зависимости сервера
│   ├── package-lock.json
│   ├── nodemon.json              # Конфиг nodemon (watch *.js, ignore data/uploads)
│   ├── index.js                  # Весь backend: Express + Socket.IO + WhatsApp
│   ├── spintax.js                # Парсер спинтакса {вариант1|вариант2}
│   ├── randomMessages.js         # Генератор случайных сообщений для прогрева
│   ├── data/                     # Runtime данные
│   │   ├── sessions.json         # Сохранённые сессии (id, displayName, proxy)
│   │   ├── numbers_*.txt         # Загруженные файлы с номерами
│   │   └── valid_*.txt           # Результаты чекера
│   ├── uploads/                  # Временная директория multer
│   └── .wwebjs_auth/             # Chromium profiles (LocalAuth)
│       └── session-{id}/         # Профиль для каждой сессии
│
└── client/
    ├── package.json              # Зависимости клиента
    ├── package-lock.json
    ├── vite.config.js            # Vite: proxy /api и /socket.io → :3001
    ├── eslint.config.js          # ESLint конфиг
    ├── index.html                # HTML entry point
    ├── public/
    │   └── vite.svg
    ├── dist/                     # Собранный production-билд
    └── src/
        ├── main.jsx              # ReactDOM.createRoot + BrowserRouter
        ├── App.jsx               # Корневой компонент: auth, routing, sidebar
        ├── App.css               # Глобальные стили (~1600 строк)
        ├── index.css             # Базовый Vite reset
        ├── socket.js             # Socket.IO обёртка с Proxy-объектом
        ├── assets/
        │   └── react.svg
        └── pages/
            ├── Login.jsx         # Экран входа (пароль)
            ├── Accounts.jsx      # Управление WhatsApp-аккаунтами + QR
            ├── Sender.jsx        # Массовая рассылка
            ├── Checker.jsx       # Проверка номеров
            └── Warmer.jsx        # Прогрев аккаунтов
```

---

## 4. Backend (сервер)

### 4.1. Точка входа и инициализация

**Файл:** `server/index.js`

При запуске сервера выполняется следующая последовательность:

1. **Глобальная защита от падений** — обработчики `uncaughtException` и `unhandledRejection`
2. **Импорт зависимостей** — `whatsapp-web.js`, `spintax.js`, `randomMessages.js`, `proxy-chain` (опционально)
3. **Создание Express + HTTP + Socket.IO сервера**
4. **Настройка middleware** — CORS, JSON body parser (50MB limit), auth middleware
5. **Создание директорий** — `data/` и `uploads/`
6. **Регистрация API-эндпоинтов**
7. **Раздача статики** — `client/dist` (если существует)
8. **Запуск на PORT** (по умолчанию 3001)
9. **Очистка** — удаление stale lock-файлов Chromium
10. **Восстановление сессий** — через 3 секунды загрузка из `sessions.json`

```
Запуск сервера → Очистка locks/cache → Загрузка sessions.json
                                          │
                              ┌─────────────┤
                              │    5 сек    │    5 сек
                              ▼             ▼
                        createSession() createSession() ...
```

#### Хранилища состояния (in-memory)

```javascript
const sessions = new Map(); // id → { id, displayName, client, status, info, proxy, qr, anonymizedProxy }
let senderState = { running, controller }; // controller.aborted для остановки
let checkerState = { running, controller };
let warmerState = { running, controller };
const authTokens = new Set(); // валидные токены аутентификации
```

### 4.2. Аутентификация

**Механизм:** токен-based, опциональная.

#### Как работает

1. Если `AUTH_PASSWORD` не задан — middleware пропускает все запросы
2. Если задан — все `/api/*` (кроме `/auth/login` и `/auth/check`) требуют заголовок `x-auth-token`
3. Socket.IO подключения тоже проверяются через `socket.handshake.auth.token`

#### Генерация токена

```javascript
crypto.randomBytes(32).toString("hex"); // 64-символьная hex-строка
```

#### Middleware цепочка

```
Запрос → app.use('/api', authMiddleware) → Проверка x-auth-token
                                              │
                                    ┌─────────┴─────────┐
                                    │ Есть в authTokens? │
                                    ├──── Да ────────────┤
                                    │     next()         │
                                    ├──── Нет ───────────┤
                                    │     401            │
                                    └────────────────────┘
```

### 4.3. Управление сессиями WhatsApp

#### Жизненный цикл сессии

```
createSession()
    │
    ├── cleanupStaleLocks()    // Удаление SingletonLock и т.д.
    ├── cleanupCacheFiles()    // Очистка Cache, IndexedDB и т.д.
    │
    ├── [proxy-chain]          // Если прокси с @ — анонимизация
    │
    ├── new Client({           // whatsapp-web.js
    │     authStrategy: LocalAuth,
    │     puppeteer: { headless: true, args: [...] }
    │   })
    │
    ├── Подписка на события:
    │   ├── 'qr'            → status = 'qr', сохранить QR-строку
    │   ├── 'authenticated' → status = 'authenticated', таймер 30с на force-ready
    │   ├── 'ready'         → status = 'ready', сохранить info, saveSessions()
    │   ├── 'auth_failure'  → status = 'auth_failure'
    │   ├── 'disconnected'  → status = 'disconnected'
    │   ├── 'loading_screen'→ лог процента загрузки
    │   ├── 'change_state'  → если CONNECTED и не ready → force-ready через 3с
    │   └── 'message'       → если не ready → force-ready
    │
    └── client.initialize()    // Запуск Chromium
```

#### Статусы сессий

| Статус          | Описание             | Что происходит             |
| --------------- | -------------------- | -------------------------- |
| `initializing`  | Chromium запускается | Ожидание QR или ready      |
| `qr`            | QR-код сгенерирован  | Пользователь сканирует     |
| `authenticated` | QR отсканирован      | Загрузка данных WhatsApp   |
| `ready`         | Полностью готов      | Можно отправлять сообщения |
| `disconnected`  | Потеряно соединение  | Нужно переподключить       |
| `auth_failure`  | Ошибка авторизации   | Нужно переподключить       |

#### Персистентность

- Только сессии со статусом `ready` сохраняются в `server/data/sessions.json`
- При перезапуске восстанавливаются с задержкой 5 секунд между каждой
- Формат: `[{ id, displayName, proxy }]`

#### Очистка файлов Chromium

При каждом создании/переподключении:

- **Lock-файлы:** `SingletonLock`, `SingletonCookie`, `SingletonSocket` — предотвращает "browser already running"
- **Cache-директории:** `Cache`, `Code Cache`, `GPUCache`, `IndexedDB`, `Local Storage` и др. — снижает размер на диске

#### Puppeteer args

```javascript
[
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--disk-cache-size=0",
  "--media-cache-size=0",
  "--js-flags=--max-old-space-size=256",
];
```

### 4.4. Рассылка (Sender)

**Эндпоинт:** `POST /api/sender/start`

#### Алгоритм работы

```
1. Проверить: не запущена ли уже рассылка
2. Прочитать файл с номерами
3. Для каждого номера:
  a. Выбрать следующий ready-аккаунт (round-robin)
  b. Проверить лимит сообщений с аккаунта
  c. Имитировать набор текста (sendStateTyping)
  d. Подождать случайную задержку (typingDelayMin–typingDelayMax)
  e. Отправить сообщение (parseSpintax от шаблона)
  f. Обновить счётчики
  g. Если totalSent % pauseAfterMsgs === 0 → пауза
4. Отправить событие sender:complete
```

#### Round-robin выбор аккаунта

Функция `getNextReadyAccount()` перебирает аккаунты начиная с `startIdx`, проверяя:

- Статус `ready`
- Наличие `client`
- Не превышен лимит `msgsPerAccount`

#### Управление остановкой

Используется паттерн `controller.aborted`:

- Флаг проверяется в каждом цикле и во время ожиданий
- `POST /api/sender/stop` ставит `controller.aborted = true`
- Ожидания (задержки, паузы) реализованы через polling `sleep(200)`/`sleep(300)` с проверкой флага

### 4.5. Чекер (Checker)

**Эндпоинт:** `POST /api/checker/start`

#### Алгоритм

```
1. Для каждого номера из файла:
  a. client.getNumberId(num) → null если нет WhatsApp
  b. Если есть — добавить в массив valid
  c. Задержка 1.5с между проверками
2. Сохранить результат в server/data/valid_{timestamp}.txt
3. Отправить событие checker:complete с filename
```

#### Отличия от рассылки

- Работает с **одним** аккаунтом (не round-robin)
- Не отправляет сообщения — только проверяет `getNumberId`
- Результат сохраняется в файл для скачивания

### 4.6. Прогрев (Warmer)

**Эндпоинт:** `POST /api/warmer/start`

Практически идентичен рассылке, но:

- Вместо `messageTemplate` + `parseSpintax` использует `generateRandomMessage()` из `randomMessages.js`
- Генерирует естественно выглядящие сообщения из комбинаций приветствий, вопросов, тел и концовок
- Настройки задержек по умолчанию длиннее (паузы 60-120 сек)

### 4.7. Прокси

#### Простой прокси (без авторизации)

```
http://ip:port → передаётся как --proxy-server=http://ip:port в Puppeteer
```

#### Прокси с авторизацией

```
http://user:pass@ip:port
    │
    ▼ proxy-chain.anonymizeProxy()
http://127.0.0.1:{random_port}  (локальный прокси без auth)
    │
    ▼ передаётся в Puppeteer как --proxy-server
```

`proxy-chain` создаёт локальный прокси-сервер, который проксирует к удалённому с авторизацией.

#### Тестирование прокси

`POST /api/test-proxy` — выполняет HTTP CONNECT к `web.whatsapp.com:443` через прокси, замеряя время отклика.

#### Поиск бесплатных прокси

`POST /api/find-proxy` — скачивает списки бесплатных прокси из GitHub, тестирует до 500 штук батчами по 50, возвращает до 10 рабочих, отсортированных по скорости.

### 4.8. Вспомогательные модули

#### spintax.js

Парсер спинтакса — рандомизация текста в шаблоне сообщения.

```javascript
parseSpintax("{Привет|Здравствуйте}, {как дела|что нового}?");
// → "Здравствуйте, что нового?"
```

Поддерживает вложенные конструкции — обрабатывает изнутри наружу через `while (text.includes('{'))`.

#### randomMessages.js

Генератор случайных сообщений для прогрева. Комбинирует:

- **Приветствия** (10 вариантов): "Привет", "Здравствуй", "Добрый день" ...
- **Вопросы** (10 вариантов): "Как у тебя дела?", "Как поживаешь?" ...
- **Тела** (15 вариантов): "Давно не общались...", "Хотел узнать..." ...
- **Концовки** (13 вариантов): "Напиши когда будет время!", "Жду ответа!" ...

5 паттернов компоновки: полный (4 части), без вопроса, без концовки, с lowercase вопросом, короткий.

### 4.9. REST API — полный справочник

#### Аутентификация

| Метод  | Путь              | Body           | Ответ                                      | Описание             |
| ------ | ----------------- | -------------- | ------------------------------------------ | -------------------- |
| `GET`  | `/api/auth/check` | —              | `{ needsAuth: bool, authenticated: bool }` | Нужна ли авторизация |
| `POST` | `/api/auth/login` | `{ password }` | `{ token, needsAuth }`                     | Получить токен       |

#### Сессии

| Метод    | Путь                          | Body               | Ответ             | Описание           |
| -------- | ----------------------------- | ------------------ | ----------------- | ------------------ |
| `GET`    | `/api/sessions`               | —                  | `Session[]`       | Список всех сессий |
| `POST`   | `/api/sessions`               | `{ name, proxy? }` | `{ message, id }` | Создать аккаунт    |
| `POST`   | `/api/sessions/:id/reconnect` | —                  | `{ message }`     | Переподключить     |
| `DELETE` | `/api/sessions/:id`           | —                  | `{ message }`     | Удалить аккаунт    |

**Session object:**

```json
{
  "id": "sess_1772709600808_f2z3vs",
  "displayName": "Рабочий",
  "status": "ready",
  "info": { "phone": "79001234567", "name": "Иван" },
  "proxy": "http://1.2.3.4:8080",
  "qr": null
}
```

#### Файлы

| Метод  | Путь                      | Body             | Ответ             | Описание                  |
| ------ | ------------------------- | ---------------- | ----------------- | ------------------------- |
| `POST` | `/api/upload`             | `FormData: file` | `{ path, count }` | Загрузить .txt с номерами |
| `GET`  | `/api/download/:filename` | —                | файл              | Скачать результат чекера  |

#### Рассылка

| Метод  | Путь                | Body     | Ответ                     |
| ------ | ------------------- | -------- | ------------------------- |
| `POST` | `/api/sender/start` | см. ниже | `{ message: 'Запущено' }` |
| `POST` | `/api/sender/stop`  | —        | `{ message: 'Стоп' }`     |

**Body для `/api/sender/start`:**

```json
{
  "sessionIds": ["sess_1234", "sess_5678"],
  "numbersFilePath": "/app/server/data/numbers_1234.txt",
  "messageTemplate": "{Привет|Здравствуйте}! Как дела?",
  "msgsPerAccount": 50,
  "totalMessages": 0,
  "typingDelayMin": 5,
  "typingDelayMax": 10,
  "pauseAfterMsgs": 10,
  "pauseDurationMin": 30,
  "pauseDurationMax": 60
}
```

| Параметр           | Тип        | Описание                                                    |
| ------------------ | ---------- | ----------------------------------------------------------- |
| `sessionIds`       | `string[]` | ID аккаунтов-отправителей                                   |
| `numbersFilePath`  | `string`   | Абсолютный путь к файлу с номерами (получен от /api/upload) |
| `messageTemplate`  | `string`   | Шаблон сообщения со спинтаксом                              |
| `msgsPerAccount`   | `number`   | Макс. сообщений с одного аккаунта (0 = без лимита)          |
| `totalMessages`    | `number`   | Общий лимит сообщений (0 = все номера)                      |
| `typingDelayMin`   | `number`   | Мин. задержка печати, секунды                               |
| `typingDelayMax`   | `number`   | Макс. задержка печати, секунды                              |
| `pauseAfterMsgs`   | `number`   | Пауза каждые N сообщений (0 = без пауз)                     |
| `pauseDurationMin` | `number`   | Мин. длительность паузы, секунды                            |
| `pauseDurationMax` | `number`   | Макс. длительность паузы, секунды                           |

#### Чекер

| Метод  | Путь                 | Body                             | Ответ                     |
| ------ | -------------------- | -------------------------------- | ------------------------- |
| `POST` | `/api/checker/start` | `{ sessionId, numbersFilePath }` | `{ message: 'Запущено' }` |
| `POST` | `/api/checker/stop`  | —                                | `{ message: 'Стоп' }`     |

#### Прогрев

| Метод  | Путь                | Body                                 | Ответ                     |
| ------ | ------------------- | ------------------------------------ | ------------------------- |
| `POST` | `/api/warmer/start` | как sender, но без `messageTemplate` | `{ message: 'Запущено' }` |
| `POST` | `/api/warmer/stop`  | —                                    | `{ message: 'Стоп' }`     |

#### Прокси

| Метод  | Путь              | Body        | Ответ                                                 |
| ------ | ----------------- | ----------- | ----------------------------------------------------- |
| `POST` | `/api/test-proxy` | `{ proxy }` | `{ success, error?, timeMs?, status? }`               |
| `POST` | `/api/find-proxy` | —           | `{ tested, found, proxies: [{ proxy, responseMs }] }` |

#### Статус

| Метод | Путь          | Ответ                                           |
| ----- | ------------- | ----------------------------------------------- |
| `GET` | `/api/status` | `{ sender: bool, checker: bool, warmer: bool }` |

### 4.10. Socket.IO события

#### Подключение

```javascript
io(URL, {
  transports: ["polling", "websocket"],
  auth: { token },
});
```

Настройки сервера: `pingTimeout: 120000`, `pingInterval: 25000`.

При подключении клиент сразу получает `sessions:update`.

#### Сервер → Клиент

| Событие            | Данные                         | Когда                            |
| ------------------ | ------------------------------ | -------------------------------- |
| `sessions:update`  | `Session[]`                    | Любое изменение статуса аккаунта |
| `sender:log`       | `string`                       | Каждое действие рассылки         |
| `sender:progress`  | `{ sent, remaining, account }` | После каждого отправленного      |
| `sender:complete`  | `{ totalSent }`                | Рассылка завершена               |
| `sender:error`     | `string`                       | Критическая ошибка               |
| `checker:log`      | `string`                       | Каждая проверка номера           |
| `checker:progress` | `{ checked, total, valid }`    | После каждой проверки            |
| `checker:complete` | `{ total, valid, filename }`   | Чекер завершён                   |
| `checker:error`    | `string`                       | Ошибка чекера                    |
| `warmer:log`       | `string`                       | Каждое действие прогрева         |
| `warmer:progress`  | `{ sent, remaining }`          | После каждого отправленного      |
| `warmer:complete`  | `{ totalSent }`                | Прогрев завершён                 |

---

## 5. Frontend (клиент)

### 5.1. Точка входа и роутинг

**Файл:** `client/src/main.jsx`

```jsx
ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
```

**Файл:** `client/src/App.jsx`

Маршруты:

| Путь       | Компонент      | Описание              |
| ---------- | -------------- | --------------------- |
| `/`        | `<Accounts />` | Управление аккаунтами |
| `/sender`  | `<Sender />`   | Массовая рассылка     |
| `/checker` | `<Checker />`  | Проверка номеров      |
| `/warmer`  | `<Warmer />`   | Прогрев аккаунтов     |

Навигация — боковая панель (sidebar) с иконками SVG и тултипами.

### 5.2. Аутентификация на клиенте

**Поток инициализации:**

```
Загрузка модуля App.jsx
    │
    ├── Синхронно: из localStorage → axios.defaults.headers['x-auth-token']
    │
    └── useEffect (один раз):
        │
        ├── GET /api/auth/check
        │   │
        │   ├── needsAuth: false → initSocket('no-auth'), setReady(true)
        │   ├── needsAuth: true, authenticated: true → initSocket(token), setReady(true)
        │   └── needsAuth: true, authenticated: false → показать Login.jsx
        │
        └── Interceptor 401: если любой /api/* (кроме auth) вернул 401 → logout
```

**AuthContext** предоставляет `{ token, handleLogout }` всем вложенным компонентам.

**Важный fix:** заголовок `x-auth-token` устанавливается **синхронно** при загрузке модуля (вне компонента), чтобы первые запросы к API уже содержали токен.

### 5.3. Socket.IO обёртка

**Файл:** `client/src/socket.js`

Реализован через **Proxy-объект** для обратной совместимости:

```javascript
export const socket = new Proxy(
  {},
  {
    get(_, prop) {
      if (!socketInstance) return () => {};
      return typeof socketInstance[prop] === "function"
        ? socketInstance[prop].bind(socketInstance)
        : socketInstance[prop];
    },
  },
);
```

Это позволяет импортировать `socket` до инициализации — все вызовы `socket.on()` / `socket.off()` безопасно проксируются или возвращают no-op.

Функции:

- `initSocket(token)` — создаёт/переcоздаёт подключение
- `getSocket()` — получить текущий instance
- `disconnectSocket()` — отключиться

### 5.4. Страница: Аккаунты (Accounts)

**Файл:** `client/src/pages/Accounts.jsx` (~340 строк)

#### Функциональность

- **Список аккаунтов** — grid карточек с аватарами, статусами, телефонами
- **Добавление** — модальное окно (название + прокси)
- **QR-сканирование** — модальное окно с пошаговой инструкцией и таймером 90 секунд
- **Переподключение** — для аккаунтов со статусом `disconnected`/`auth_failure`
- **Удаление** — с подтверждением через `confirm()`

#### Обновление данных

Двойной механизм:

1. **Polling** — `setInterval(load, 5000)` для GET /api/sessions
2. **Socket.IO** — событие `sessions:update` для мгновенных обновлений

Polling останавливается при получении 401.

#### Компонент QrTimer

Отдельный компонент с обратным отсчётом 90 секунд и прогресс-баром. Сбрасывается при изменении prop `qr`.

#### Визуальные элементы

- Аватар с инициалами и цветом по хэшу имени (8 цветов)
- Точка статуса на аватаре (зелёная/серая/мигающая)
- Badge статуса с текстом
- Тег прокси (если задан)

### 5.5. Страница: Рассылка (Sender)

**Файл:** `client/src/pages/Sender.jsx` (~203 строки)

#### UI-секции

| Секция          | Описание                                    |
| --------------- | ------------------------------------------- |
| **Отправители** | Чекбокс-список ready-аккаунтов              |
| **Номера**      | Загрузка .txt файла, отображение количества |
| **Шаблон**      | Textarea со спинтакс-подсказкой             |
| **Настройки**   | 7 числовых полей (лимиты, задержки, паузы)  |
| **Прогресс**    | Счётчики отправлено/осталось + прогресс-бар |
| **Журнал**      | Лог-область с автоскроллом                  |

#### Обработка ошибок файлов

Если сервер вернул 400 с ошибкой файла — сбрасывает `filePath`/`fileName`/`numCount` и предлагает загрузить заново.

### 5.6. Страница: Чекер (Checker)

**Файл:** `client/src/pages/Checker.jsx` (~153 строки)

#### Отличия от Sender

- Выбор **одного** аккаунта (select вместо checkbox-list)
- Нет шаблона сообщения
- Статистика: проверено / есть WA / всего
- Кнопка **скачивания результата** — загружает `valid_*.txt` через fetch с токеном

#### Механизм скачивания

```javascript
fetch(`/api/download/${resultFile}`, { headers: { "x-auth-token": token } })
  .then((res) => res.blob())
  .then((blob) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resultFile;
    a.click();
  });
```

### 5.7. Страница: Прогрев (Warmer)

**Файл:** `client/src/pages/Warmer.jsx` (~136 строк)

Аналогичен Sender, но:

- Нет textarea для шаблона (сообщения генерируются автоматически)
- Подсказка "Сообщения генерируются автоматически"
- Другие значения по умолчанию: `msgsPerAcc=20`, `pauseMin=60`, `pauseMax=120`

### 5.8. Страница: Логин (Login)

**Файл:** `client/src/pages/Login.jsx` (~52 строки)

Минимальная форма:

- Иконка замка (SVG)
- Заголовок "WhatsApp Sender"
- Поле пароля
- Кнопка "Войти"
- Блок ошибки (анимированный)

При успехе вызывает `onLogin(token)` из `App.jsx`.

### 5.9. Стили и дизайн-система

**Файл:** `client/src/App.css` (~1618 строк)

#### Дизайн-токены (CSS-переменные)

```css
--bg-main: #eae6df /* Фон приложения (WhatsApp wallpaper color) */
  --bg-white: #ffffff /* Фон карточек */ --bg-panel: #f0f2f5 /* Фон панелей */
  --green: #00a884 /* Основной акцент (WhatsApp green) */ --green-dark: #008069
  /* Тёмный зелёный */ --red: #ea0038 /* Ошибки, удаление */
  --text-primary: #111b21 /* Основной текст */ --text-secondary: #667781
  /* Вторичный текст */ --text-muted: #a0aeb4 /* Подсказки */ --border: #e9edef
  /* Границы */ --radius-sm: 8px --radius-md: 12px --radius-lg: 20px
  --radius-pill: 100px;
```

#### Шрифт

Google Fonts: **Plus Jakarta Sans** (300–800)

#### Анимации

| Анимация        | Использование                         |
| --------------- | ------------------------------------- |
| `appEnter`      | Появление приложения (scale 0.98→1)   |
| `cardIn`        | Появление карточки (translateY 6px→0) |
| `pageIn`        | Появление страницы (translateY 8px→0) |
| `modalPop`      | Появление модалки (scale 0.92→1)      |
| `qrPop`         | Появление QR-кода (scale 0.85→1)      |
| `spin`          | Вращение спиннера                     |
| `ringPulse`     | Пульсация кольца статуса              |
| `progressShine` | Блеск прогресс-бара                   |
| `logLine`       | Появление строки лога                 |
| `dotFade`       | Мигание точек загрузки                |
| `titlePulse`    | Пульсация зелёной точки заголовка     |
| `countUp`       | Появление числа статистики            |

#### Ключевые CSS-компоненты

- `.app` — flex layout (sidebar + content), height: 100vh
- `.sidebar` — 72px, иконки с тултипами, активное состояние
- `.content` — flex: 1, overflow-y: auto
- `.card` — карточка с hover-эффектом (зелёная полоска слева)
- `.btn` / `.btn-primary` / `.btn-danger` — кнопки с gradient и shadow
- `.modal-overlay` / `.modal` — модальные окна с backdrop-filter
- `.log-area` — моноширинный лог (JetBrains Mono / Fira Code)
- `.acc-grid` — grid аккаунтов (auto-fill, minmax 210px)
- `.acc-avatar` — круглый аватар с инициалами
- `.progress-bar-*` — прогресс-бар с анимированным градиентом
- `.file-upload` — drag-area с hover-эффектом

#### Responsive

- `@media (max-width: 1024px)` — `.grid-2` переключается в одну колонку
- `@media (max-width: 768px)` — `.acc-grid` уменьшает минимум колонки до 170px

---

## 6. Переменные окружения

| Переменная                         | По умолчанию | Обязательная | Описание                                                     |
| ---------------------------------- | ------------ | ------------ | ------------------------------------------------------------ |
| `AUTH_PASSWORD`                    | _(пусто)_    | Нет          | Пароль для веб-интерфейса. Если не задан — доступ без пароля |
| `PORT`                             | `3001`       | Нет          | Порт HTTP-сервера                                            |
| `PUPPETEER_EXECUTABLE_PATH`        | _(авто)_     | В Docker     | Путь к Chromium (в Docker: `/usr/bin/chromium`)              |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | —            | В Docker     | `true` — не скачивать Chromium при npm install               |
| `NODE_ENV`                         | —            | Нет          | `production` в Docker                                        |

---

## 7. Запуск и разработка

### Локальная разработка

```bash
# 1. Установить зависимости
cd server && npm install
cd ../client && npm install

# 2. Запустить сервер (с авто-перезагрузкой)
cd ../server && npm run dev    # nodemon index.js

# 3. В отдельном терминале — запустить клиент
cd ../client && npm run dev    # vite :5173

# Открыть http://localhost:5173
```

Vite проксирует `/api` и `/socket.io` на `http://localhost:3001`.

### Production-сборка

```bash
# Из корня проекта:
cd client && npm install && npm run build
cd ../server && node index.js

# Открыть http://localhost:3001
```

Сервер раздаёт `client/dist` как статику и обрабатывает SPA fallback.

### Nodemon конфигурация

```json
{
  "watch": ["*.js"],
  "ignore": ["data/*", "uploads/*", ".wwebjs_auth/*", "node_modules/*"],
  "ext": "js"
}
```

---

## 8. Docker и деплой

### Dockerfile (multi-stage)

```
Stage 1: client-builder (node:18-slim)
├── npm install (клиент)
└── npm run build → /app/client/dist

Stage 2: production (node:18-slim)
├── apt-get install chromium + зависимости
├── npm install --production (сервер)
├── COPY dist из Stage 1
├── COPY server source
├── mkdir data, uploads, .wwebjs_auth
└── CMD node server/index.js
```

### Railway деплой

1. Подключить Git-репозиторий
2. Задать переменные: `AUTH_PASSWORD`
3. Railway автоматически берёт `Dockerfile`
4. Exposed port: 3001

### Системные зависимости (Linux/Docker)

Для Puppeteer/Chromium:

- `chromium`, `fonts-liberation`, `libasound2`, `libatk*`, `libcups2`, `libdbus-1-3`, `libdrm2`, `libgbm1`, `libgtk-3-0`, `libnspr4`, `libnss3`, `libx11-xcb1`, `libxcomposite1`, `libxdamage1`, `libxrandr2`, `xdg-utils`

---

## 9. Потоки данных

### Создание аккаунта

```
Клиент                          Сервер
  │                               │
  ├── POST /api/sessions ────────►│ createSession()
  │◄── { id } ───────────────────│
  │                               │ Puppeteer запускается
  │                               │
  │◄── WS: sessions:update ──────│ status: initializing
  │                               │
  │◄── WS: sessions:update ──────│ status: qr, qr: "..."
  │  Показать QR в модалке        │
  │                               │ Пользователь сканирует
  │◄── WS: sessions:update ──────│ status: authenticated
  │                               │
  │◄── WS: sessions:update ──────│ status: ready, info: {...}
  │  Закрыть модалку (2с)         │ saveSessions()
```

### Рассылка

```
Клиент                          Сервер
  │                               │
  ├── POST /api/upload ──────────►│ Сохранить номера в data/
  │◄── { path, count } ─────────│
  │                               │
  ├── POST /api/sender/start ───►│ Начать цикл отправки
  │◄── { message: 'Запущено' } ─│
  │                               │
  │◄── WS: sender:log ──────────│ [OK] Аккаунт -> +7900...
  │◄── WS: sender:progress ─────│ { sent: 1, remaining: 99 }
  │  ... (повтор для каждого)     │
  │                               │
  │◄── WS: sender:complete ─────│ { totalSent: 100 }
  │  или                          │
  ├── POST /api/sender/stop ────►│ controller.aborted = true
  │◄── WS: sender:log ──────────│ -- Стоп
```

---

## 10. Известные особенности и ограничения

### Ограничения архитектуры

- **Single-process** — все аккаунты в одном процессе Node.js. Каждый Chromium instance потребляет ~200-300MB RAM
- **In-memory Map** — при аварийном завершении теряются все активные сессии (сохраняются только `ready`)
- **Один sender/checker/warmer** — нельзя запустить несколько параллельных рассылок

### 401 Unauthorized в консоли

Возникает когда `AUTH_PASSWORD` задан, но:

- Токен ещё не получен (первые запросы до `initSocket`)
- Токен протух (сервер перезапустился — `authTokens` Set очистился)

**Fix в коде:** заголовок ставится синхронно при загрузке модуля, interceptor автоматически вызывает logout при 401.

### Прокси

- Без `proxy-chain` не работают прокси с авторизацией (user:pass@host:port)
- Бесплатные прокси (find-proxy) нестабильны и медленны

### Хранение данных

- Файлы с номерами (`numbers_*.txt`) не удаляются автоматически
- Результаты чекера (`valid_*.txt`) не удаляются автоматически
- `.wwebjs_auth/` может занимать значительное место на диске

### WhatsApp ограничения

- QR-код действует ~90 секунд, затем генерируется новый (до 5 попыток)
- Слишком частая рассылка может привести к бану аккаунта
- `whatsapp-web.js` зависит от веб-версии WhatsApp — обновления могут сломать совместимость

### Безопасность

- Токены хранятся в `Set` в памяти — не ротируются, не имеют TTL
- Пароль сравнивается без rate-limiting
- `numbersFilePath` передаётся абсолютным путём от клиента (protected path traversal для download)
- CORS разрешён для всех origins (`origin: '*'`)

---

## Зависимости

### Server (`server/package.json`)

| Пакет             | Версия  | Назначение                            |
| ----------------- | ------- | ------------------------------------- |
| `express`         | ^4.18.2 | HTTP-сервер, REST API                 |
| `socket.io`       | ^4.7.4  | WebSocket сервер                      |
| `whatsapp-web.js` | ^1.23.0 | WhatsApp Web клиент (Puppeteer-based) |
| `cors`            | ^2.8.5  | CORS middleware                       |
| `multer`          | ^1.4.5  | Загрузка файлов (multipart/form-data) |
| `proxy-chain`     | ^2.7.1  | Анонимизация прокси с авторизацией    |
| `nodemon`         | ^3.0.2  | (dev) Авто-перезагрузка сервера       |

### Client (`client/package.json`)

| Пакет                  | Версия  | Назначение                 |
| ---------------------- | ------- | -------------------------- |
| `react`                | ^19.2.0 | UI-фреймворк               |
| `react-dom`            | ^19.2.0 | DOM рендеринг              |
| `react-router-dom`     | ^7.13.1 | SPA маршрутизация          |
| `axios`                | ^1.13.6 | HTTP-клиент                |
| `socket.io-client`     | ^4.8.3  | WebSocket клиент           |
| `qrcode.react`         | ^4.2.0  | Генерация QR-кода в SVG    |
| `vite`                 | ^7.3.1  | (dev) Сборщик и dev-сервер |
| `@vitejs/plugin-react` | ^5.1.1  | (dev) React HMR            |
