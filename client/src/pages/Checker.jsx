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
  const [resultFile, setResultFile] = useState(null);
  const logRef = useRef();

  useEffect(() => {
    axios.get('/api/sessions').then(r => setSessions(r.data));

    const onUpdate = (data) => setSessions(data);
    const onLog = (m) => setLogs(p => [...p, m]);
    const onProgress = (data) => setProgress(data);
    const onComplete = (data) => {
      setRunning(false);
      if (data.filename) {
        setResultFile(data.filename);
      }
    };
    const onError = (m) => { setLogs(p => [...p, `[ERR] ${m}`]); setRunning(false); };

    if (socket) {
      socket.on('sessions:update', onUpdate);
      socket.on('checker:log', onLog);
      socket.on('checker:progress', onProgress);
      socket.on('checker:complete', onComplete);
      socket.on('checker:error', onError);
    }

    return () => {
      if (socket) {
        ['sessions:update','checker:log','checker:progress','checker:complete','checker:error'].forEach(e => socket.off(e));
      }
    };
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
    setLogs([]); setProgress({ checked: 0, total: numCount, valid: 0 }); setRunning(true); setResultFile(null);
    await axios.post('/api/checker/start', { sessionId: selectedId, numbersFilePath: filePath });
  };

  const stop = async () => { await axios.post('/api/checker/stop'); setRunning(false); };

  const download = () => {
    if (!resultFile) return;
    const token = localStorage.getItem('auth_token') || '';
    // Скачиваем через fetch с токеном
    fetch(`/api/download/${resultFile}`, {
      headers: { 'x-auth-token': token }
    })
      .then(res => res.blob())
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = resultFile;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      })
      .catch(() => alert('Ошибка скачивания'));
  };

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
              
              {resultFile ? (
                <button className="btn btn-primary" onClick={download} style={{ marginTop: 12, width: '100%' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8, verticalAlign: 'middle' }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Скачать результат ({progress.valid} номеров)
                </button>
              ) : (
                <div className="hint">Валидные номера можно будет скачать после проверки</div>
              )}
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