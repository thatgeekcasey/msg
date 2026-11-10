// The width and height Active Storage records for an image, read without libvips from the headers of
// JPEG, PNG, GIF, WebP, TIFF and HEIF files, AVIF and HEIC among them, as libvips 8.16's loaders for
// them read them.

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * The EXIF orientations `ImageAnalyzer::Vips::ROTATIONS` matches by libexif's names for them: "Top-right",
 * "Bottom-left", "Right-top" and "Left-bottom". Rails swaps those images' width and height, though 2 and 4
 * only mirror them, while 5 and 7, which turn them, aren't there.
 */
const SWAPPED = new Set([2, 4, 6, 8]);

/**
 * What Rails records for an image of type `contentType` whose file starts with `bytes`: its size, swapped as
 * its EXIF orientation says, or null where libvips can't read it. As with libvips, the bytes decide how it's
 * read, whichever image type it was identified as.
 */
export function imageSize(bytes: Uint8Array, contentType: string): ImageSize | null {
  if (!contentType.startsWith("image")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const read of FORMATS) {
    const header = attempt(() => read(view, bytes));
    if (!header) continue;
    const { width, height, orientation } = header;
    if (!(width > 0 && height > 0)) return null;
    return orientation !== null && SWAPPED.has(orientation) ? { width: height, height: width } : { width, height };
  }
  return null;
}

interface Header extends ImageSize {
  /** The EXIF orientation, where libvips finds one. */
  orientation: number | null;
}

/** `read()`, or null where it reads past the end, which `DataView`'s getters throw at. */
function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** libjpeg-turbo 2.1's frames: baseline, extended and progressive, Huffman or arithmetic coded. It refuses the others. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc9, 0xca]);

/** SOF0 to SOF15, which include JPG (C8), but not DHT (C4) or DAC (CC). */
const isFrameMarker = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc;

/** The segments libjpeg reads past on the way to a frame's scan: DHT, DAC, DQT, DNL, DRI, APP0 to APP15 and COM. */
const isSkippedSegment = (marker: number) =>
  marker === 0xc4 || marker === 0xcc || (marker >= 0xdb && marker <= 0xdd) || (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;

/**
 * A JPEG's markers, as libjpeg reads them up to the scan: the size from its one frame, and the orientation
 * from its last EXIF segment, the one libvips keeps. Any marker libjpeg refuses there, or an end before a
 * scan, makes it unreadable.
 */
function jpeg(view: DataView, bytes: Uint8Array): Header | null {
  if (view.getUint16(0) !== 0xffd8) return null;
  let size: ImageSize | null = null;
  let orientation: number | null = null;
  let at = 2;
  while (at + 1 < bytes.length) {
    // libjpeg skips anything but a marker, and the fill bytes before one.
    if (bytes[at] !== 0xff || bytes[at + 1] === 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    at += 2;
    // A stuffed zero, a restart marker or TEM, none of which has a segment.
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xda) return size && { ...size, orientation };
    if (isFrameMarker(marker)) {
      if (size || !JPEG_FRAMES.has(marker)) return null;
      size = { height: view.getUint16(at + 3), width: view.getUint16(at + 5) };
    } else if (!isSkippedSegment(marker)) return null;
    const length = view.getUint16(at);
    if (length < 2) return null;
    if (marker === 0xe1 && ascii(bytes, at + 2, 6) === "Exif\0\0") orientation = exifOrientation(bytes.subarray(at + 8, at + length));
    at += length;
  }
  return null;
}

/** The largest width or height libspng takes. */
const MAX_PNG_SIDE = 2 ** 31 - 1;

/** A PNG's IHDR, which comes first, and an eXIf chunk before its image data, which libspng hands libvips. */
function png(view: DataView, bytes: Uint8Array): Header | null {
  if (ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n" || ascii(bytes, 12, 4) !== "IHDR") return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) return null;
  let orientation: number | null = null;
  for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
    const type = ascii(bytes, at + 4, 4);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "eXIf") orientation = exifOrientation(bytes.subarray(at + 8, at + 8 + view.getUint32(at)));
  }
  return { width, height, orientation };
}

