import type { LogLine, ServerEvent, Topic } from '@derailed/shared';

/**
 * In-process pub/sub. Everything that changes server-side publishes here; the WS
 * layer fans it out to subscribed browsers. Nothing else in the app knows about sockets.
 */
export interface Subscriber {
  topics: Set<Topic>;
  send(event: ServerEvent): void;
}

const subscribers = new Set<Subscriber>();
const listeners = new Set<(topic: Topic, event: ServerEvent) => void>();

export function addSubscriber(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

export function subscriberCount(): number {
  return subscribers.size;
}

export function publish(topic: Topic, event: ServerEvent): void {
  for (const sub of subscribers) {
    if (sub.topics.has(topic)) {
      try {
        sub.send(event);
      } catch {
        subscribers.delete(sub);
      }
    }
  }
  for (const listener of listeners) listener(topic, event);
}

export function publishAll(topics: Topic[], event: ServerEvent): void {
  const seen = new Set<Subscriber>();
  for (const sub of subscribers) {
    if (seen.has(sub)) continue;
    if (topics.some((t) => sub.topics.has(t))) {
      seen.add(sub);
      try {
        sub.send(event);
      } catch {
        subscribers.delete(sub);
      }
    }
  }
  for (const listener of listeners) for (const topic of topics) listener(topic, event);
}

/** Test hook: observe everything that gets published. */
export function onPublish(listener: (topic: Topic, event: ServerEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Log lines arrive one at a time from Docker but a chatty build would melt the
 * browser, so they are coalesced into 100ms batches per key.
 */
export class LogBatcher {
  private buffers = new Map<string, LogLine[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly flushMs = 100,
    private readonly maxBatch = 500,
  ) {}

  push(
    key: string,
    topics: Topic[],
    line: LogLine,
    build: (lines: LogLine[]) => ServerEvent,
  ): void {
    const buffer = this.buffers.get(key) ?? [];
    buffer.push(line);
    this.buffers.set(key, buffer);

    if (buffer.length >= this.maxBatch) {
      this.flush(key, topics, build);
      return;
    }
    if (!this.timers.has(key)) {
      this.timers.set(
        key,
        setTimeout(() => this.flush(key, topics, build), this.flushMs),
      );
    }
  }

  flush(key: string, topics: Topic[], build: (lines: LogLine[]) => ServerEvent): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    const buffer = this.buffers.get(key);
    if (!buffer?.length) return;
    this.buffers.delete(key);
    publishAll(topics, build(buffer));
  }

  clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.buffers.delete(key);
  }
}

export const logBatcher = new LogBatcher();
