// HEIF files, AVIF and HEIC, laid out as encoders write them: an `ftyp` box naming the brands a file
// keeps to, then a `meta` box describing its items and their properties, then an `mdat` box holding
// what the items locate in it. libvips reads a HEIF's size without its pictures, so an image here
// locates nothing, and only its codec's configuration says what it'd be decoded as.

const encoder = new TextEncoder();

/** `values`, each in `size` bytes, most significant first. */
function numbers(size: 1 | 2 | 4, ...values: number[]): Uint8Array {
  const bytes = new Uint8Array(size * values.length);
  const view = new DataView(bytes.buffer);
  values.forEach((value, n) => (size === 1 ? view.setUint8(n, value) : size === 2 ? view.setUint16(2 * n, value) : view.setUint32(4 * n, value)));
  return bytes;
}

/** `parts`, one after another. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  return bytes;
}

/** A box of `type` holding `parts`. */
export const box = (type: string, ...parts: Uint8Array[]) => concat(numbers(4, 8 + parts.reduce((length, part) => length + part.length, 0)), encoder.encode(type), ...parts);

/** A box whose contents start with its version and flags. */
export const fullBox = (type: string, version: number, flags: number, ...parts: Uint8Array[]) => box(type, numbers(4, version * 2 ** 24 + flags), ...parts);

/** An image's extents: its width and height before it's cropped or turned. */
export const ispe = (width: number, height: number) => fullBox("ispe", 0, 0, numbers(4, width, height));

/** A rotation of an image by `quarters` turns anticlockwise, of which only the lowest two bits count. */
export const irot = (quarters: number) => box("irot", numbers(1, quarters));

/** A mirroring of an image about its vertical axis, or with `axis` 1, its horizontal one. */
export const imir = (axis = 0) => box("imir", numbers(1, axis));

/** A clean aperture of `width` by `height`, each a fraction, at the image's center, which it's cropped to. */
export const clap = ([width, widthOver]: [number, number], [height, heightOver]: [number, number]) =>
  box("clap", numbers(4, width, widthOver, height, heightOver, 0, 1, 0, 1));

/** The AV1 configuration of an 8-bit 4:2:0 image, from which libvips learns it's 8-bit. */
export const av1C = box("av1C", Uint8Array.of(0x81, 0x00, 0x0c, 0x00));

/** The HEVC configuration of an 8-bit 4:2:0 image, in the Main profile, with no parameter sets. */
export const hvcC = box("hvcC", Uint8Array.of(1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0));

/** The VVC configuration of an 8-bit 4:2:0 image, in the Main 10 profile, with no parameter sets. */
export const vvcC = fullBox("vvcC", 0, 0, Uint8Array.of(0x07, 0x00, 0x11, 0x1f, 0x01, 0x02, 0x33, 0x00, 0x00, 0x02, 0x80, 0x01, 0xe0, 0x00, 0x00, 0x00));

/** The AVC configuration of an image in the Baseline profile, with no parameter sets. */
export const avcC = box("avcC", Uint8Array.of(1, 66, 0, 30, 0xff, 0xe0, 0));

/** A JPEG 2000 image's header, with none of the boxes it can hold. */
export const j2kH = box("j2kH");

/** The configuration of an uncompressed image of 8-bit red, green and blue. */
export const uncC = fullBox("uncC", 1, 0, encoder.encode("rgb3"));

/** A property of a type no reader knows. */
export const unknownBox = () => box("zzzz", Uint8Array.of(1));

/** A `uuid` box of `uuid`, written in hex, holding what camera intrinsics would: a full box of a focal length and principal point of 0. */
export const uuidBox = (uuid: string) => box("uuid", Uint8Array.from(uuid.match(/../g)!, (pair) => parseInt(pair, 16)), new Uint8Array(16));

/** Camera intrinsics: a focal length and principal point, each 0. */
export const cmin = fullBox("cmin", 0, 0, numbers(4, 0, 0, 0));

/** A property marked essential to its item: a reader that doesn't know its type can't read the item. */
export const essential = (property: Uint8Array) => ({ essential: property });

/** A property of an item's, which may be marked essential to it. */
export type Property = Uint8Array | ReturnType<typeof essential>;

/** What makes an auxiliary image what it is: its type, a URN. */
export const auxC = (type: string) => fullBox("auxC", 0, 0, encoder.encode(`${type}\0`));

/** What makes an auxiliary image an alpha channel. */
export const alpha = auxC("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha");

/** What makes an auxiliary image a depth map. */
export const depth = auxC("urn:mpeg:mpegB:cicp:systems:auxiliary:depth");

/** EXIF holding only an orientation, as an `Exif` item keeps it: after the offset of its TIFF header, 0. */
export const exifOrientation = (orientation: number) =>
  concat(numbers(4, 0), encoder.encode("MM\0\x2a"), numbers(4, 8), numbers(2, 1), numbers(2, 0x0112, 3), numbers(4, 1), numbers(2, orientation, 0), numbers(4, 0));

/** A grid's data, which libheif reads though libvips needs none of it for a size: `rows` by `columns` images, making `width` by `height`. */
export const gridData = (rows: number, columns: number, width: number, height: number) => concat(numbers(1, 0, 0, rows - 1, columns - 1), numbers(2, width, height));

/** An overlay's data, which libheif reads too: `count` images at its top left corner, making `width` by `height` over no fill. */
export const overlayData = (count: number, width: number, height: number) => concat(numbers(1, 0, 0), numbers(2, 0, 0, 0, 0, width, height, ...Array<number>(2 * count).fill(0)));