/**
 * libnsgif's screen sizes that broken GIFs give, any 0, or more than 2,048 a side: for these it takes the
 * first frame's size instead.
 */
function isBrokenScreen(width: number, height: number): boolean {
  const size = `${width}x${height}`;
  return ["640x480", "640x512", "800x600", "1024x768", "1280x1024", "1600x1200"].includes(size) || width === 0 || height === 0 || width > 2048 || height > 2048;
}

/**
 * A GIF's size as libnsgif reckons it: its logical screen, grown to fit its first frame, or only that frame
 * where the screen is one broken GIFs give. A GIF with no frame is unreadable.
 */
function gif(view: DataView, bytes: Uint8Array): Header | null {
  const signature = ascii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  let width = view.getUint16(6, true);
  let height = view.getUint16(8, true);
  if (isBrokenScreen(width, height)) [width, height] = [1, 1];
  // Past the global color table, if it has one.
  const flags = view.getUint8(10);
  let at = 13 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  // Past each extension: its introducer and label, then blocks of the length each starts with, up to an empty one.
  while (bytes[at] === 0x21) {
    at += 2;
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
    at++;
  }
  if (bytes[at] !== 0x2c) return null;
  const right = view.getUint16(at + 1, true) + view.getUint16(at + 5, true);
  const bottom = view.getUint16(at + 3, true) + view.getUint16(at + 7, true);
  return { width: Math.max(width, right), height: Math.max(height, bottom), orientation: null };
}

/** VP8X's flag for an EXIF chunk, without which libvips doesn't look for one. */
const WEBP_EXIF_FLAG = 0x08;

/** A WebP's canvas, from its first chunk, and with the extended format, its first EXIF chunk. */
function webp(view: DataView, bytes: Uint8Array): Header | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  switch (ascii(bytes, 12, 4)) {
    case "VP8 ":
      // A lossy key frame: its tag, its start code, then 14 bits each of width and height.
      if (view.getUint16(23) !== 0x9d01 || bytes[25] !== 0x2a) return null;
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, orientation: null };
    case "VP8L": {
      // A lossless image: its signature, then 14 bits each of width and height, less one.
      if (bytes[20] !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, orientation: null };
    }
    case "VP8X": {
      const width = (view.getUint32(24, true) & 0xffffff) + 1;
      const height = (view.getUint32(26, true) >>> 8) + 1;
      let orientation: number | null = null;
      if (view.getUint8(20) & WEBP_EXIF_FLAG) {
        for (let at = 12; at + 8 <= bytes.length; at += 8 + view.getUint32(at + 4, true) + (view.getUint32(at + 4, true) % 2)) {
          if (ascii(bytes, at, 4) !== "EXIF") continue;
          const exif = bytes.subarray(at + 8, at + 8 + view.getUint32(at + 4, true));
          // libvips takes it with JPEG's "Exif" prefix or without.
          orientation = exifOrientation(ascii(exif, 0, 6) === "Exif\0\0" ? exif.subarray(6) : exif);
          break;
        }
      }
      return { width, height, orientation };
    }
    default:
      return null;
  }
}

/** A TIFF's first image's size. libvips gives Rails no EXIF orientation for a TIFF, so it's never swapped. */
function tiff(view: DataView, bytes: Uint8Array): Header | null {
  const ifd = firstIfd(view, bytes);
  if (!ifd) return null;
  const width = ifd.number(0x0100);
  const height = ifd.number(0x0101);
  return width === null || height === null ? null : { width, height, orientation: null };
}

/** The major brands libvips 8.16 opens a HEIF of (heifload.c's `heif_magic`). */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif"]);

/** The brands libheif 1.19, which libvips reads HEIFs with, opens a file that's compatible with one of. */
const LIBHEIF_BRANDS = ["heic", "heix", "mif1", "avif", "1pic", "jpeg"];

/** The item types libheif lists as images, besides a `mime` item that's a JPEG. */
const HEIF_IMAGES = new Set(["jpeg", "hvc1", "av01", "vvc1", "avc1", "unci", "j2k1", "mski", "grid", "iovl", "iden", "tili", "lhv1"]);

/** The images libheif lists without reading any of their properties, as it can't read them: libvips shows none. */
const UNREAD_IMAGES = new Set(["lhv1"]);

