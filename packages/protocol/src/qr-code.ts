// QR codes, ported from rqrcode_core 2.1.0 and rqrcode 3.2.0's `as_svg`, which Campfire draws them with:
// `RQRCode::QRCode.new(url).as_svg(viewbox: true, fill: :white, color: :black)`. The Worker draws them
// at `/qr_code/<id>`, and the app draws a sign-in link's itself, so the link never reaches the Worker.
// Neither imports this from the package's index, so the app loads it only once it's needed.
//
// The SVG has to be byte for byte the gem's, so this follows its algorithms rather than the QR spec's
// best choices: a single segment whose mode is numeric, alphanumeric or 8-bit byte (in that order of
// preference), error correction level H, the smallest version whose capacity is *strictly* greater
// than the segment's bits, and the mask with the fewest "lost points" as the gem scores them,
// floating-point dark-ratio term included.

/** rqrcode's `as_svg(viewbox: true, fill: :white, color: :black)`, or null when `data` doesn't fit a version 40 code. */
export function qrCodeSvg(data: Uint8Array): string | null {
  const code = qrCode(data);
  if (!code) return null;
  const moduleSize = 11;
  const dimension = code.modules.length * moduleSize;
  let svg = '<?xml version="1.0" standalone="yes"?>';
  svg += `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ev="http://www.w3.org/2001/xml-events" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`;
  svg += `<rect width="${dimension}" height="${dimension}" x="0" y="0" fill="white"/>`;
  code.modules.forEach((cells, row) =>
    cells.forEach((dark, col) => {
      if (dark) svg += `<rect width="${moduleSize}" height="${moduleSize}" x="${col * moduleSize}" y="${row * moduleSize}" fill="black"/>`;
    }),
  );
  return `${svg}</svg>`;
}

export interface QrCode {
  version: number;
  /** Rows of modules, top to bottom: true is dark. */
  modules: boolean[][];
}

/** `RQRCodeCore::QRCode.new(data)` at level H, or null where the gem raises that it's too long for version 40. */
export function qrCode(data: Uint8Array): QrCode | null {
  const segment = segmentOf(data);
  const version = minimumVersion(segment);
  if (version === null) return null;
  const count = version * 4 + 17;

  // `make_impl(true, pattern)` places the same modules whatever the pattern, leaving the format and
  // version information light, so it's drawn once here, and each mask flips its data modules.
  const unmasked = new Grid(count);
  placePositionProbePattern(unmasked, 0, 0);
  placePositionProbePattern(unmasked, count - 7, 0);
  placePositionProbePattern(unmasked, 0, count - 7);
  placePositionAdjustPattern(unmasked, version);
  placeTimingPattern(unmasked);
  placeFormatInfo(unmasked, true, 0);
  if (version >= 7) placeVersionInfo(unmasked, version, true);
  const dataModules = mapData(unmasked, createData(version, segment));

  // `get_best_mask_pattern`: the first pattern with the fewest lost points.
  let best = { pattern: 0, grid: unmasked, points: Infinity };
  for (let pattern = 0; pattern < 8; pattern++) {
    const grid = masked(unmasked, dataModules, pattern);
    const points = lostPoints(grid);
    if (pattern === 0 || best.points > points) best = { pattern, grid, points };
  }

  // `make_impl(false, pattern)`: the same modules, with the format and version information this time.
  const { grid } = best;
  placeFormatInfo(grid, false, best.pattern);
  if (version >= 7) placeVersionInfo(grid, version, false);
  const modules = Array.from({ length: count }, (_, row) => Array.from(grid.cells.subarray(row * count, (row + 1) * count), (cell) => cell === DARK));
  return { version, modules };
}

const DARK = 1;
const LIGHT = 0;
const UNPLACED = -1;

/**
 * The modules while they're drawn, a row after another, as the gem's nested arrays of true, false and
 * nil would be. Mask scoring reads them eight times, so it pays to keep them flat.
 */
class Grid {
  constructor(
    readonly count: number,
    readonly cells = new Int8Array(count * count).fill(UNPLACED),
  ) {}

