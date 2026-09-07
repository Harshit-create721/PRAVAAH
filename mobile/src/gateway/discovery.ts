import type { Endpoint, Settings } from './types';
export const DEFAULT_SETTINGS: Settings = { relayUrl: 'wss://api.sih.shubhang.dev', lanUrl: '', writeToken: '', operator: '', configured: false };
function localHost(host: string) {
  return host === 'localhost' || host === '[::1]' || host.endsWith('.local') || /^127\./.test(host)
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
export function endpoint(input: string, mode: Endpoint['mode']): Endpoint {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a complete URL, including https:// or wss://.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Use an HTTP or WebSocket URL.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Keep credentials out of URLs. Enter the write token separately.');
  if (!['/', '/subscribe', '/ws', ''].includes(url.pathname)) throw new Error('Enter the server address without an API path.');
  if (['http:', 'ws:'].includes(url.protocol) && !localHost(url.hostname)) throw new Error('Public connections require HTTPS or WSS.');
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const baseUrl = `${secure ? 'https' : 'http'}://${url.host}`;
  return { mode, baseUrl, url: `${secure ? 'wss' : 'ws'}://${url.host}/${mode === 'relay' ? 'subscribe' : 'ws'}` };
}
export function endpointsFor(settings: Settings): Endpoint[] {
  return [endpoint(settings.relayUrl, 'relay'), ...(settings.lanUrl.trim() ? [endpoint(settings.lanUrl, 'lan')] : [])];
}