/** The images libheif derives from others (`dimg`), which take their bit depth from the first. */
const DERIVED_IMAGES = new Set(["grid", "iden", "iovl"]);

/**
 * The configuration libheif needs among an image's properties, by the image's type. It reads a tiled image's
 * (`tilC`) only with its experimental features, so it reads no file with a tiled image.
 */
const HEIF_CONFIGURATIONS = new Map([["hvc1", "hvcC"], ["av01", "av1C"], ["vvc1", "vvcC"], ["avc1", "avcC"], ["j2k1", "j2kH"], ["unci", "uncC"], ["tili", "tilC"]]);

/**
 * The boxes libheif reads, as its release preset builds it: with its uncompressed codec's (`cmpd`, `uncC`,
 * `cmpC`, `icef` and `cpat`), but without its experimental features'. It can't read an image with an
 * essential property of any other type.
 */
const LIBHEIF_BOXES = new Set([
  "ftyp", "free", "skip", "meta", "hdlr", "pitm", "iloc", "iinf", "infe", "iprp", "ipco", "ipma", "ispe", "auxC", "irot", "imir", "clap",
  "iref", "hvcC", "av1C", "vvcC", "idat", "grpl", "pymd", "altr", "ster", "dinf", "dref", "url ", "colr", "pixi", "pasp", "lsel", "a1op",
  "a1lx", "clli", "mdcv", "amve", "cmin", "cmex", "udes", "jpgC", "cmpd", "uncC", "cmpC", "icef", "cpat", "j2kH", "cdef", "cmap", "pclr",
  "j2kL", "mskC", "avcC", "mdat",
]);

/** The UUID of a `uuid` box of camera intrinsics, as a draft wrote them, which libheif reads as it does a `cmin` box. */
const INTRINSICS_UUID = "22cc04c7d6d94e079d904eb6ecbaf3a3";

/** The `uuid` boxes libheif reads, by their UUIDs: camera intrinsics and extrinsics, as a draft wrote them. */
const LIBHEIF_UUIDS = new Set([INTRINSICS_UUID, "4363e9145b7d4aab97aebea69803b434"]);

/** The most pixels libvips lets libheif open an image of: 16,384 squared, as heifsave writes at most. */
const MAX_HEIF_PIXELS = 0x4000 ** 2;

/** The largest `int`, which libheif takes for a side or a fraction's term. */
const MAX_INT = 2 ** 31 - 1;

/**
 * The most boxes libheif 1.19's security limits let it read in a `meta`, `iprp` or `ipco` box: before it adds
 * each, it checks the box holds no more than 100 already (`Box::read_children`), so it refuses the 102nd.
 */
const MAX_HEIF_CHILDREN = 101;

/**
 * The most entries libheif 1.19's security limits let it read in an `ipma` box, and items an `iref` reference
 * can be to (`max_items`). This reader takes no more items in the `iinf` box, nor references in the `iref` box,
 * where libheif has no limit, so that it reads any file in little time and memory: a file of more has no size.
 */
const MAX_HEIF_ITEMS = 1000;

/**
 * A HEIF's size as libvips reads it with libheif: its primary image's, from its properties, where that's one
 * of its top-level images, and otherwise the first of them, in the order of their ids. Those are the images
 * that aren't hidden, nor another image's thumbnail (`thmb`) or auxiliary image (`auxl`), such as its alpha
 * channel, nor a region's mask (`mask`). A file libheif refuses, without the boxes it needs or with any image
 * it can't read, is unreadable: one without its codec's configuration, with an essential property libheif
 * doesn't know, too large, past its security limits, or with references between its items that it refuses.
 */