  isPlaced(row: number, col: number): boolean {
    return this.cells[row * this.count + col] !== UNPLACED;
  }

  place(row: number, col: number, dark: boolean): void {
    this.cells[row * this.count + col] = dark ? DARK : LIGHT;
  }

  copy(): Grid {
    return new Grid(this.count, this.cells.slice());
  }
}

type Mode = "number" | "alphanumeric" | "byte";

/** `QRMODE`'s indicators. */
const MODE_INDICATORS: Record<Mode, number> = { number: 1, alphanumeric: 2, byte: 4 };

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** `QRERRORCORRECTLEVEL[:h]` */
const LEVEL_H = 2;

/** `QRMAXBITS[:h]` */
const MAX_BITS_H = [
  72, 128, 208, 288, 368, 480, 528, 688, 800, 976, 1120, 1264, 1440, 1576, 1784, 2024, 2264, 2504, 2728, 3080, 3248, 3536, 3712, 4112,
  4304, 4768, 5024, 5288, 5608, 5960, 6344, 6760, 7208, 7688, 7888, 8432, 8768, 9136, 9776, 10208,
];

/** The H rows of `QRRSBlock::RS_BLOCK_TABLE`: (count, total, data) groups. */
const RS_BLOCKS_H = [
  [1, 26, 9], [1, 44, 16], [2, 35, 13], [4, 25, 9], [2, 33, 11, 2, 34, 12], [4, 43, 15], [4, 39, 13, 1, 40, 14],
  [4, 40, 14, 2, 41, 15], [4, 36, 12, 4, 37, 13], [6, 43, 15, 2, 44, 16], [3, 36, 12, 8, 37, 13], [7, 42, 14, 4, 43, 15],
  [12, 33, 11, 4, 34, 12], [11, 36, 12, 5, 37, 13], [11, 36, 12, 7, 37, 13], [3, 45, 15, 13, 46, 16], [2, 42, 14, 17, 43, 15],
  [2, 42, 14, 19, 43, 15], [9, 39, 13, 16, 40, 14], [15, 43, 15, 10, 44, 16], [19, 46, 16, 6, 47, 17], [34, 37, 13],
  [16, 45, 15, 14, 46, 16], [30, 46, 16, 2, 47, 17], [22, 45, 15, 13, 46, 16], [33, 46, 16, 4, 47, 17], [12, 45, 15, 28, 46, 16],
  [11, 45, 15, 31, 46, 16], [19, 45, 15, 26, 46, 16], [23, 45, 15, 25, 46, 16], [23, 45, 15, 28, 46, 16], [19, 45, 15, 35, 46, 16],
  [11, 45, 15, 46, 46, 16], [59, 46, 16, 1, 47, 17], [22, 45, 15, 41, 46, 16], [2, 45, 15, 64, 46, 16], [24, 45, 15, 46, 46, 16],
  [42, 45, 15, 32, 46, 16], [10, 45, 15, 67, 46, 16], [20, 45, 15, 61, 46, 16],
];

