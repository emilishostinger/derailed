import type { ClientMessage, ServerEvent, Topic } from '@derailed/shared';
import type { ServerWebSocket } from 'bun';
import { VERSION } from '../config.ts';
import { addSubscriber } from '../events/bus.ts';
import { systemInfo } from '../system/status.ts';

export interface WsData {
  kind?: 'events';
  userId: string;
  topics: Set<Topic>;
  unsubscribe?: () => void;
}

const MAX_TOPICS_PER_CLIENT = 200;

export const websocketHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    ws.data.topics = new Set<Topic>(['system']);
    ws.data.unsubscribe = addSubscriber({
      topics: ws.data.topics,
      send: (event: ServerEvent) => ws.send(JSON.stringify(event)),
    });
    send(ws, { type: 'hello', version: VERSION });
    void systemInfo().then((system) => send(ws, { type: 'system', system }));
  },

  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let message: ClientMessage;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'subscribe':
        for (const topic of message.topics.slice(0, MAX_TOPICS_PER_CLIENT)) {
          if (ws.data.topics.size < MAX_TOPICS_PER_CLIENT) ws.data.topics.add(topic);
        }
        break;
      case 'unsubscribe':
        for (const topic of message.topics) ws.data.topics.delete(topic);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  },

  close(ws: ServerWebSocket<WsData>) {
    ws.data.unsubscribe?.();
  },
};

function send(ws: ServerWebSocket<WsData>, event: ServerEvent): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // socket already gone
  }
}
