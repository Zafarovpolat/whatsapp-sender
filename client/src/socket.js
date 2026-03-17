import { io } from 'socket.io-client';

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

// ═══ НОВОЕ: получить socket.id для заголовка ═══
export function getSocketId() {
  return socketInstance?.id || '';
}

export function disconnectSocket() {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}

export const socket = new Proxy({}, {
  get(_, prop) {
    if (!socketInstance) return () => {};
    return typeof socketInstance[prop] === 'function' 
      ? socketInstance[prop].bind(socketInstance) 
      : socketInstance[prop];
  }
});