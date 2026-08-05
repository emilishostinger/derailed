import type { ServerWebSocket } from 'bun';
import { type TerminalData, terminalHandlers } from './terminal.ts';
import { type WsData, websocketHandlers } from './ws.ts';

type SocketData = ({ kind: 'events' } & WsData) | TerminalData;

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
    websocketHandlers.open(ws as ServerWebSocket<WsData>);
  },

  message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    if (ws.data.kind === 'terminal') {
      terminalHandlers.message(ws as ServerWebSocket<TerminalData>, raw);
      return;
    }
    websocketHandlers.message(ws as ServerWebSocket<WsData>, raw);
  },

  close(ws: ServerWebSocket<SocketData>) {
    if (ws.data.kind === 'terminal') {
      terminalHandlers.close(ws as ServerWebSocket<TerminalData>);
      return;
    }
    websocketHandlers.close(ws as ServerWebSocket<WsData>);
  },
};
