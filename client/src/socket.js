import { io } from 'socket.io-client';

// В продакшене — тот же хост, в dev — localhost:3001
const URL = import.meta.env.PROD ? '' : 'http://localhost:3001';

let socketInstance = null;

export function initSocket(token) {
  if (socketInstance) {
    socketInstance.disconnect();
  }
  
  socketInstance = io(URL, {
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
    auth: { token: token || '' }
  });
  
  return socketInstance;
}

export function getSocket() {
  return socketInstance;
}

export function disconnectSocket() {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}

// Прокси-объект для обратной совместимости с import { socket }
// Все вызовы socket.on/off/emit будут проксированы на текущий socketInstance
export const socket = new Proxy({}, {
  get(_, prop) {
    if (!socketInstance) return () => {};
    return typeof socketInstance[prop] === 'function' 
      ? socketInstance[prop].bind(socketInstance) 
      : socketInstance[prop];
  }
});