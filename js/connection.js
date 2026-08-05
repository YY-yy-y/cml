// ============================================================================
//  connection.js — общий модуль связи ТВ ↔ телефон поверх PeerJS.
//  Бэкенда нет: используем бесплатный публичный брокер PeerJS.
//
//  Публичное API:
//    createHost(onMessage, onStatus)  -> { id, send, destroy }
//    joinHost(id, onMessage, onStatus) -> { send, destroy }
//    send(type, payload)
//
//  Статусы (onStatus): 'connecting' | 'online' | 'connected' | 'offline' | 'reconnecting'
// ============================================================================

import { CONFIG } from './config.js';

// Алфавит без похожих символов (нет 0/O, 1/I/L и т.п.) — id читаемый и надёжный.
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Сгенерировать короткий читаемый id вида mama-bd-XK7Q3
export function makeSessionId() {
  let s = '';
  for (let i = 0; i < CONFIG.connection.idLength; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return CONFIG.connection.idPrefix + s;
}

// Проверка, что глобальный Peer из CDN доступен.
function hasPeerLib() {
  return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

// --------------------------------------------------------------------------
//  ХОСТ (телевизор)
// --------------------------------------------------------------------------
export function createHost(onMessage, onStatus) {
  const id = makeSessionId();
  const status = (s) => { try { onStatus && onStatus(s); } catch (e) {} };

  let peer = null;
  let conn = null;             // активное соединение с телефоном
  let destroyed = false;
  let offlineTimer = null;
  let reconnectAttempt = 0;

  // Если брокер не поднялся за отведённое время — уходим в офлайн, но не падаем.
  offlineTimer = setTimeout(() => {
    if (!peer || !peer.open) status('offline');
  }, CONFIG.connection.offlineTimeoutMs);

  function wireConn(c) {
    conn = c;
    c.on('open', () => { reconnectAttempt = 0; status('connected'); });
    c.on('data', (data) => { safeHandle(onMessage, data); });
    c.on('close', () => { if (conn === c) conn = null; status('online'); });
    c.on('error', () => {});
  }

  function build() {
    if (destroyed || !hasPeerLib()) { status('offline'); return; }
    try {
      peer = new window.Peer(id, { debug: 0 });
    } catch (e) {
      status('offline');
      return;
    }

    peer.on('open', () => {
      clearTimeout(offlineTimer);
      status('online');
    });
    // Телефон инициирует соединение — ждём входящее.
    peer.on('connection', (c) => { wireConn(c); });
    peer.on('disconnected', () => {
      if (destroyed) return;
      status('reconnecting');
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', (err) => {
      // 'unavailable-id' — id занят (например повторная загрузка). Не критично для показа.
      if (destroyed) return;
      // Для сетевых ошибок пробуем пересобрать пир с экспоненциальной задержкой.
      if (err && (err.type === 'network' || err.type === 'server-error')) {
        scheduleRebuild();
      }
    });
  }

  function scheduleRebuild() {
    if (destroyed) return;
    reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
    status('reconnecting');
    setTimeout(() => {
      if (destroyed) return;
      try { peer && peer.destroy(); } catch (e) {}
      build();
    }, delay);
  }

  build();

  return {
    id,
    send(type, payload) {
      if (conn && conn.open) {
        try { conn.send({ type, payload }); } catch (e) {}
      }
    },
    isConnected() { return !!(conn && conn.open); },
    destroy() {
      destroyed = true;
      clearTimeout(offlineTimer);
      try { peer && peer.destroy(); } catch (e) {}
    },
  };
}

// --------------------------------------------------------------------------
//  КЛИЕНТ (телефон)
// --------------------------------------------------------------------------
export function joinHost(hostId, onMessage, onStatus) {
  const status = (s) => { try { onStatus && onStatus(s); } catch (e) {} };

  let peer = null;
  let conn = null;
  let destroyed = false;
  let offlineTimer = null;
  let reconnectAttempt = 0;

  offlineTimer = setTimeout(() => {
    if (!conn || !conn.open) status('offline');
  }, CONFIG.connection.offlineTimeoutMs);

  function connectToHost() {
    if (destroyed || !peer || !peer.open) return;
    try {
      conn = peer.connect(hostId, { reliable: true });
    } catch (e) { scheduleReconnect(); return; }

    conn.on('open', () => {
      clearTimeout(offlineTimer);
      reconnectAttempt = 0;
      status('connected');
    });
    conn.on('data', (data) => { safeHandle(onMessage, data); });
    conn.on('close', () => { status('reconnecting'); scheduleReconnect(); });
    conn.on('error', () => { scheduleReconnect(); });
  }

  function scheduleReconnect() {
    if (destroyed) return;
    reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
    status('reconnecting');
    setTimeout(() => {
      if (destroyed) return;
      if (peer && peer.open) connectToHost();
    }, delay);
  }

  function build() {
    if (destroyed || !hasPeerLib()) { status('offline'); return; }
    try {
      peer = new window.Peer({ debug: 0 });
    } catch (e) { status('offline'); return; }

    peer.on('open', () => { status('online'); connectToHost(); });
    peer.on('disconnected', () => {
      if (destroyed) return;
      status('reconnecting');
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', (err) => {
      if (destroyed) return;
      if (err && (err.type === 'network' || err.type === 'server-error' ||
                  err.type === 'peer-unavailable')) {
        scheduleReconnect();
      }
    });
  }

  build();

  return {
    send(type, payload) {
      if (conn && conn.open) {
        try { conn.send({ type, payload }); } catch (e) {}
      }
    },
    isConnected() { return !!(conn && conn.open); },
    destroy() {
      destroyed = true;
      clearTimeout(offlineTimer);
      try { peer && peer.destroy(); } catch (e) {}
    },
  };
}

// Безопасно передаём входящее сообщение обработчику.
function safeHandle(onMessage, data) {
  if (!data || typeof data !== 'object') return;
  try { onMessage && onMessage(data.type, data.payload); } catch (e) {}
}
