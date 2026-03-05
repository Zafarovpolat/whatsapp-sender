import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { socket } from '../socket';

export default function Checker() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [fileName, setFileName] = useState('');
  const [filePath, setFilePath] = useState('');
  const [numCount, setNumCount] = useState(0);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState({ checked: 0, total: 0, valid: 0 });
  const logRef = useRef();

  useEffect(() => {
    axios.get('/api/sessions').then(r => setSessions(r.data));
    socket.on('sessions:update', setSessions);
    socket.on('checker:log', m => setLogs(p => [...p, m]));
    socket.on('checker:progress', setProgress);
    socket.on('checker:complete', () => setRunning(false));
    socket.on('checker:error', m => { setLogs(p => [...p, `[ERR] ${m}`]); setRunning(false); });
    return () => { ['sessions:update','checker:log','checker:progress','checker:complete','checker:error'].forEach(e => socket.off(e)); };
  }, []);

  useEffect(() => { logRef.current && (logRef.current.scrollTop = logRef.current.scrollHeight); }, [logs]);

  const upload = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    const { data } = await axios.post('/api/upload', fd);
    setFilePath(data.path); setNumCount(data.count); setFileName(f.name);
  };

  const start = async () => {
    if (!selectedId) return alert('Выберите аккаунт');
    if (!filePath) return alert('Загрузите файл');
    setLogs([]); setProgress({ checked: 0, total: numCount, valid: 0 }); setRunning(true);
    await axios.post('/api/checker/start', { sessionId: selectedId, numbersFilePath: filePath });
  };

  const stop = async () => { await axios.post('/api/checker/stop'); setRunning(false); };
  const ready = sessions.filter(s => s.status === 'ready');

  return (
    <>
      <div className="page-header">
        <h1 className="page-title"><span className="title-dot" />Чекер номеров</h1>
      </div>
      <div className="page-body">
        <div className="grid-2">
          <div>
            <div className="card">
              <h3>Аккаунт</h3>
              <div className="form-group">
                <select value={selectedId} onChange={e => setSelectedId(e.target.value)} disabled={running}>
                  <option value="">Выберите аккаунт</option>
                  {ready.map(s => <option key={s.id} value={s.id}>{s.displayName} {s.info?.phone ? `(+${s.info.phone})` : ''}</option>)}
                </select>
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
            <div className="btn-group">
              {!running
                ? <button className="btn btn-primary" onClick={start}>Начать проверку</button>
                : <button className="btn btn-danger" onClick={stop}>Остановить</button>}
            </div>
          </div>
          <div>
            <div className="card">
              <h3>Результат</h3>
              <div className="stats">
                <div className="stat"><div className="value">{progress.checked}</div><div className="label">Проверено</div></div>
                <div className="stat"><div className="value highlight">{progress.valid}</div><div className="label">Есть WA</div></div>
                <div className="stat"><div className="value">{progress.total}</div><div className="label">Всего</div></div>
              </div>
              {progress.total > 0 && <div className="progress-bar-container"><div className="progress-bar-fill" style={{ width: `${(progress.checked / progress.total) * 100}%` }} /></div>}
              <div className="hint">Валидные номера сохранятся на рабочий стол</div>
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