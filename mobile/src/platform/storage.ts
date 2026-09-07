import * as SecureStore from 'expo-secure-store';
import type { CredentialStorage } from '../gateway/credentials';
const KEY = 'pravaah.connection.v1';
export const credentialStorage: CredentialStorage = {
  get: () => SecureStore.getItemAsync(KEY),
  set: value => SecureStore.setItemAsync(KEY, value),
};
