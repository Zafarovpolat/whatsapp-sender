import { io } from 'socket.io-client';

// В продакшене — тот же хост, в dev — localhost:3001
const URL = import.meta.env.PROD ? '' : 'http://localhost:3001';

export const socket = io(URL);