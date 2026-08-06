/**
 * A QR code, drawn here rather than fetched from anywhere.
 *
 * The obvious way to put a QR code on the screen is an image from an online generator,
 * and it is the wrong way twice over: it tells someone else's server every address you
 * deploy, and it puts a hole in a dashboard that is expected to work on a machine with
 * no outbound internet. So it is about three hundred lines of the specification instead,
 * which is the smaller cost.
 *
 * Byte mode, error correction level M, versions 1 to 10. That covers 213 characters,
 * which is a great deal more address than anybody has. Level M rather than L because
 * these get photographed off a laptop screen at an angle.
 */

/** Byte mode at level M. The index is the version. */
const CAPACITY_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** Per version: EC codewords per block, then the block groups as [count, dataCodewords]. */
const BLOCKS_M: [number, [number, number][]][] = [
  [0, []],
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [
    22,
    [
      [2, 38],
      [2, 39],
    ],
  ],
  [
    22,
    [
      [3, 36],
      [2, 37],
    ],
  ],
  [
    26,
    [
      [4, 43],
      [1, 44],
    ],
  ],
];

/** Where the little alignment squares go, by version. */
const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** The 18-bit version blocks, needed from version 7 up. Straight from the tables. */
const VERSION_BITS: Record<number, number> = {
  7: 0b000111110010010100,
  8: 0b001000010110111100,
  9: 0b001001101010011001,
  10: 0b001010010011010011,
};

// Arithmetic in GF(256) with the polynomial the specification names, done once at
// module load so the encoder itself is table lookups.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error correction codewords. */
function generator(degree: number): number[] {
  // Index 0 is the highest-degree coefficient. Multiplying by (x + a^i) therefore
  // leaves the x term at the same index and pushes the constant term one along; doing
  // it the other way round builds the polynomial back to front, which produces error
  // correction that is wrong in a way nothing else notices. The data codewords come
  // out perfect and the code still reads as damaged beyond repair.
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial remainder: the error correction codewords for one block. */
function remainder(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const out = [...data, ...new Array<number>(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = out[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      out[i + j] = out[i + j]! ^ mul(gen[j]!, factor);
    }
  }
  return out.slice(data.length);
}

class Bits {
  readonly values: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.values.push((value >> i) & 1);
  }

  get length(): number {
    return this.values.length;
  }
}

/** The smallest version the text fits in. */
function versionFor(bytes: number): number {
  for (let version = 1; version <= 10; version++) {
    if (bytes <= CAPACITY_M[version]!) return version;
  }
  throw new Error('That is too long to put in a QR code.');
}

export function encodeData(text: string, version: number): number[] {
  const bytes = new TextEncoder().encode(text);
  const [ecPerBlock, groups] = BLOCKS_M[version]!;
  const totalData = groups.reduce((sum, [count, size]) => sum + count * size, 0);

  const bits = new Bits();
  bits.push(0b0100, 4); // Byte mode.
  bits.push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) bits.push(byte, 8);

  // Terminator, up to four bits, then pad to a whole byte.
  const capacity = totalData * 8;
  bits.push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0, 1);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits.values[i + j]!;
    codewords.push(byte);
  }
  // The two pad bytes the specification names, alternating, always starting with the
  // first one. Keying that off whether the length so far happened to be odd or even
  // got it backwards half the time, and a scanner never notices: the length field says
  // where the text stops, so the padding is thrown away unread either way. The only
  // thing that ever sees it is another encoder's output, side by side.
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < totalData; i++) codewords.push(PAD[i % 2]!);

  // Split into blocks, work out each block's error correction, then interleave. The
  // interleaving is the point of the whole exercise: a coffee stain then damages a
  // little of every block rather than all of one.
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      ecBlocks.push(remainder(block, ecPerBlock));
    }
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return out;
}

type Grid = (0 | 1 | null)[][];

function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Array<0 | 1 | null>(size).fill(null));
}

function placeFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || x < 0 || y >= grid.length || x >= grid.length) continue;
      const onRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const onSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[y]![x] = onRing || onSide || inCore ? 1 : 0;
    }
  }
}

function placePatterns(grid: Grid, version: number): void {
  const size = grid.length;

  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const bit: 0 | 1 = i % 2 === 0 ? 1 : 0;
    grid[6]![i] = bit;
    grid[i]![6] = bit;
  }

  const centres = ALIGNMENT[version]!;
  const last = centres[centres.length - 1] ?? 0;
  for (const row of centres) {
    for (const col of centres) {
      // Only the three that would land on a finder pattern are skipped. Testing
      // "is this cell already taken" instead was wrong from version 7 up: the ones
      // on row six and column six cross the timing pattern quite legitimately, and
      // dropping them left every larger code unreadable.
      const onAFinder =
        (row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6);
      if (onAFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const edge = Math.abs(r) === 2 || Math.abs(c) === 2;
          grid[row + r]![col + c] = edge || (r === 0 && c === 0) ? 1 : 0;
        }
      }
    }
  }

  // The one module that is always dark, for no reason anybody has ever explained.
  grid[size - 8]![8] = 1;

  if (version >= 7) {
    const bits = VERSION_BITS[version]!;
    for (let i = 0; i < 18; i++) {
      const bit: 0 | 1 = ((bits >> i) & 1) as 0 | 1;
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      grid[row]![col] = bit;
      grid[col]![row] = bit;
    }
  }
}

