import type { CredentialStorage } from '../gateway/credentials';
const KEY = 'pravaah.connection.v1';
export const credentialStorage: CredentialStorage = {
  get: async () => typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY),
  set: async value => {
    // Browser preview has no secure token store and cannot attach WebSocket auth headers.
    const settings = JSON.parse(value);
    localStorage.setItem(KEY, JSON.stringify({ ...settings, writeToken: '' }));
  },
};
