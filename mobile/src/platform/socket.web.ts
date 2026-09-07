import type { Socket, SocketFactory } from '../gateway/connection';
export const socketFactory: SocketFactory = url => new WebSocket(url) as unknown as Socket;