function heif(view: DataView, bytes: Uint8Array): Header | null {
  // libvips takes an `ftyp` box of whole words, of up to 2,048 bytes, with one of its major brands, and
  // libheif one that's compatible with one of its own.
  const ftypSize = view.getUint32(0);
  if (ascii(bytes, 4, 4) !== "ftyp" || !HEIF_BRANDS.has(ascii(bytes, 8, 4)) || ftypSize % 4 || ftypSize < 16 || ftypSize > 2048) return null;
  const compatible = Array.from({ length: (ftypSize - 16) / 4 }, (_, n) => ascii(bytes, 16 + 4 * n, 4));
  if (!LIBHEIF_BRANDS.some((brand) => compatible.includes(brand))) return null;

  const meta = metaAfter(view, bytes, ftypSize);
  if (!meta || meta.view.getUint8(0) !== 0) return null;
  const children = childrenIn(meta.bytes, 4);
  const [hdlr, pitm, iloc, iinf, iprp, iref] = ["hdlr", "pitm", "iloc", "iinf", "iprp", "iref"].map((type) => children.find((box) => box.type === type));
  if (hdlr && (hdlr.view.getUint8(0) !== 0 || hdlr.bytes.length < 24 || ascii(hdlr.bytes, 8, 4) !== "pict")) return null;
  if (!pitm || !iloc || !iinf || !iprp || pitm.view.getUint8(0) > 1) return null;
  const primary = pitm.view.getUint8(0) === 0 ? pitm.view.getUint16(4) : pitm.view.getUint32(4);
  const items = itemsOf(iinf);
  const images = new Set([...items.keys()].filter((id) => isHeifImage(items.get(id)!)).sort((a, b) => a - b));
  if (!images.has(primary) || items.get(primary)!.hidden) return null;

  const iprpChildren = childrenIn(iprp.bytes);
  const ipco = iprpChildren.find((box) => box.type === "ipco");
  if (!ipco) return null;
  const properties = childrenIn(ipco.bytes);
  const associations = associationsOf(iprpChildren.filter((box) => box.type === "ipma"), images);
  const sizes = new Map<number, Header>();
  const auxiliary = new Set<number>();
  for (const id of images) {
    const associated = associations.get(id);
    if (!associated || associated.some(({ place }) => place > properties.length)) return null;
    const own = associated.filter(({ place }) => place > 0).map(({ place, essential }) => ({ property: properties[place - 1]!, essential }));
    if (own.some(({ property }) => property.type === "auxC")) auxiliary.add(id);
    const { type } = items.get(id)!;
    if (UNREAD_IMAGES.has(type)) continue;
    if (!isReadable(type, own)) return null;
    const size = sizeOf(own.map(({ property }) => property));
    if (!size) return null;
    sizes.set(id, size);
  }

  const references = iref ? referencesOf(iref) : [];
  const derived = new Map<number, number[]>();
  for (const { type, from, to } of references) if (type === "dimg" && !derived.has(from)) derived.set(from, to);
  if (isDerivedFromItself(primary, derived) || !areReferencesSound(references, items, images, auxiliary, derived, iref !== undefined)) return null;
  const beneath = new Set<number>();
  for (const { type, from, to } of references) {
    if (type === "thmb" || (type === "auxl" && to.some((other) => images.has(other)))) beneath.add(from);
    if (type === "mask" && items.get(from)?.type === "rgan") to.forEach((mask) => beneath.add(mask));
  }
  const topLevel = [...images].filter((id) => !items.get(id)!.hidden && !beneath.has(id));
  const shown = topLevel.includes(primary) ? primary : topLevel[0];
  if (shown === undefined) return null;
  // libvips needs the bit depth of the image it shows, which a derived image takes from another.
  const source = sourceOf(shown, items, derived);
  return source !== null && sizes.has(source) ? sizes.get(shown)! : null;
}

/** An ISO base media file's box: its type and its contents, whose view throws at reading past their end. */
interface Box {
  type: string;
  bytes: Uint8Array;
  view: DataView;
}

/**
 * The box at `at` in `bytes`, whose size, where it's 1, follows its type in 64 bits, and where it's 0, runs
 * to the end. libheif refuses one that's smaller than its header or runs past the end.
 */
function boxAt(view: DataView, bytes: Uint8Array, at: number): Box | null {
  const size = view.getUint32(at);
  const [start, end] = size === 1 ? [at + 16, at + Number(view.getBigUint64(at + 8))] : [at + 8, size === 0 ? bytes.length : at + size];
  if (end < start || end > bytes.length) return null;
  const contents = bytes.subarray(start, end);
  return { type: ascii(bytes, at + 4, 4), bytes: contents, view: new DataView(contents.buffer, contents.byteOffset, contents.byteLength) };
}

