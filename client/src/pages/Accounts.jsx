import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { QRCodeSVG } from 'qrcode.react';
import { socket } from '../socket';

const STATUS_LABELS = {
  initializing:  'Запуск...',
  qr:            'Ожидание сканирования',
  authenticated: 'Авторизация...',
  ready:         'Онлайн',
  disconnected:  'Не в сети',
  auth_failure:  'Ошибка подключения'
};

function getInitials(name) {
  return name.split(/[\s_-]+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function getAvatarColor(name) {
  const colors = ['#00a884','#0ea5e9','#7c5ce0','#06b6d4','#10b981','#667781','#8b5cf6','#0891b2'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function Accounts() {
  const [sessions, setSessions]     = useState([]);
  const [showModal, setShowModal]   = useState(false);
  const [showQrFor, setShowQrFor]   = useState(null);
  const [newName, setNewName]       = useState('');
  const [proxy, setProxy]           = useState('');
  const [creating, setCreating]     = useState(false);

  const load = async () => {
    const { data } = await axios.get('/api/sessions');
    setSessions(data);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    socket.on('sessions:update', (data) => {
      setSessions(data);
      if (showQrFor) {
        const s = data.find(x => x.id === showQrFor);
        if (s && s.status === 'ready') setShowQrFor(null);
      }
    });
    return () => socket.off('sessions:update');
  }, [showQrFor]);

  const create = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const { data } = await axios.post('/api/sessions', { name: trimmed, proxy: proxy.trim() || null });
      setShowModal(false);
      setNewName('');
      setProxy('');
      setShowQrFor(data.id);
    } catch (e) {
      alert(e.response?.data?.error || 'Ошибка');
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id) => {
    if (!confirm('Удалить этот аккаунт?')) return;
    await axios.delete(`/api/sessions/${id}`);
    if (showQrFor === id) setShowQrFor(null);
  };

  const qrSession = sessions.find(s => s.id === showQrFor);
  const onlineCount = sessions.filter(s => s.status === 'ready').length;
  const pendingCount = sessions.filter(s => ['initializing','qr','authenticated'].includes(s.status)).length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">
          <span className="title-dot" />
          Аккаунты
          {sessions.length > 0 && (
            <span className="title-counter">{onlineCount} из {sessions.length} активны</span>
          )}
        </h1>
      </div>

      <div className="page-body">
        {/* Мини-статистика — только если есть аккаунты */}
        {sessions.length > 0 && (
          <div className="acc-stats-bar">
            <div className="acc-stat-chip">
              <span className="acc-stat-dot" />
              {onlineCount} онлайн
            </div>
            {pendingCount > 0 && (
              <div className="acc-stat-chip pending">
                <span className="acc-stat-dot pending" />
                {pendingCount} подключается
              </div>
            )}
          </div>
        )}

        <div className="acc-grid">
          {/* Карточка добавления — всегда первая */}
          <div className="acc-card acc-card-add" onClick={() => setShowModal(true)}>
            <div className="acc-add-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <div className="acc-add-text">Добавить аккаунт</div>
            {sessions.length === 0 && (
              <div className="acc-add-hint">Привяжите WhatsApp для начала работы</div>
            )}
          </div>

          {/* Карточки аккаунтов */}
          {sessions.map((s, i) => (
            <div key={s.id} className="acc-card acc-card-account" style={{ animationDelay: `${i * 0.05}s` }}>
              <div className="acc-card-body">
                <div className="acc-avatar" style={{ background: getAvatarColor(s.displayName) }}>
                  {getInitials(s.displayName)}
                  <span className={`acc-avatar-dot ${s.status}`} />
                </div>

                <div className="acc-card-name">{s.displayName}</div>
                <div className="acc-card-phone">
                  {s.info?.phone ? `+${s.info.phone}` : STATUS_LABELS[s.status]}
                </div>

                <div className={`acc-badge ${s.status}`}>
                  {s.status === 'initializing' && <span className="acc-badge-spinner" />}
                  {STATUS_LABELS[s.status]}
                </div>

                {s.proxy && <div className="acc-proxy-tag">proxy: {s.proxy}</div>}
              </div>

              <div className="acc-card-actions">
                {['qr','initializing','disconnected','auth_failure'].includes(s.status) && (
                  <button className="acc-action-btn acc-action-connect" onClick={() => setShowQrFor(s.id)}>
                    {s.status === 'qr' ? 'Показать QR' : s.status === 'initializing' ? 'Статус' : 'Переподключить'}
                  </button>
                )}
                <button className="acc-action-btn acc-action-delete" onClick={() => remove(s.id)}>
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* ─── Модалка создания ─── */}
        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Новый аккаунт</h3>
                <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
              </div>
              <div className="form-group">
                <label>Название аккаунта</label>
                <input value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && create()} placeholder="Рабочий, Основной..." autoFocus />
              </div>
              <div className="form-group">
                <label>Прокси-сервер</label>
                <input value={proxy} onChange={e => setProxy(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && create()} placeholder="http://ip:port (необязательно)" />
                <div className="hint" style={{ marginTop: 6 }}>Рекомендуется для массовой рассылки</div>
              </div>
              <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Отмена</button>
                <button className="btn btn-primary" onClick={create} disabled={creating || !newName.trim()}>
                  {creating ? 'Создание...' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Модалка QR ─── */}
        {showQrFor && qrSession && (
          <div className="modal-overlay" onClick={() => setShowQrFor(null)}>
            <div className="modal qr-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{qrSession.displayName}</h3>
                <button className="modal-close" onClick={() => setShowQrFor(null)}>&times;</button>
              </div>

              <div className="qr-modal-body">
                {qrSession.status === 'initializing' && (
                  <div className="qr-state-center">
                    <div className="qr-spinner" />
                    <div className="qr-state-title">Подготовка</div>
                    <div className="qr-state-sub">Запускаем браузер и генерируем QR-код</div>
                    <div className="qr-dots"><span /><span /><span /></div>
                  </div>
                )}

                {qrSession.status === 'qr' && qrSession.qr && (
                  <div className="qr-scan-layout">
                    <div className="qr-steps">
                      <div className="qr-step"><span className="qr-step-num">1</span>Откройте WhatsApp на телефоне</div>
                      <div className="qr-step"><span className="qr-step-num">2</span>Связанные устройства</div>
                      <div className="qr-step"><span className="qr-step-num">3</span>Привязка устройства</div>
                    </div>
                    <div className="qr-code-box">
                      <QRCodeSVG value={qrSession.qr} size={200} />
                    </div>
                    <QrTimer />
                  </div>
                )}

                {qrSession.status === 'authenticated' && (
                  <div className="qr-state-center">
                    <div className="qr-spinner" />
                    <div className="qr-state-title">Авторизация</div>
                    <div className="qr-state-sub">QR отсканирован, загружаем данные</div>
                  </div>
                )}

                {qrSession.status === 'ready' && (
                  <div className="qr-state-center">
                    <div className="qr-check-circle">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </div>
                    <div className="qr-state-title">Подключено</div>
                    <div className="qr-state-sub">{qrSession.info?.phone ? `+${qrSession.info.phone}` : qrSession.displayName}</div>
                  </div>
                )}

                {(qrSession.status === 'disconnected' || qrSession.status === 'auth_failure') && (
                  <div className="qr-state-center">
                    <div className="qr-error-circle">!</div>
                    <div className="qr-state-title">Ошибка подключения</div>
                    <div className="qr-state-sub">Попробуйте удалить аккаунт и создать заново</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function QrTimer() {
  const [seconds, setSeconds] = useState(60);
  const ref = useRef();
  useEffect(() => {
    setSeconds(60);
    ref.current = setInterval(() => {
      setSeconds(p => { if (p <= 1) { clearInterval(ref.current); return 0; } return p - 1; });
    }, 1000);
    return () => clearInterval(ref.current);
  }, []);

  return (
    <div className="qr-timer">
      <div className="qr-timer-track"><div className="qr-timer-fill" style={{ width: `${(seconds / 60) * 100}%` }} /></div>
      <div className="qr-timer-label">{seconds > 0 ? `QR обновится через ${seconds} сек` : 'Обновление...'}</div>
    </div>
  );
}