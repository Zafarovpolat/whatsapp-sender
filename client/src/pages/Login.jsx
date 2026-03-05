import { useState } from 'react';
import axios from 'axios';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await axios.post('/api/auth/login', { password });
      onLogin(data.token);
    } catch (err) {
      setError(err.response?.data?.error || 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-overlay">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h2 className="login-title">WhatsApp Sender</h2>
        <p className="login-subtitle">Введите пароль для доступа</p>
        <div className="form-group">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Пароль"
            autoFocus
            disabled={loading}
          />
        </div>
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary login-btn" type="submit" disabled={loading || !password}>
          {loading ? 'Вход...' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