/** The squares format information will occupy, kept clear of data. */
function formatCells(size: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) cells.push([8, i], [i, 8]);
  }
  for (let i = 0; i < 8; i++) cells.push([8, size - 1 - i], [size - 1 - i, 8]);
  return cells;
}

function placeData(grid: Grid, codewords: number[], reserved: Set<string>): void {
  const size = grid.length;
  let bit = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column six is the vertical timing pattern and is not part of the zigzag at all.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid[row]![col] !== null || reserved.has(`${row},${col}`)) continue;
        const byte = codewords[bit >> 3] ?? 0;
        grid[row]![col] = ((byte >> (7 - (bit & 7))) & 1) as 0 | 1;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * How bad a masked grid looks to a scanner.
 *
 * All four rules from the specification. Without them a code can come out with a run
 * that resembles a finder pattern, and a phone hunts for it for several seconds before
 * giving up, which reads as "this feature does not work".
 */
function penalty(grid: Grid): number {
  const size = grid.length;
  const at = (r: number, c: number) => grid[r]![c]!;
  let score = 0;

  // Runs of five or more of the same colour.
  for (let i = 0; i < size; i++) {
    for (const line of [(j: number) => at(i, j), (j: number) => at(j, i)]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line(j) === line(j - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Blocks of the same colour, two by two.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const value = at(r, c);
      if (at(r, c + 1) === value && at(r + 1, c) === value && at(r + 1, c + 1) === value) {
        score += 3;
      }
    }
  }

  // Anything that looks like a finder pattern, in either direction.
  const LOOKS_LIKE_A_FINDER = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      for (const pattern of LOOKS_LIKE_A_FINDER) {
        if (pattern.every((bit, k) => at(i, j + k) === bit)) score += 40;
        if (pattern.every((bit, k) => at(j + k, i) === bit)) score += 40;
      }
    }
  }

  // Too far from half dark.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += at(r, c);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** Format information: five bits of meaning, ten of BCH, then the standard mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // Level M is 00.
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (10 + i)) & 1) bch ^= 0b10100110111 << i;
  }
  return ((data << 10) | bch) ^ 0b101010000010010;
}

function placeFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = formatBits(mask);

  // Most significant bit first. Reading these back out of a code made by another
  // encoder is what settled it: the fifteen bits run from bit fourteen at (8,0), not
  // from bit zero, and getting that backwards produces a code that is correct in
  // every other respect and readable by nothing.
  const bit = (i: number): 0 | 1 => ((bits >> (14 - i)) & 1) as 0 | 1;

  // The copy around the top-left finder.
  for (let i = 0; i <= 5; i++) grid[8]![i] = bit(i);
  grid[8]![7] = bit(6);
  grid[8]![8] = bit(7);
  grid[7]![8] = bit(8);
  for (let i = 9; i <= 14; i++) grid[14 - i]![8] = bit(i);

  // And the copy split between the other two, which is the one a scanner falls back
  // on when the first is damaged.
  for (let i = 0; i <= 6; i++) grid[size - 1 - i]![8] = bit(i);
  for (let i = 7; i <= 14; i++) grid[8]![size - 15 + i] = bit(i);
}

/**
 * The finished thing: a square of true and false, where true is a dark module.
 *
 * No quiet zone here. Whatever draws it adds the margin, because how much white space
 * to leave is a layout decision rather than an encoding one.
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text).length;
  const version = versionFor(bytes);
  const size = 17 + 4 * version;

  const base = blank(size);
  placePatterns(base, version);
  const reserved = new Set(formatCells(size).map(([r, c]) => `${r},${c}`));

  const codewords = encodeData(text, version);
  placeData(base, codewords, reserved);

  // Every mask is tried and the least ugly wins, which is what the specification asks
  // for and what makes the difference between a code that scans instantly and one
  // somebody has to wave their phone at.
  let best: Grid | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask++) {
    // Only the data region is masked: the finder, timing and alignment patterns are
    // fixed. Those are exactly the cells that were already filled before data went in,
    // so the two are told apart by building the patterns again on an empty grid.
    const masked = blank(size);
    placePatterns(masked, version);
    const dataOnly = blank(size);
    placePatterns(dataOnly, version);
    placeData(dataOnly, codewords, reserved);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (masked[r]![c] !== null) continue;
        if (reserved.has(`${r},${c}`)) continue;
        const bit = dataOnly[r]![c] ?? 0;
        masked[r]![c] = (MASKS[mask]!(r, c) ? bit ^ 1 : bit) as 0 | 1;
      }
    }
    placeFormat(masked, mask);

    const score = penalty(masked as Grid);
    if (score < bestScore) {
      bestScore = score;
      best = masked;
    }
  }

  return best!.map((row) => row.map((cell) => cell === 1));
}

/** The same thing as an SVG string, which is what the screen actually wants. */
export function qrSvg(text: string, options: { size?: number; margin?: number } = {}): string {
  const modules = encodeQr(text);
  const margin = options.margin ?? 2;
  const count = modules.length + margin * 2;
  const scale = (options.size ?? 160) / count;

  let path = '';
  for (let r = 0; r < modules.length; r++) {
    for (let c = 0; c < modules.length; c++) {
      if (modules[r]![c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count} ${count}"`,
    ` width="${Math.round(count * scale)}" height="${Math.round(count * scale)}"`,
    ' shape-rendering="crispEdges">',
    `<rect width="${count}" height="${count}" fill="#fff"/>`,
    `<path d="${path}" fill="#000"/>`,
    '</svg>',
  ].join('');
}
