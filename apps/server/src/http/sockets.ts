import type { ServerWebSocket } from 'bun';
import { type DevData, devHandlers } from '../runtime/devtunnel.ts';
import { type TunnelData, tunnelHandlers } from '../runtime/tunnel.ts';
import { type TerminalData, terminalHandlers } from './terminal.ts';
import { type WsData, websocketHandlers } from './ws.ts';

type SocketData = ({ kind: 'events' } & WsData) | TerminalData | TunnelData | DevData;

/**
 * Bun takes a single websocket handler for the whole server, so the two kinds of
 * socket (the event stream and a terminal) are dispatched on the tag set at upgrade.
 */
export const socketHandlers = {
  open(ws: ServerWebSocket<SocketData>) {
    if (ws.data.kind === 'terminal') {
      void terminalHandlers.open(ws as ServerWebSocket<TerminalData>);
      return;
    }
    if (ws.data.kind === 'tunnel') {
      void tunnelHandlers.open(ws as ServerWebSocket<TunnelData>);
      return;
    }
    if (ws.data.kind === 'dev') {
      devHandlers.open(ws as ServerWebSocket<DevData>);
      return;
    }
    websocketHandlers.open(ws as ServerWebSocket<WsData>);
  },

  message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    if (ws.data.kind === 'terminal') {
      terminalHandlers.message(ws as ServerWebSocket<TerminalData>, raw);
      return;
    }
    if (ws.data.kind === 'tunnel') {
      tunnelHandlers.message(ws as ServerWebSocket<TunnelData>, raw);
      return;
    }
    if (ws.data.kind === 'dev') {
      devHandlers.message(ws as ServerWebSocket<DevData>, raw);
      return;
    }
    websocketHandlers.message(ws as ServerWebSocket<WsData>, raw);
  },

  close(ws: ServerWebSocket<SocketData>) {
    if (ws.data.kind === 'terminal') {
      terminalHandlers.close(ws as ServerWebSocket<TerminalData>);
      return;
    }
    if (ws.data.kind === 'tunnel') {
      tunnelHandlers.close(ws as ServerWebSocket<TunnelData>);
      return;
    }
    if (ws.data.kind === 'dev') {
      devHandlers.close(ws as ServerWebSocket<DevData>);
      return;
    }
    websocketHandlers.close(ws as ServerWebSocket<WsData>);
  },
};