/** `QRUtil::PATTERN_POSITION_TABLE` */
const PATTERN_POSITIONS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58],
  [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

/** `QRSegment`: the whole input in one mode. */
interface Segment {
  data: Uint8Array;
  mode: Mode;
}

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const alphanumericIndex = (byte: number) => ALPHANUMERIC.indexOf(String.fromCharCode(byte));

/**
 * `QRSegment.new(data:)` without a mode: numeric, then alphanumeric, then 8-bit byte. The gem checks
 * `data.chars`; every character those modes take is ASCII, so checking bytes is the same.
 */
function segmentOf(data: Uint8Array): Segment {
  if (data.every(isDigit)) return { data, mode: "number" };
  if (data.every((byte) => alphanumericIndex(byte) !== -1)) return { data, mode: "alphanumeric" };
  return { data, mode: "byte" };
}

/** `QRSegment#size(version)`: the bits needed, mode indicator and length included. */
const segmentSize = (segment: Segment, version: number) => 4 + lengthInBits(segment.mode, version) + contentSize(segment);

function contentSize({ data, mode }: Segment): number {
  const length = data.length;
  const [chunk, bits, extra]: [number, number, number] =
    mode === "number" ? [3, 10, [0, 4, 7][length % 3]!] : mode === "alphanumeric" ? [2, 11, 6] : [1, 8, 0];
  return Math.floor(length / chunk) * bits + (length % chunk === 0 ? 0 : extra);
}

function writeSegment({ data, mode }: Segment, buffer: BitBuffer): void {
  buffer.put(MODE_INDICATORS[mode], 4);
  buffer.put(data.length, lengthInBits(mode, buffer.version));
  if (mode === "number") {
    for (let i = 0; i < data.length; i += 3) {
      const chunk = data.subarray(i, i + 3);
      const code = chunk.reduce((value, byte) => value * 10 + (byte - 0x30), 0);
      buffer.put(code, [0, 4, 7, 10][chunk.length]!);
    }
  } else if (mode === "alphanumeric") {
    for (let i = 0; i < data.length; i += 2) {
      const first = alphanumericIndex(data[i]!);
      if (i + 1 < data.length) buffer.put(first * 45 + alphanumericIndex(data[i + 1]!), 11);
      else buffer.put(first, 6);
    }
  } else {
    for (const byte of data) buffer.put(byte, 8);
  }
}

/** The bits a segment's length takes in versions 1-9, 10-26 and 27-40. */
const LENGTH_BITS: Record<Mode, number[]> = { number: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] };

/** `QRUtil.get_length_in_bits` */
const lengthInBits = (mode: Mode, version: number) => LENGTH_BITS[mode][version <= 9 ? 0 : version <= 26 ? 1 : 2]!;

/** `QRBitBuffer` */
class BitBuffer {
  readonly bytes: number[] = [];
  length = 0;

  constructor(readonly version: number) {}

  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }

  putBit(bit: boolean): void {
    const index = Math.floor(this.length / 8);
    if (this.bytes.length <= index) this.bytes.push(0);
    if (bit) this.bytes[index]! |= 0x80 >>> (this.length % 8);
    this.length += 1;
  }

  endOfMessage(maxDataBits: number): void {
    if (this.length + 4 <= maxDataBits) this.put(0, 4);
  }

  padUntil(preferredSize: number): void {
    while (this.length % 8 !== 0) this.putBit(false);
    while (this.length < preferredSize) {
      this.put(0xec, 8);
      if (this.length < preferredSize) this.put(0x11, 8);
    }
  }
}

/** `QRMath`'s GF(256) tables. */
const EXP = new Array<number>(256).fill(0);
const LOG = new Array<number>(256).fill(0);
for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4]! ^ EXP[i - 5]! ^ EXP[i - 6]! ^ EXP[i - 8]!;
for (let i = 0; i < 255; i++) LOG[EXP[i]!] = i;

function glog(n: number): number {
  if (n < 1) throw new RangeError(`glog(${n})`);
  return LOG[n]!;
}

function gexp(n: number): number {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP[n]!;
}

/**
 * `QRPolynomial`: its coefficients, highest power first, without leading zeros, then `shift` more.
 * The gem pads with `nil`s where this pads with zeros; they only differ in inputs where the gem raises.
 */
function polynomial(num: number[], shift: number): number[] {
  let offset = 0;
  while (offset < num.length && num[offset] === 0) offset++;
  return [...num.slice(offset), ...new Array<number>(shift).fill(0)];
}

function multiply(a: number[], b: number[]): number[] {
  const num = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) num[i + j]! ^= gexp(glog(a[i]!) + glog(b[j]!));
  }
  return polynomial(num, 0);
}

function modulo(dividend: number[], divisor: number[]): number[] {
  let current = dividend;
  while (current.length >= divisor.length) {
    const ratio = glog(current[0]!) - glog(divisor[0]!);
    const num = current.slice();
    for (let i = 0; i < divisor.length; i++) num[i]! ^= gexp(glog(divisor[i]!) + ratio);
    current = polynomial(num, 0);
  }
  return current;
}

/** The polynomials `errorCorrectPolynomial` has made, by length: every block of a version needs the same one. */
const generators = new Map<number, number[]>();

