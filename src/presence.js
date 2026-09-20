'use strict';

// Your warframe.market status: what other traders see beside your orders.

const WebSocketImpl = globalThis.WebSocket || require('ws');

const URL = 'wss://ws.warframe.market/socket';
const SUBPROTOCOL = 'wfm';

const SIGN_IN = '@wfm|cmd/auth/signIn';
const SET_STATUS = '@wfm|cmd/status/set';
const STATUS_EVENT = '@wfm|event/status/set';
const PROTECT_ERROR = '@wfm|protect/error';

// What the site itself offers.
const STATUSES = ['ingame', 'online', 'invisible'];

const RETRY_MS = 20_000;

class Presence {
  constructor(account, { onChange } = {}) {
    this.account = account;
    this.onChange = onChange || (() => {});
    this.socket = null;
    this.timer = null;
    this.stopped = false;
    this.state = {
      status: null,
      statusSetAt: null,
      connected: false,
      signedIn: false,
      error: null,
    };
  }

  report() {
    return { ...this.state, options: STATUSES, hasToken: Boolean(this.account.token) };
  }

  announce() {
    this.onChange(this.report());
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.close();
  }

  // Called when the token changes: drop the old session and sign in again.
  restart() {
    this.close();
    this.state.status = null;
    this.announce();
    if (this.account.token) this.connect();
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.state.connected = false;
    this.state.signedIn = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
  }

  later() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), RETRY_MS);
  }

  connect() {
    if (this.stopped || this.socket || !this.account.token) return;

    let socket;
    try {
      socket = new WebSocketImpl(URL, SUBPROTOCOL);
    } catch (error) {
      this.state.error = error.message;
      this.announce();
      this.later();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.state.connected = true;
      this.state.error = null;
      this.send(SIGN_IN, { token: this.account.token });
      this.announce();
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handle(message);
    });

    socket.addEventListener('close', () => {
      this.close();
      this.announce();
      this.later();
    });

    socket.addEventListener('error', () => {
      // The close event follows, and that is where the retry is scheduled.
      this.state.error = 'connection failed';
    });
  }

  send(route, payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(
      JSON.stringify({ route, id: Math.random().toString(16).slice(2), payload })
    );
    return true;
  }

  handle(message) {
    const route = message.route || '';
    const body = message.payload;

    if (route.startsWith(SIGN_IN)) {
      this.state.signedIn = route.endsWith(':ok');
      if (!this.state.signedIn) this.state.error = `sign-in refused: ${JSON.stringify(body)}`;
      this.announce();
      return;
    }

    if (route.startsWith(STATUS_EVENT) || route.startsWith(`${SET_STATUS}:ok`)) {
      if (body && typeof body === 'object') {
        this.state.status = body.status ?? this.state.status;
        this.state.statusSetAt = body.statusSetAt ?? null;
        this.state.error = null;
        this.announce();
      }
      return;
    }

    if (route.startsWith(PROTECT_ERROR)) {
      this.state.error = typeof body === 'string' ? body : JSON.stringify(body);
      this.announce();
    }
  }

  async set(status) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    if (!this.state.signedIn) throw new Error('not connected to warframe.market');
    if (!this.send(SET_STATUS, { status })) throw new Error('socket not ready');

    // The server answers with the status event, which the listener picks up.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this.state.status !== status) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.report();
  }
}

module.exports = { Presence, STATUSES };
