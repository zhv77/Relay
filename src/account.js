'use strict';

// Your warframe.market account.

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://api.warframe.market/v2';
const AGENT =
  process.env.WFM_AGENT || 'Relay/0.1 (+https://github.com/zhv77/Relay)';

const WRITE_GAP_MS = 1100;
let lastWrite = 0;


// The token out of a v1 sign-in reply, header first and cookie after.
function tokenFrom(response) {
  const header = response.headers.get('authorization');
  if (header) return header.replace(/^JWT\s+/i, '').trim();

  const cookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const cookie of cookies) {
    const match = /(?:^|;\s*)JWT=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// What went wrong, in words.
function signInError(body, status) {
  const error = body?.error;
  const keys = [];
  if (error && typeof error === 'object') {
    for (const value of Object.values(error)) {
      if (Array.isArray(value)) keys.push(...value.map(String));
      else if (value && typeof value === 'object') keys.push(...Object.values(value).map(String));
      else if (value) keys.push(String(value));
    }
  }
  const said = keys.join(' ');

  if (/email_not_exist/.test(said)) return 'no account with that email';
  if (/password/.test(said) && /wrong|invalid|not_match/.test(said)) return 'wrong password';
  if (/banned|suspend/.test(said)) return 'that account is suspended';
  if (/captcha|appCheck/.test(said)) {
    return 'warframe.market refused the sign-in from outside its own app; paste a token instead';
  }
  if (status === 429) return 'too many attempts - wait a minute and try again';
  return said || `sign-in failed (${status})`;
}

class Account {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'account.json');
    this.token = null;
    this.user = null;
    this.error = null;
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.token = saved.token || null;
    } catch {
      this.token = null;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ token: this.token }), { mode: 0o600 });
  }

  // Sign in with the warframe.market account itself.
  async signIn(email, password) {
    const response = await fetch('https://api.warframe.market/v1/auth/signin', {
      method: 'POST',
      headers: {
        // v1 wants the header present and empty; it answers with the token in the same header.
        Authorization: 'JWT',
        'User-Agent': AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        platform: 'pc',
        language: 'en',
      },
      body: JSON.stringify({ email, password, auth_type: 'header' }),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      // An error page rather than an answer; the status still says enough.
    }

    if (!response.ok) throw new Error(signInError(body, response.status));

    const token = tokenFrom(response);
    if (!token) throw new Error('signed in, but warframe.market returned no token');

    this.setToken(token);
    return this.status();
  }

  setToken(token) {
    this.token = (token || '').trim() || null;
    this.user = null;
    this.error = null;
    this.save();
    return this.status();
  }

  masked() {
    if (!this.token) return null;
    return `${this.token.slice(0, 6)}...${this.token.slice(-4)} (${this.token.length} chars)`;
  }

  async request(method, pathname, body) {
    if (!this.token) throw new Error('no warframe.market token set');
    if (method !== 'GET') {
      const wait = lastWrite + WRITE_GAP_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastWrite = Date.now();
    }
    const response = await fetch(BASE + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': AGENT,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('token rejected - sign in again and copy a fresh one');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${response.status}: ${text.slice(0, 200)}`);
    }
    return response.status === 204 ? {} : response.json();
  }

  async status() {
    if (!this.token) return { hasToken: false };
    try {
      const body = await this.request('GET', '/me');
      this.user = body.data || null;
      this.error = null;
      return {
        hasToken: true,
        masked: this.masked(),
        valid: true,
        name: this.user?.ingameName || null,
        platform: this.user?.platform || null,
      };
    } catch (error) {
      this.error = error.message;
      return { hasToken: true, masked: this.masked(), valid: false, error: error.message };
    }
  }

  // Your live orders, keyed by item id.
  async orders() {
    const body = await this.request('GET', '/orders/my');
    const rows = (body.data || []).map((order) => ({
      id: order.id,
      itemId: order.itemId || order.item?.id || null,
      slug: order.item?.slug || null,
      type: order.type,
      platinum: order.platinum,
      quantity: order.quantity,
      rank: order.rank ?? null,
      visible: order.visible !== false,
    }));
    return rows;
  }

  create(order) {
    return this.request('POST', '/order', {
      itemId: order.itemId,
      type: order.type || 'sell',
      platinum: Math.max(1, Math.round(order.platinum)),
      quantity: Math.max(1, Math.round(order.quantity || 1)),
      rank: order.rank ?? 0,
      visible: true,
    });
  }

  remove(orderId) {
    return this.request('DELETE', `/order/${orderId}`);
  }
}

module.exports = { Account };