/** `QRUtil.get_error_correct_polynomial` */
function errorCorrectPolynomial(length: number): number[] {
  let a = generators.get(length);
  if (!a) {
    a = polynomial([1], 0);
    for (let i = 0; i < length; i++) a = multiply(a, polynomial([1, gexp(i)], 0));
    generators.set(length, a);
  }
  return a;
}

/** `QRCode.create_data`: the data and error correction codewords, interleaved. */
function createData(version: number, segment: Segment): number[] {
  const groups = RS_BLOCKS_H[version - 1]!;
  const blocks: Array<{ total: number; data: number }> = [];
  for (let i = 0; i < groups.length; i += 3) {
    for (let n = 0; n < groups[i]!; n++) blocks.push({ total: groups[i + 1]!, data: groups[i + 2]! });
  }
  const maxDataBits = blocks.reduce((sum, block) => sum + block.data, 0) * 8;

  const buffer = new BitBuffer(version);
  writeSegment(segment, buffer);
  buffer.endOfMessage(maxDataBits);
  if (buffer.length > maxDataBits) throw new RangeError("code length overflow");
  buffer.padUntil(maxDataBits);

  let offset = 0;
  const dcData: number[][] = [];
  const ecData: number[][] = [];
  for (const block of blocks) {
    const dc = buffer.bytes.slice(offset, offset + block.data);
    offset += block.data;
    const rsPoly = errorCorrectPolynomial(block.total - block.data);
    const ecLength = rsPoly.length - 1;
    const modPoly = modulo(polynomial(dc, ecLength), rsPoly);
    const ec = Array.from({ length: ecLength }, (_, i) => {
      const index = i + modPoly.length - ecLength;
      return index >= 0 ? modPoly[index]! : 0;
    });
    dcData.push(dc);
    ecData.push(ec);
  }

  const data: number[] = [];
  for (const codewords of [dcData, ecData]) {
    const longest = Math.max(0, ...codewords.map((block) => block.length));
    for (let i = 0; i < longest; i++) {
      for (const block of codewords) if (i < block.length) data.push(block[i]!);
    }
  }
  return data;
}

/** `QRUtil.get_bch_digit` */
function bchDigit(data: number): number {
  let digit = 0;
  while (data !== 0) {
    digit += 1;
    data >>>= 1;
  }
  return digit;
}

function bchFormatInfo(data: number): number {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function bchVersion(data: number): number {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

/** `QRMASKCOMPUTATIONS` */
function mask(pattern: number, i: number, j: number): boolean {
  switch (pattern) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

/** `minimum_version`: the first version whose capacity is strictly greater than the bits needed. */
function minimumVersion(segment: Segment): number | null {
  for (let version = 1; version <= 40; version++) {
    if (segmentSize(segment, version) < MAX_BITS_H[version - 1]!) return version;
  }
  return null;
}

function placePositionProbePattern(grid: Grid, row: number, col: number): void {
  const { count } = grid;
  for (let r = -1; r <= 7; r++) {
    const y = row + r;
    if (y < 0 || y >= count) continue;
    for (let c = -1; c <= 7; c++) {
      const x = col + c;
      if (x < 0 || x >= count) continue;
      const vertical = r >= 0 && r <= 6 && (c === 0 || c === 6);
      const horizontal = c >= 0 && c <= 6 && (r === 0 || r === 6);
      const square = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid.place(y, x, vertical || horizontal || square);
    }
  }
}

function placePositionAdjustPattern(grid: Grid, version: number): void {
  const positions = PATTERN_POSITIONS[version - 1]!;
  for (const row of positions) {
    for (const col of positions) {
      if (grid.isPlaced(row, col)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) grid.place(row + r, col + c, Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0));
      }
    }
  }
}

function placeTimingPattern(grid: Grid): void {
  for (let i = 8; i < grid.count - 8; i++) grid.place(i, 6, i % 2 === 0);
  for (let i = 8; i < grid.count - 8; i++) grid.place(6, i, i % 2 === 0);
}

function placeVersionInfo(grid: Grid, version: number, test: boolean): void {
  const { count } = grid;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const dark = !test && ((bits >> i) & 1) === 1;
    grid.place(Math.floor(i / 3), (i % 3) + count - 8 - 3, dark);
    grid.place((i % 3) + count - 8 - 3, Math.floor(i / 3), dark);
  }
}

