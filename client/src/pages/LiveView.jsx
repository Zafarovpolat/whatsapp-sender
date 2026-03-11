import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { socket } from '../socket';

const QUALITY_PRESETS = {
  low:    { quality: 25, maxWidth: 960,  maxHeight: 600,  label: 'Низкое' },
  medium: { quality: 45, maxWidth: 1280, maxHeight: 800,  label: 'Среднее' },
  high:   { quality: 70, maxWidth: 1920, maxHeight: 1080, label: 'Высокое' }
};

export default function LiveView() {
  const [sessions, setSessions]     = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [viewing, setViewing]       = useState(false);
  const [qualityKey, setQualityKey] = useState('medium');
  const [fps, setFps]               = useState(0);
  const [resolution, setResolution] = useState('');
  const [typeText, setTypeText]     = useState('');

  const canvasRef       = useRef(null);
  const imgRef          = useRef(new Image());
  const frameCountRef   = useRef(0);
  const fpsIntervalRef  = useRef(null);
  const activeSessionRef = useRef(null);

  // ─── Загрузка сессий ───
  useEffect(() => {
    axios.get('/api/sessions').then(r => setSessions(r.data)).catch(() => {});
    const onUpdate = (data) => { if (Array.isArray(data)) setSessions(data); };
    socket.on('sessions:update', onUpdate);
    return () => socket.off('sessions:update', onUpdate);
  }, []);

  // ─── Обработка кадров ───
  useEffect(() => {
    const onFrame = ({ sessionId, data, metadata }) => {
      if (sessionId !== activeSessionRef.current) return;
      frameCountRef.current++;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const img = imgRef.current;
      img.onload = () => {
        if (canvas.width !== img.width)  canvas.width  = img.width;
        if (canvas.height !== img.height) canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);

        if (metadata?.deviceWidth) {
          setResolution(`${metadata.deviceWidth}×${metadata.deviceHeight}`);
        }
      };
      img.src = `data:image/jpeg;base64,${data}`;
    };

    const onStarted = ({ sessionId }) => {
      if (sessionId === activeSessionRef.current) {
        setViewing(true);
        frameCountRef.current = 0;
        fpsIntervalRef.current = setInterval(() => {
          setFps(frameCountRef.current);
          frameCountRef.current = 0;
        }, 1000);
      }
    };

    const onError = ({ error }) => {
      alert('Ошибка трансляции: ' + error);
      cleanupViewing();
    };

    socket.on('screencast:frame',   onFrame);
    socket.on('screencast:started', onStarted);
    socket.on('screencast:error',   onError);

    return () => {
      socket.off('screencast:frame',   onFrame);
      socket.off('screencast:started', onStarted);
      socket.off('screencast:error',   onError);
    };
  }, []);

  // ─── Очистка при размонтировании ───
  useEffect(() => {
    return () => {
      if (activeSessionRef.current) {
        socket.emit('screencast:stop', { sessionId: activeSessionRef.current });
      }
      if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
    };
  }, []);

  // ─── Утилиты ───
  const cleanupViewing = () => {
    setViewing(false);
    setFps(0);
    setResolution('');
    if (fpsIntervalRef.current) {
      clearInterval(fpsIntervalRef.current);
      fpsIntervalRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const startViewing = () => {
    if (!selectedId) return alert('Выберите аккаунт');
    activeSessionRef.current = selectedId;
    const preset = QUALITY_PRESETS[qualityKey];
    socket.emit('screencast:start', {
      sessionId: selectedId,
      quality:   preset.quality,
      maxWidth:  preset.maxWidth,
      maxHeight: preset.maxHeight
    });
  };

  const stopViewing = () => {
    if (activeSessionRef.current) {
      socket.emit('screencast:stop', { sessionId: activeSessionRef.current });
    }
    activeSessionRef.current = null;
    cleanupViewing();
  };

  // ─── Пересчёт координат canvas → viewport ───
  const canvasCoords = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY
    };
  }, []);

  // ─── Клик по canvas ───
  const handleClick = useCallback((e) => {
    if (!viewing || !activeSessionRef.current) return;
    const coords = canvasCoords(e);
    if (coords) {
      socket.emit('screencast:click', {
        sessionId: activeSessionRef.current,
        x: coords.x,
        y: coords.y
      });
    }
  }, [viewing, canvasCoords]);

  // ─── Скролл ───
  const handleWheel = useCallback((e) => {
    if (!viewing || !activeSessionRef.current) return;
    e.preventDefault();
    const coords = canvasCoords(e);
    if (coords) {
      socket.emit('screencast:scroll', {
        sessionId: activeSessionRef.current,
        x: coords.x,
        y: coords.y,
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    }
  }, [viewing, canvasCoords]);

  // ─── Клавиши на canvas (когда в фокусе) ───
  const handleKeyDown = useCallback((e) => {
    if (!viewing || !activeSessionRef.current) return;

    const specialKeys = [
      'Enter','Backspace','Delete','Tab','Escape',
      'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
      'Home','End','PageUp','PageDown'
    ];

    if (specialKeys.includes(e.key)) {
      e.preventDefault();
      socket.emit('screencast:keypress', {
        sessionId: activeSessionRef.current,
        key: e.key
      });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Обычный символ
      e.preventDefault();
      socket.emit('screencast:type', {
        sessionId: activeSessionRef.current,
        text: e.key
      });
    }
  }, [viewing]);

  // ─── Отправка текста из поля ввода ───
  const sendText = () => {
    if (!typeText.trim() || !activeSessionRef.current) return;
    socket.emit('screencast:type', {
      sessionId: activeSessionRef.current,
      text: typeText
    });
    setTypeText('');
  };

  const ready = sessions.filter(s => s.status === 'ready');

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">
          <span className="title-dot" />
          Live View
          {viewing && (
            <span className="title-counter">
              {fps} FPS{resolution ? ` • ${resolution}` : ''}
            </span>
          )}
        </h1>
      </div>

      <div className="page-body">
        {/* ─── Панель управления ─── */}
        <div className="card">
          <h3>Трансляция экрана WhatsApp</h3>
          <div className="liveview-controls">
            <div className="form-group" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
              <label>Аккаунт</label>
              <select
                value={selectedId}
                onChange={e => {
                  if (viewing) stopViewing();
                  setSelectedId(e.target.value);
                }}
                disabled={viewing}
              >
                <option value="">Выберите аккаунт</option>
                {ready.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.displayName} {s.info?.phone ? `(+${s.info.phone})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ minWidth: 140, marginBottom: 0 }}>
              <label>Качество</label>
              <select
                value={qualityKey}
                onChange={e => setQualityKey(e.target.value)}
                disabled={viewing}
              >
                {Object.entries(QUALITY_PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              {!viewing ? (
                <button className="btn btn-primary" onClick={startViewing} disabled={!selectedId}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  Смотреть
                </button>
              ) : (
                <button className="btn btn-danger" onClick={stopViewing}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                    <rect x="6" y="6" width="12" height="12" rx="1"/>
                  </svg>
                  Стоп
                </button>
              )}
            </div>
          </div>

          {!ready.length && (
            <div className="hint" style={{ marginTop: 12 }}>
              Нет подключённых аккаунтов. Добавьте аккаунт на странице «Аккаунты».
            </div>
          )}
        </div>

        {/* ─── Экран трансляции ─── */}
        <div className={`card section-gap liveview-screen ${viewing ? 'active' : ''}`}>
          {viewing ? (
            <canvas
              ref={canvasRef}
              tabIndex={0}
              onClick={handleClick}
              onWheel={handleWheel}
              onKeyDown={handleKeyDown}
              className="liveview-canvas"
              title="Кликните для взаимодействия. Используйте клавиатуру когда canvas в фокусе."
            />
          ) : (
            <div className="liveview-placeholder">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <p className="liveview-placeholder-title">Просмотр WhatsApp Web</p>
              <p className="liveview-placeholder-sub">
                Выберите аккаунт и нажмите «Смотреть» чтобы увидеть<br/>
                экран WhatsApp в реальном времени
              </p>
            </div>
          )}
        </div>

        {/* ─── Панель ввода (только при трансляции) ─── */}
        {viewing && (
          <div className="card section-gap">
            <h3>Ввод текста</h3>
            <div className="liveview-input-row">
              <input
                type="text"
                value={typeText}
                onChange={e => setTypeText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
                }}
                placeholder="Введите текст и нажмите Отправить..."
                className="liveview-text-input"
              />
              <button className="btn btn-primary" onClick={sendText} disabled={!typeText.trim()}>
                Ввести
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => socket.emit('screencast:keypress', {
                  sessionId: activeSessionRef.current, key: 'Enter'
                })}
                title="Нажать Enter в WhatsApp"
              >
                Enter ↵
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => socket.emit('screencast:keypress', {
                  sessionId: activeSessionRef.current, key: 'Backspace'
                })}
                title="Удалить символ"
              >
                ← Удалить
              </button>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              <strong>Клик</strong> по экрану = клик в WhatsApp &nbsp;•&nbsp;
              <strong>Скролл</strong> = прокрутка чатов &nbsp;•&nbsp;
              <strong>Клавиатура</strong> работает когда экран в фокусе (кликните на него)
            </div>
          </div>
        )}
      </div>
    </>
  );
}