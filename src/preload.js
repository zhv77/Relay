'use strict';

// The only surface the renderer gets.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('warframe', {
  updateState: () => ipcRenderer.invoke('updates:state'),
  updateAction: () => ipcRenderer.invoke('updates:act'),
  onUpdate: handler => ipcRenderer.on('updates:changed', (_event, state) => handler(state)),
  holdings: (options) => ipcRenderer.invoke('holdings:read', options),
  vendors: () => ipcRenderer.invoke('vendors:list'),
  vendorStock: (key, options) => ipcRenderer.invoke('vendors:stock', key, options),
  account: () => ipcRenderer.invoke('account:status'),
  myOrders: () => ipcRenderer.invoke('account:orders'),
  sets: (options) => ipcRenderer.invoke('sets:read', options),
  relics: (options) => ipcRenderer.invoke('relics:read', options),
  openItem: (slug) => ipcRenderer.invoke('market:open', slug),
  declareFocus: (key, slugs) => ipcRenderer.invoke('focus:set', key, slugs),
  fetchProgress: () => ipcRenderer.invoke('fetch:progress'),
  catalogue: () => ipcRenderer.invoke('catalogue:status'),
  onCatalogue: (handler) =>
    ipcRenderer.on('catalogue:changed', (_event, status) => handler(status)),
  onFetchProgress: (handler) =>
    ipcRenderer.on('fetch:progress', (_event, state) => handler(state)),
  onHoldings: (handler) => ipcRenderer.on('holdings:changed', () => handler()),
  presence: () => ipcRenderer.invoke('presence:read'),
  setPresence: (status) => ipcRenderer.invoke('presence:set', status),
  // Pushed rather than polled: the socket is told when status changes.
  onPresence: (handler) =>
    ipcRenderer.on('presence:changed', (_event, state) => handler(state)),
  setToken: (token) => ipcRenderer.invoke('account:setToken', token),
  signIn: (email, password) => ipcRenderer.invoke('account:signIn', email, password),
  postOrders: (orders) => ipcRenderer.invoke('orders:post', orders),
  removeOrders: (ids) => ipcRenderer.invoke('orders:remove', ids),
});
