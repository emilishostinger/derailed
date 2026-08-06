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
        for (const topic of topicList(message.topics).slice(0, MAX_TOPICS_PER_CLIENT)) {
          if (ws.data.topics.size < MAX_TOPICS_PER_CLIENT) ws.data.topics.add(topic);
        }
        break;
      case 'unsubscribe':
        for (const topic of topicList(message.topics)) ws.data.topics.delete(topic);
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

/**
 * The topics out of a message, or none.
 *
 * The type says it is an array of strings. The socket says it is whatever the other
 * end typed: `{"type":"subscribe","topics":7}` reached `.slice` on a number and threw
 * out of Bun's message handler, where nothing was waiting to catch it.
 */
function topicList(topics: unknown): Topic[] {
  if (!Array.isArray(topics)) return [];
  return topics.filter((topic): topic is Topic => typeof topic === 'string');
}

function send(ws: ServerWebSocket<WsData>, event: ServerEvent): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // socket already gone
  }
}