function placeFormatInfo(grid: Grid, test: boolean, pattern: number): void {
  const { count } = grid;
  const bits = bchFormatInfo((LEVEL_H << 3) | pattern);
  for (let i = 0; i < 15; i++) {
    const dark = !test && ((bits >> i) & 1) === 1;
    grid.place(i < 6 ? i : i < 8 ? i + 1 : count - 15 + i, 8, dark);
    grid.place(8, i < 8 ? count - i - 1 : i < 9 ? 15 - i : 15 - i - 1, dark);
  }
  grid.place(count - 8, 8, !test);
}

/**
 * `map_data` without its mask: places the codewords' bits in the modules nothing else took, in the
 * gem's zigzag, and answers which those were.
 */
function mapData(grid: Grid, data: number[]): number[] {
  const { count } = grid;
  const placed: number[] = [];
  let inc = -1;
  let row = count - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = count - 1; col >= 1; col -= 2) {
    const c0 = col <= 6 ? col - 1 : col;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const x = c0 - c;
        if (grid.isPlaced(row, x)) continue;
        grid.place(row, x, byteIndex < data.length && ((data[byteIndex]! >> bitIndex) & 1) === 1);
        placed.push(row * count + x);
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || count <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return placed;
}

/** A copy of `grid` with `pattern`'s mask over its data modules, which `map_data` flips where the mask is true. */
function masked(grid: Grid, dataModules: number[], pattern: number): Grid {
  const { count } = grid;
  const copy = grid.copy();
  for (const index of dataModules) {
    const row = Math.floor(index / count);
    if (mask(pattern, row, index - row * count)) copy.cells[index]! ^= 1;
  }
  return copy;
}

/** A finder pattern's 1:1:3:1:1 as seven modules, the oldest highest: dark, light, dark, dark, dark, light, dark. */
const FINDER_LIKE = 0b1011101;

/**
 * `QRUtil.get_lost_points`, the gem's four penalties counted in fewer steps than it takes them, since
 * every mask is scored. The dark-ratio term is a Float in Ruby, so the total is too.
 */
function lostPoints({ count, cells }: Grid): number {
  const max = count - 1;
  // The dark modules in each run of three across a row, centred on each module.
  const runs = new Int8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const col = i % count;
    runs[i] = cells[i]! + (col > 0 ? cells[i - 1]! : 0) + (col < max ? cells[i + 1]! : 0);
  }

  let points = 0;
  let dark = 0;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const i = row * count + col;
      const cell = cells[i]!;
      dark += cell;

      // Same-color neighbours: more than five of the eight costs 3, and 1 more for each beyond.
      const darkAround = runs[i]! - cell + (row > 0 ? runs[i - count]! : 0) + (row < max ? runs[i + count]! : 0);
      const around = (row === 0 || row === max ? 2 : 3) * (col === 0 || col === max ? 2 : 3) - 1;
      const same = cell === DARK ? darkAround : around - darkAround;
      if (same > 5) points += 3 + same - 5;

      // 2x2 blocks of one color.
      if (row < max && col < max) {
        const block = cell + cells[i + 1]! + cells[i + count]! + cells[i + count + 1]!;
        if (block === 0 || block === 4) points += 3;
      }
    }
  }

  // 1:1:3:1:1 patterns, along each row and down each column.
  for (let line = 0; line < count; line++) {
    let across = 0;
    let down = 0;
    for (let k = 0; k < count; k++) {
      across = ((across << 1) | cells[line * count + k]!) & 0x7f;
      down = ((down << 1) | cells[k * count + line]!) & 0x7f;
      if (k >= 6 && across === FINDER_LIKE) points += 40;
      if (k >= 6 && down === FINDER_LIKE) points += 40;
    }
  }

  // Dark ratio.
  const ratio = dark / (count * count);
  const delta = Math.abs(100 * ratio - 50) / 5;
  return points + delta * 10;
}