/** The boxes in `bytes` from `at`, each in turn. */
function* boxesIn(bytes: Uint8Array, at = 0): Generator<Box> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at < bytes.length) {
    const box = boxAt(view, bytes, at);
    if (!box) throw new RangeError("A box runs past its parent");
    yield box;
    at = box.bytes.byteOffset - bytes.byteOffset + box.bytes.length;
  }
}

/** The boxes a box holds in `bytes` from `at`, of which libheif reads no more than `MAX_HEIF_CHILDREN`. */
function childrenIn(bytes: Uint8Array, at = 0): Box[] {
  const children = [];
  for (const box of boxesIn(bytes, at)) {
    if (children.length === MAX_HEIF_CHILDREN) throw new RangeError("Too many boxes in a box");
    children.push(box);
  }
  return children;
}

/**
 * The `meta` box libheif finds by skipping from box to box after the `ftyp` box at the start, which it
 * does while one starts at least 32 bytes before the end.
 */
function metaAfter(view: DataView, bytes: Uint8Array, at: number): Box | null {
  while (at + 32 <= bytes.length) {
    if (view.getUint32(at) === 0) return null;
    // Past the end, and smaller than its header, only a `meta` box is refused, but no other box could be read after it.
    const box = boxAt(view, bytes, at);
    if (!box) return null;
    if (box.type === "meta") return box;
    at = box.bytes.byteOffset - bytes.byteOffset + box.bytes.length;
  }
  return null;
}

/** An item of a HEIF's: its type, whether it's hidden, and a `mime` item's content type. */
interface Item {
  type: string;
  hidden: boolean;
  contentType?: string;
}

/** The items an `iinf` box lists, as many as it says it has, up to `MAX_HEIF_ITEMS`, by their ids, the first for each id. */
function itemsOf({ bytes, view }: Box): Map<number, Item> {
  const items = new Map<number, Item>();
  const wide = view.getUint8(0) !== 0;
  const count = wide ? view.getUint32(4) : view.getUint16(4);
  const listed = boxesIn(bytes, wide ? 8 : 6);
  for (let n = 0; n < count; n++) {
    const next = listed.next();
    if (next.done) break;
    if (n === MAX_HEIF_ITEMS) throw new RangeError("Too many items");
    if (next.value.type !== "infe") continue;
    const infe = next.value;
    const version = infe.view.getUint8(0);
    if (version > 3) throw new RangeError(`An infe box of version ${version}`);
    const id = version === 3 ? infe.view.getUint32(4) : infe.view.getUint16(4);
    // Before version 2, an item has no type, so it's no image.
    const type = version < 2 ? "" : ascii(infe.bytes, version === 3 ? 10 : 8, 4);
    // Past its name, a `mime` item's content type.
    const afterName = version < 2 ? 0 : cString(infe.bytes, version === 3 ? 14 : 12)[1];
    const contentType = type === "mime" ? cString(infe.bytes, afterName)[0] : undefined;
    if (!items.has(id)) items.set(id, { type, hidden: version >= 2 && (infe.view.getUint32(0) & 1) === 1, contentType });
  }
  return items;
}

/** The NUL-terminated string at `at` and where the next starts, as libheif reads one: empty at the end, refused where it runs past it. */
function cString(bytes: Uint8Array, at: number): [string, number] {
  if (at >= bytes.length) return ["", bytes.length];
  const length = bytes.subarray(at).indexOf(0);
  if (length < 0) throw new RangeError("A string runs past its box");
  return [ascii(bytes, at, length), at + length + 1];
}

/** Whether libheif lists `item` as an image. */
const isHeifImage = ({ type, contentType }: Item) => HEIF_IMAGES.has(type) || (type === "mime" && contentType === "image/jpeg");

/** Whether `item` is Exif or XMP, whose data libheif reads to keep with the items it describes (`cdsc`). */
const isMetadata = (item: Item) => (item.type === "Exif" || item.type === "mime") && !isHeifImage(item);

/** A reference from an item to others, of a type such as a thumbnail's (`thmb`). */
interface Reference {
  type: string;
  from: number;
  to: number[];
}

