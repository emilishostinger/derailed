import { describe, expect, test } from 'bun:test';
import { demultiplex, LineAssembler, stripAnsi } from '../src/docker/logs.ts';

/** Builds a Docker multiplexed frame: [type, 0,0,0, size(uint32 BE)] + payload. */
function frame(stream: 1 | 2, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, payload.length, false);
  out.set(payload, 8);
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]) {
  const out: { stream: string; text: string }[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of demultiplex(streamOf(chunks))) {
    out.push({ stream: chunk.stream, text: decoder.decode(chunk.data) });
  }
  return out;
}

describe('docker log demultiplexer', () => {
  test('separates stdout from stderr', async () => {
    expect(await collect([frame(1, 'hello\n'), frame(2, 'oh no\n')])).toEqual([
      { stream: 'stdout', text: 'hello\n' },
      { stream: 'stderr', text: 'oh no\n' },
    ]);
  });

  test('reassembles a frame split across chunks', async () => {
    const whole = frame(1, 'a long line of build output\n');
    const chunks = [whole.slice(0, 3), whole.slice(3, 9), whole.slice(9)];
    expect(await collect(chunks)).toEqual([
      { stream: 'stdout', text: 'a long line of build output\n' },
    ]);
  });

  test('handles several frames arriving in one chunk', async () => {
    const combined = new Uint8Array([...frame(1, 'one\n'), ...frame(1, 'two\n')]);
    expect(await collect([combined])).toHaveLength(2);
  });

  test('ignores a trailing partial frame', async () => {
    const whole = frame(1, 'complete\n');
    expect(await collect([whole, frame(1, 'incomplete').slice(0, 5)])).toHaveLength(1);
  });
});

describe('line assembler', () => {
  test('holds back partial lines until the newline arrives', () => {
    const assembler = new LineAssembler();
    const encode = (s: string) => new TextEncoder().encode(s);

    expect(assembler.push('stdout', encode('npm in'))).toEqual([]);
    expect(assembler.push('stdout', encode('stall\nnext li'))).toEqual(['npm install']);
    expect(assembler.drain('stdout')).toEqual(['next li']);
  });

  test('keeps stdout and stderr separate', () => {
    const assembler = new LineAssembler();
    const encode = (s: string) => new TextEncoder().encode(s);
    assembler.push('stdout', encode('out-part'));
    assembler.push('stderr', encode('err-part'));
    expect(assembler.drain('stdout')).toEqual(['out-part']);
    expect(assembler.drain('stderr')).toEqual(['err-part']);
  });
});

describe('ansi stripping', () => {
  test('removes colour codes build tools emit', () => {
    expect(stripAnsi('\u001b[32msuccess\u001b[0m')).toBe('success');
    expect(stripAnsi('\u001b[1m\u001b[31mERROR\u001b[0m in ./src/app.js')).toBe(
      'ERROR in ./src/app.js',
    );
    expect(stripAnsi('plain text')).toBe('plain text');
    expect(stripAnsi('carriage\r')).toBe('carriage');
  });
});
