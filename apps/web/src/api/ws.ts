import type { ClientMessage, ServerEvent, Topic } from '@derailed/shared';

type Handler = (event: ServerEvent) => void;

/**
 * One socket for the whole app. It reconnects on its own, re-sends the current
 * subscription set after every reconnect, and never polls.
 */
class LiveConnection {
  private socket: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private topics = new Map<Topic, number>();
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.closedByUs = false;
    const url = new URL('/api/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      const topics = [...this.topics.keys()];
      if (topics.length) this.send({ type: 'subscribe', topics });
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };

    socket.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data as string) as ServerEvent;
      } catch {
        return;
      }
      for (const handler of this.handlers) handler(event);
    };

    socket.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.socket = null;
      if (this.closedByUs) return;
      // 0.5s, 1s, 2s, 4s … capped at 10s.
      const delay = Math.min(500 * 2 ** this.attempts++, 10_000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    socket.onerror = () => socket.close();
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.topics.clear();
  }

  /** Reference-counted so two components can watch the same topic safely. */
  subscribe(topics: Topic[]): () => void {
    const fresh: Topic[] = [];
    for (const topic of topics) {
      const count = this.topics.get(topic) ?? 0;
      if (count === 0) fresh.push(topic);
      this.topics.set(topic, count + 1);
    }
    if (fresh.length) this.send({ type: 'subscribe', topics: fresh });

    return () => {
      const stale: Topic[] = [];
      for (const topic of topics) {
        const count = (this.topics.get(topic) ?? 1) - 1;
        if (count <= 0) {
          this.topics.delete(topic);
          stale.push(topic);
        } else {
          this.topics.set(topic, count);
        }
      }
      if (stale.length) this.send({ type: 'unsubscribe', topics: stale });
    };
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

export const live = new LiveConnection();