/**
 * An `iref` box's references, up to `MAX_HEIF_ITEMS`, which libheif reads one after another, past each one's
 * header. It refuses one to no item, to an item twice, or to more items than its security limits allow.
 */
function referencesOf({ bytes, view }: Box): Reference[] {
  const version = view.getUint8(0);
  if (version > 1) throw new RangeError(`An iref box of version ${version}`);
  const [idOf, idSize] = version === 0 ? [(at: number) => view.getUint16(at), 2] : [(at: number) => view.getUint32(at), 4];
  const references = [];
  for (let at = 4; at < bytes.length; ) {
    if (references.length === MAX_HEIF_ITEMS) throw new RangeError("Too many references");
    const type = ascii(bytes, at + 4, 4);
    at += view.getUint32(at) === 1 ? 16 : 8;
    const from = idOf(at);
    const count = view.getUint16(at + idSize);
    if (count === 0) throw new RangeError("A reference to nothing");
    if (count > MAX_HEIF_ITEMS) throw new RangeError(`A reference to ${count} items`);
    at += idSize + 2;
    const to = Array.from({ length: count }, (_, n) => idOf(at + n * idSize));
    if (new Set(to).size < count) throw new RangeError("A reference to an item twice");
    references.push({ type, from, to });
    at += count * idSize;
  }
  return references;
}

/**
 * Whether libheif 1.19 takes the references between `items`, of which it lists `images`, and of those,
 * `auxiliary` say what auxiliary image they are (`auxC`), and `derived` maps each item to the first images
 * it's derived from (`dimg`), with an `iref` box where `hasIref`.
 */
function areReferencesSound(
  references: Reference[],
  items: Map<number, Item>,
  images: Set<number>,
  auxiliary: Set<number>,
  derived: Map<number, number[]>,
  hasIref: boolean,
): boolean {
  // Through the images' references in the order of their ids, a thumbnail (`thmb`) must be of images that
  // aren't thumbnails, as far as it's gone, and an auxiliary image (`auxl`) must say what it is and be of
  // other items.
  const thumbnails = new Set<number>();
  for (const { type, from, to } of references.filter(({ from }) => images.has(from)).sort((a, b) => a.from - b.from)) {
    if (type === "thmb") {
      thumbnails.add(from);
      if (to.some((image) => !images.has(image) || thumbnails.has(image))) return false;
    } else if (type === "auxl" && (!auxiliary.has(from) || to.some((item) => item === from || !items.has(item)))) {
      return false;
    }
  }
  // A grid must be derived from others, and an overlay needs an `iref` box, even to be derived from none.
  for (const id of images) {
    const { type } = items.get(id)!;
    if ((type === "grid" && !derived.has(id)) || (type === "iovl" && !hasIref)) return false;
  }
  // Only an image can have premultiplied alpha (`prem`). The items Exif or XMP first describes must be
  // there, the ones a region (`rgan`) describes must be images, and its masks (`mask`) images libheif
  // reads. libheif checks only the masks the region's data has regions for, as a file must for each.
  const describing = new Set<number>();
  for (const { type, from, to } of references) {
    const item = items.get(from);
    if (!item) continue;
    if (type === "prem" && !images.has(from)) return false;
    if (type === "mask" && item.type === "rgan" && !to.every((mask) => images.has(mask) && !UNREAD_IMAGES.has(items.get(mask)!.type))) return false;
    if (type !== "cdsc") continue;
    if (item.type === "rgan" && !to.every((id) => images.has(id))) return false;
    if (isMetadata(item) && !describing.has(from) && !to.every((id) => items.has(id))) return false;
    describing.add(from);
  }
  return true;
}

/**
 * Whether `primary`, followed through the images each is derived from, comes back round to one on the way,
 * which libheif checks along every way from it. This goes along each step once, though a way can share it.
 */
