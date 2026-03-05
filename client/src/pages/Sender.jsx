import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { socket } from '../socket';

export default function Sender() {
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState([]);
  const [fileName, setFileName] = useState('');
  const [filePath, setFilePath] = useState('');
  const [numCount, setNumCount] = useState(0);
  const [message, setMessage] = useState('');
  const [msgsPerAcc, setMsgsPerAcc] = useState(50);
  const [totalMsgs, setTotalMsgs] = useState(0);
  const [tDelayMin, setTDelayMin] = useState(5);
  const [tDelayMax, setTDelayMax] = useState(10);
  const [pauseAfter, setPauseAfter] = useState(10);
  const [pauseMin, setPauseMin] = useState(30);
  const [pauseMax, setPauseMax] = useState(60);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState({ sent: 0, remaining: 0 });
  const logRef = useRef();

  useEffect(() => {
    axios.get('/api/sessions').then(r => setSessions(r.data));
    socket.on('sessions:update', setSessions);
    socket.on('sender:log', m => setLogs(p => [...p, m]));
    socket.on('sender:progress', setProgress);
    socket.on('sender:complete', () => setRunning(false));
    socket.on('sender:error', m => { setLogs(p => [...p, `[ERR] ${m}`]); setRunning(false); });
    return () => { ['sessions:update','sender:log','sender:progress','sender:complete','sender:error'].forEach(e => socket.off(e)); };
  }, []);

  useEffect(() => { logRef.current && (logRef.current.scrollTop = logRef.current.scrollHeight); }, [logs]);

  const upload = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    const { data } = await axios.post('/api/upload', fd);
    setFilePath(data.path); setNumCount(data.count); setFileName(f.name);
  };

  const toggle = id => setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const start = async () => {
    if (!selected.length) return alert('Выберите аккаунты');
    if (!filePath) return alert('Загрузите номера');
    if (!message.trim()) return alert('Введите сообщение');
    setLogs([]); setProgress({ sent: 0, remaining: numCount }); setRunning(true);
    await axios.post('/api/sender/start', {
      sessionIds: selected, numbersFilePath: filePath, messageTemplate: message,
      msgsPerAccount: +msgsPerAcc, totalMessages: +totalMsgs,
      typingDelayMin: +tDelayMin, typingDelayMax: +tDelayMax,
      pauseAfterMsgs: +pauseAfter, pauseDurationMin: +pauseMin, pauseDurationMax: +pauseMax
    });
  };

  const stop = async () => { await axios.post('/api/sender/stop'); setRunning(false); };
  const ready = sessions.filter(s => s.status === 'ready');

  return (
    <>
      <div className="page-header">
        <h1 className="page-title"><span className="title-dot" />Рассылка</h1>
      </div>
      <div className="page-body">
        <div className="grid-2">
          <div>
            <div className="card">
              <h3>Отправители</h3>
              <div className="checkbox-list">
                {ready.map(s => (
                  <label key={s.id} className="checkbox-item">
                    <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} disabled={running} />
                    <span>{s.displayName} {s.info?.phone ? `(+${s.info.phone})` : ''}</span>
                  </label>
                ))}
                {!ready.length && <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>Нет готовых аккаунтов</div>}
              </div>
            </div>
            <div className="card">
              <h3>Номера</h3>
              <label className={`file-upload${fileName ? ' has-file' : ''}`}>
                <input type="file" accept=".txt" onChange={upload} disabled={running} />
                <div className="upload-label">{fileName ? `${fileName} — ${numCount} шт.` : 'Выбрать .txt файл'}</div>
                <div className="upload-sub">Один номер на строку</div>
              </label>
            </div>
            <div className="card">
              <h3>Шаблон</h3>
              <div className="form-group">
                <textarea value={message} onChange={e => setMessage(e.target.value)} disabled={running}
                  placeholder="{Привет|Здравствуйте}! {Подскажите|Хотел узнать}, {актуально|интересно}?" />
              </div>
              <div className="hint">Спинтакс: {'{вариант1|вариант2}'} для уникальности</div>
            </div>
          </div>
          <div>
            <div className="card">
              <h3>Настройки</h3>
              <div className="form-row">
                <div className="form-group"><label>С 1 аккаунта</label>
                  <input type="number" value={msgsPerAcc} onChange={e => setMsgsPerAcc(e.target.value)} disabled={running} /></div>
                <div className="form-group"><label>Всего (0=все)</label>
                  <input type="number" value={totalMsgs} onChange={e => setTotalMsgs(e.target.value)} disabled={running} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Задержка от, сек</label>
                  <input type="number" value={tDelayMin} onChange={e => setTDelayMin(e.target.value)} disabled={running} /></div>
                <div className="form-group"><label>Задержка до, сек</label>
                  <input type="number" value={tDelayMax} onChange={e => setTDelayMax(e.target.value)} disabled={running} /></div>
              </div>
              <div className="form-group"><label>Пауза каждые N</label>
                <input type="number" value={pauseAfter} onChange={e => setPauseAfter(e.target.value)} disabled={running} /></div>
              <div className="form-row">
                <div className="form-group"><label>Пауза от, сек</label>
                  <input type="number" value={pauseMin} onChange={e => setPauseMin(e.target.value)} disabled={running} /></div>
                <div className="form-group"><label>Пауза до, сек</label>
                  <input type="number" value={pauseMax} onChange={e => setPauseMax(e.target.value)} disabled={running} /></div>
              </div>
            </div>
            <div className="btn-group">
              {!running
                ? <button className="btn btn-primary" onClick={start}>Запустить</button>
                : <button className="btn btn-danger" onClick={stop}>Остановить</button>}
            </div>
            <div className="card section-gap">
              <h3>Прогресс</h3>
              <div className="stats">
                <div className="stat"><div className="value highlight">{progress.sent}</div><div className="label">Отправлено</div></div>
                <div className="stat"><div className="value">{progress.remaining}</div><div className="label">Осталось</div></div>
              </div>
              {numCount > 0 && <div className="progress-bar-container"><div className="progress-bar-fill" style={{ width: `${(progress.sent / numCount) * 100}%` }} /></div>}
            </div>
          </div>
        </div>
        <div className="card section-gap">
          <h3>Журнал</h3>
          <div className="log-area" ref={logRef}>
            {logs.map((l, i) => <p key={i}>{l}</p>)}
            {!logs.length && <p className="log-empty">Записи появятся после запуска...</p>}
          </div>
        </div>
      </div>
    </>
  );
}