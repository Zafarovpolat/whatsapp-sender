import { Routes, Route, NavLink } from 'react-router-dom';
import Accounts from './pages/Accounts';
import Sender   from './pages/Sender';
import Checker  from './pages/Checker';
import Warmer   from './pages/Warmer';

export default function App() {
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="logo" />

        <NavLink to="/" end data-label="Аккаунты">
          <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </NavLink>

        <NavLink to="/sender" data-label="Рассылка">
          <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </NavLink>

        <NavLink to="/checker" data-label="Чекер">
          <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </NavLink>

        <NavLink to="/warmer" data-label="Прогрев">
          <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
            <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
          </svg>
        </NavLink>
      </nav>

      <main className="content">
        <Routes>
          <Route path="/"        element={<Accounts />} />
          <Route path="/sender"  element={<Sender />}   />
          <Route path="/checker" element={<Checker />}   />
          <Route path="/warmer"  element={<Warmer />}    />
        </Routes>
      </main>
    </div>
  );
}