function isDerivedFromItself(primary: number, derived: Map<number, number[]>): boolean {
  const done = new Set<number>();
  const way = [{ id: primary, next: 0 }];
  const onWay = new Set([primary]);
  while (way.length > 0) {
    const step = way.at(-1)!;
    const source = derived.get(step.id)?.[step.next++];
    if (source === undefined) {
      way.pop();
      onWay.delete(step.id);
      done.add(step.id);
    } else if (onWay.has(source)) {
      return true;
    } else if (!done.has(source)) {
      way.push({ id: source, next: 0 });
      onWay.add(source);
    }
  }
  return false;
}

/**
 * The image `id` takes its bit depth from: itself, or for a derived image, the first it's derived from, and
 * where that's derived too, the first that is, and so on. libheif finds none past a derived image that isn't
 * derived from another.
 */
function sourceOf(id: number, items: Map<number, Item>, derived: Map<number, number[]>): number | null {
  const passed = new Set<number>();
  while (DERIVED_IMAGES.has(items.get(id)?.type ?? "")) {
    passed.add(id);
    const next = derived.get(id)?.[0];
    if (next === undefined || passed.has(next)) return null;
    id = next;
  }
  return id;
}

/** An item's association with a property: the property's place in `ipco`, counting from 1, and whether it's essential to the item. */
interface Association {
  place: number;
  essential: boolean;
}

/**
 * The associations with properties of each of `images`, from its first entry in the `ipma` boxes, of which
 * libheif refuses one of more than `MAX_HEIF_ITEMS` entries.
 */
function associationsOf(ipmas: Box[], images: Set<number>): Map<number, Association[]> {
  const associations = new Map<number, Association[]>();
  for (const { view } of ipmas) {
    const version = view.getUint8(0);
    if (version > 1) throw new RangeError(`An ipma box of version ${version}`);
    // Its flags say whether each place takes 15 bits or 7, after a bit saying whether it's essential.
    const [placeSize, essentialBit] = (view.getUint32(0) & 1) === 1 ? [2, 0x8000] : [1, 0x80];
    const count = view.getUint32(4);
    if (count > MAX_HEIF_ITEMS) throw new RangeError(`An ipma box of ${count} entries`);
    for (let at = 8, entry = 0; entry < count && at < view.byteLength; entry++) {
      const id = version === 0 ? view.getUint16(at) : view.getUint32(at);
      at += version === 0 ? 2 : 4;
      const end = at + 1 + view.getUint8(at) * placeSize;
      if (end > view.byteLength) throw new RangeError("An entry runs past its ipma box");
      if (images.has(id) && !associations.has(id)) {
        const associated: Association[] = [];
        for (at++; at < end; at += placeSize) {
          const bits = placeSize === 2 ? view.getUint16(at) : view.getUint8(at);
          associated.push({ place: bits & (essentialBit - 1), essential: (bits & essentialBit) !== 0 });
        }
        associations.set(id, associated);
      }
      at = end;
    }
  }
  return associations;
}

/**
 * Whether libheif reads an image of `type` with `properties`: they need its codec's configuration, and
 * each one that's essential to it must be a box libheif reads.
 */
function isReadable(type: string, properties: Array<{ property: Box; essential: boolean }>): boolean {
  const configuration = HEIF_CONFIGURATIONS.get(type);
  if (configuration && !properties.some(({ property }) => property.type === configuration && isRead(property))) return false;
  return properties.every(({ property, essential }) => !essential || isRead(property));
}

/** Whether libheif reads `box`, rather than keeping it as one it doesn't know. */
function isRead({ type, bytes }: Box): boolean {
  return type === "uuid" ? LIBHEIF_UUIDS.has(uuidOf(bytes)) : LIBHEIF_BOXES.has(type);
}

/** A `uuid` box's UUID, in hex, from the start of its contents. */
const uuidOf = (bytes: Uint8Array) => Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Whether `box` is camera intrinsics libheif reads: a `cmin` box, or a `uuid` box of them, of version 0, with a
 * focal length and principal point, and where its flags say so, a second focal length and a skew.
 */
function isCameraIntrinsics({ type, bytes, view }: Box): boolean {
  const at = type === "cmin" ? 0 : type === "uuid" && uuidOf(bytes) === INTRINSICS_UUID ? 16 : null;
  if (at === null || view.byteLength < at + 4) return false;
  const anisotropic = (view.getUint32(at) & 1) === 1;
  return view.getUint8(at) === 0 && view.byteLength >= at + 16 + (anisotropic ? 8 : 0);
}