/** A region item's data, which libheif reads too: over an image of `width` by `height`, `masks` regions, each shaped by an image the item refers to (`mask`). */
export const regionData = (width: number, height: number, masks = 0) =>
  concat(numbers(1, 0, 0), numbers(2, width, height), numbers(1, masks), ...Array.from({ length: masks }, () => concat(numbers(1, 4), numbers(2, 0, 0, width, height))));

export interface Item {
  id: number;
  /** Its type, `av01` unless it says otherwise. */
  type?: string;
  /** A `mime` item's content type. */
  contentType?: string;
  hidden?: boolean;
  /** Its properties, in the order its entry in the `ipma` box lists them; none for an item that isn't an image. */
  properties?: Property[];
  /** What it holds in the `mdat` box. */
  data?: Uint8Array;
}

export interface Reference {
  type: string;
  from: number;
  to: number[];
}

export interface HeifFile {
  brand?: string;
  compatible?: string[];
  primary?: number;
  items: Item[];
  /** References from an item to others, as an `iref` box lists them, such as a thumbnail's (`thmb`). */
  references?: Reference[];
  /** The `hdlr` box's handler, `pict` unless it says otherwise, or none for no `hdlr` box. */
  handler?: string | null;
  /** The `meta` box's children to leave out. */
  without?: string[];
  /** How many empty `free` boxes end the `meta` box and the `iprp` box. */
  free?: { meta?: number; iprp?: number };
  /** Items the `ipma` box gives properties to, though the `iinf` box doesn't list them. */
  unlisted?: Item[];
  /** Whether ids take 32 bits, as with more than 65,535 items, and the places of properties 15. */
  wide?: boolean;
  /** Whether the `mdat` box comes before the `meta` box. */
  dataFirst?: boolean;
}

/** `count` empty `free` boxes. */
const freeBoxes = (count = 0) => Array.from({ length: count }, () => box("free"));

/** An AVIF unless its brands say otherwise, whose primary item is the first. */
export function heifFile({
  brand = "avif",
  compatible = ["avif", "mif1", "miaf"],
  items,
  primary = items[0]!.id,
  references = [],
  handler = "pict",
  without = [],
  free = {},
  unlisted = [],
  wide = false,
  dataFirst = false,
}: HeifFile): Uint8Array {
  const id = (...ids: number[]) => numbers(wide ? 4 : 2, ...ids);
  const version = wide ? 1 : 0;
  const ftyp = box("ftyp", encoder.encode(brand), numbers(4, 0), ...compatible.map((name) => encoder.encode(name)));
  const located = items.filter(({ data }) => data);
  const mdat = box("mdat", ...located.map(({ data }) => data!));

  const properties: Uint8Array[] = [];
  /** `property`'s place in the `ipco` box, after its bit saying whether it's essential. */
  const placeOf = (property: Property) =>
    property instanceof Uint8Array ? properties.push(property) : properties.push(property.essential) | (wide ? 0x8000 : 0x80);
  const entries = [...items, ...unlisted]
    .filter(({ properties }) => properties)
    .map(({ id: item, properties: own }) => concat(id(item), numbers(1, own!.length), numbers(wide ? 2 : 1, ...own!.map(placeOf))));
  /** The `meta` box, with each located item's data at `offsets`. */
  const meta = (offsets: number[]) => {
    const children = {
      hdlr: handler === null ? null : fullBox("hdlr", 0, 0, numbers(4, 0), encoder.encode(handler), new Uint8Array(13)),
      pitm: fullBox("pitm", version, 0, id(primary)),
      // Offsets and lengths in 4 bytes, and in version 2, a construction method saying the data's in the file.
      iloc: fullBox(
        "iloc",
        wide ? 2 : 0,
        0,
        numbers(1, 0x44, 0),
        numbers(wide ? 4 : 2, located.length),
        ...located.map(({ id: item, data }, n) => concat(id(item), wide ? numbers(2, 0) : new Uint8Array(), numbers(2, 0, 1), numbers(4, offsets[n]!, data!.length))),
      ),
      iinf: fullBox(
        "iinf",
        version,
        0,
        numbers(wide ? 4 : 2, items.length),
        ...items.map(({ id: item, type = "av01", contentType, hidden = false }) =>
          fullBox("infe", wide ? 3 : 2, hidden ? 1 : 0, id(item), numbers(2, 0), encoder.encode(contentType === undefined ? `${type}\0` : `${type}\0${contentType}\0`)),
        ),
      ),
      iref: references.length ? fullBox("iref", version, 0, ...references.map(({ type, from, to }) => box(type, id(from), numbers(2, to.length), id(...to)))) : null,
      iprp: box("iprp", box("ipco", ...properties), fullBox("ipma", version, wide ? 1 : 0, numbers(4, entries.length), ...entries), ...freeBoxes(free.iprp)),
    };
    return fullBox("meta", 0, 0, ...Object.entries(children).flatMap(([type, child]) => (child && !without.includes(type) ? [child] : [])), ...freeBoxes(free.meta));
  };
  // Each located item's data starts where the ones before it end, in the `mdat` box, wherever that is.
  const dataStart = ftyp.length + (dataFirst ? 0 : meta(located.map(() => 0)).length) + 8;
  const offsets = located.map((_, n) => dataStart + located.slice(0, n).reduce((length, { data }) => length + data!.length, 0));
  return dataFirst ? concat(ftyp, mdat, meta(offsets)) : concat(ftyp, meta(offsets), mdat);
}
