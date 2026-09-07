import type { Socket, SocketFactory } from '../gateway/connection';
export const socketFactory: SocketFactory = (url, headers) => {
  // React Native explicitly supports the third options argument. The relay reads Authorization.
  const NativeWebSocket = WebSocket as unknown as new (url: string, protocols: null, options: { headers?: Record<string, string> }) => Socket;
  return new NativeWebSocket(url, null, { headers });
};