/**
 * The size of an image with `properties`: its extents (`ispe`), set to the clean aperture (`clap`) it's
 * cropped to, and swapped for a rotation (`irot`) of 90° or 270°, as its properties come, in their order.
 * libheif turns or mirrors (`imir`) an image, or reads its camera intrinsics, only where it has extents.
 * libvips drops a HEIF's EXIF orientation, so it's never swapped.
 */
function sizeOf(properties: Box[]): Header | null {
  let size = { width: 0, height: 0 };
  let extents = false;
  for (const { type, view } of properties) {
    if (type !== "ispe") continue;
    if (view.getUint8(0) !== 0) return null;
    const [width, height] = [view.getUint32(4), view.getUint32(8)];
    if (!width || !height || width > MAX_INT || height > MAX_INT || width * height > MAX_HEIF_PIXELS) return null;
    [size, extents] = [{ width, height }, true];
  }
  for (const property of properties) {
    const { type, view } = property;
    if (type === "clap") {
      const aperture = cleanAperture(view);
      if (!aperture) return null;
      size = aperture;
    } else if (type === "irot" || type === "imir") {
      // Its byte's lowest bits turn it by quarters, or say which way to mirror it.
      const turned = type === "irot" && (view.getUint8(0) & 1) === 1;
      if ((turned || type === "imir") && !extents) return null;
      if (turned) size = { width: size.height, height: size.width };
    } else if (isCameraIntrinsics(property) && !extents) {
      return null;
    }
  }
  return { ...size, orientation: null };
}

/** libheif's largest term of a fraction, which it halves both terms of until neither is larger. */
const MAX_FRACTION = 0x10000;

/** A `clap` box's width and height, rounded as libheif rounds them, or null where libheif refuses it. */
function cleanAperture(view: DataView): ImageSize | null {
  const term = (n: number) => view.getUint32(4 * n);
  const [width, widthOver, height, heightOver, leftOver, topOver] = [term(0), term(1), term(2), term(3), term(5), term(7)];
  if ([width, widthOver, height, heightOver, leftOver, topOver].some((value) => value > MAX_INT)) return null;
  if ([widthOver, heightOver, leftOver, topOver].includes(0)) return null;
  return { width: rounded(width, widthOver), height: rounded(height, heightOver) };
}

/** `numerator / denominator` to the nearest whole number, halves up, once libheif has halved its terms. */
function rounded(numerator: number, denominator: number): number {
  while (denominator > MAX_FRACTION || (denominator > 1 && numerator > MAX_FRACTION)) {
    numerator = Math.trunc(numerator / 2);
    denominator = Math.trunc(denominator / 2);
  }
  return Math.trunc((numerator + Math.trunc(denominator / 2)) / denominator);
}

/** The orientation in `exif`, a TIFF structure as EXIF keeps one, where libexif can read one. */
function exifOrientation(exif: Uint8Array): number | null {
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  return attempt(() => firstIfd(view, exif)?.short(0x0112) ?? null);
}

const SHORT = 3;
const LONG = 4;

/** A TIFF structure's first image file directory, for the one number an entry holds, by its tag and type. */
function firstIfd(view: DataView, bytes: Uint8Array) {
  const order = ascii(bytes, 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  if (view.getUint16(2, little) !== 42) return null;
  const at = view.getUint32(4, little);
  const count = view.getUint16(at, little);
  /** The first entry for `tag`'s number, if it holds one number of one of `types`. */
  const value = (tag: number, types: number[]) => {
    for (let entry = at + 2; entry < at + 2 + 12 * count; entry += 12) {
      if (view.getUint16(entry, little) !== tag) continue;
      const type = view.getUint16(entry + 2, little);
      if (!types.includes(type) || view.getUint32(entry + 4, little) !== 1) return null;
      return type === SHORT ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
    }
    return null;
  };
  return { short: (tag: number) => value(tag, [SHORT]), number: (tag: number) => value(tag, [SHORT, LONG]) };
}

/** Each format libvips reads here, whose signatures never overlap. */
const FORMATS = [jpeg, png, gif, webp, tiff, heif];
