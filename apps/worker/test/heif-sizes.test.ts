// The sizes recorded for AVIF and HEIC files are the ones libvips 8.16.1 reads with libheif 1.19.8, as
// Debian 13 packages them. Later versions of libheif read a few of these files differently, as the tests
// say where.
import { describe, expect, it } from "vitest";
import { metadataOf } from "../src/files/uploads";
import {
  alpha,
  av1C,
  avcC,
  box,
  clap,
  cmin,
  depth,
  essential,
  exifOrientation,
  fullBox,
  gridData,
  type HeifFile,
  heifFile,
  hvcC,
  imir,
  irot,
  ispe,
  type Item,
  j2kH,
  overlayData,
  type Property,
  type Reference,
  regionData,
  uncC,
  unknownBox,
  uuidBox,
  vvcC,
} from "./heif-files";

/** The width and height recorded for `file`, or null where none is. */
function recordedSize(file: HeifFile | Uint8Array, contentType = "image/avif") {
  const { width, height } = JSON.parse(metadataOf(file instanceof Uint8Array ? file : heifFile(file), contentType)) as { width?: number; height?: number };
  return width === undefined ? null : { width, height };
}

/** An AV1 image's properties: its configuration and its extents, then `more`. */
const image = (width: number, height: number, ...more: Property[]) => [av1C, ispe(width, height), ...more];

/** An AVIF of one image, `width` by `height`, with `more` properties. */
const avif = (width: number, height: number, ...more: Property[]): HeifFile => ({ items: [{ id: 1, properties: image(width, height, ...more) }] });

/** A hidden AV1 image, `id`, of 1200x800, such as a grid's tile. */
const tile = (id: number): Item => ({ id, hidden: true, properties: image(1200, 800) });

/** An image, `id`, of `type` and 1200x800, derived from those its references say (`dimg`), with `data` saying how. */
const derived = (id: number, type: string, data?: Uint8Array): Item => ({ id, type, properties: [ispe(1200, 800)], data });

/** An Exif item, `id`, of the default orientation. */
const exif = (id: number): Item => ({ id, type: "Exif", data: exifOrientation(1) });

/** The size of most images here. */
const size = { width: 1200, height: 800 };

/** `count` ids, from `first` on. */
const ids = (first: number, count: number) => Array.from({ length: count }, (_, n) => first + n);

describe("How files are recognized", () => {
  it("records an AVIF's or a HEIC's size from its image's extents, without reading its picture", () => {
    expect(metadataOf(heifFile(avif(1200, 800)), "image/avif")).toBe('{"identified":true,"width":1200,"height":800,"analyzed":true}');
    const heic = heifFile({ brand: "heic", compatible: ["mif1", "heic"], items: [{ id: 1, type: "hvc1", properties: [hvcC, ispe(4032, 3024)] }] });
    expect(recordedSize(heic, "image/heic")).toEqual({ width: 4032, height: 3024 });
    // With the pictures before the boxes describing them, and with ids and places of properties that take more bits.
    expect(recordedSize({ ...avif(1200, 800), dataFirst: true })).toEqual({ width: 1200, height: 800 });
    expect(recordedSize({ wide: true, items: [{ id: 70000, properties: image(1200, 800) }] })).toEqual({ width: 1200, height: 800 });
  });

  it("records the size of an image of up to 16,384 squared pixels, the most libvips lets libheif open", () => {
    expect(recordedSize(avif(16384, 16384))).toEqual({ width: 16384, height: 16384 });
    expect(recordedSize(avif(65536, 4096))).toEqual({ width: 65536, height: 4096 });
    // Later versions of libheif read these sizes too.
    expect(recordedSize(avif(16385, 16384))).toBeNull();
    expect(recordedSize(avif(65537, 4096))).toBeNull();
    expect(recordedSize(avif(0, 800))).toBeNull();
    expect(recordedSize(avif(2 ** 31, 1))).toBeNull();
  });

  it("swaps the width and height for a rotation by 90° or 270°, though not for a mirroring", () => {
    expect(recordedSize(avif(1200, 800, irot(1)))).toEqual({ width: 800, height: 1200 });
    expect(recordedSize(avif(1200, 800, irot(2)))).toEqual({ width: 1200, height: 800 });
    expect(recordedSize(avif(1200, 800, irot(3)))).toEqual({ width: 800, height: 1200 });
    // Only the rotation's lowest two bits count.
    expect(recordedSize(avif(1200, 800, irot(5)))).toEqual({ width: 800, height: 1200 });
    expect(recordedSize(avif(1200, 800, imir(1)))).toEqual({ width: 1200, height: 800 });
  });

  it("crops the size to a clean aperture, rounding its fractions as libheif does", () => {
    expect(recordedSize(avif(1200, 800, clap([1000, 1], [700, 1])))).toEqual({ width: 1000, height: 700 });
    expect(recordedSize(avif(1200, 800, clap([47, 2], [45, 2])))).toEqual({ width: 24, height: 23 });
    expect(recordedSize(avif(1200, 800, clap([7, 3], [8, 3])))).toEqual({ width: 2, height: 3 });
    // libheif halves both terms of a fraction until neither is larger than 65,536, or its denominator is 1.
    expect(recordedSize(avif(1200, 800, clap([98305, 65537], [700, 1])))).toEqual({ width: 2, height: 700 });
    expect(recordedSize(avif(1200, 800, clap([200000, 3], [700, 1])))).toEqual({ width: 100000, height: 700 });
    // A crop to nothing, or one libheif refuses, leaves the image unreadable.
    expect(recordedSize(avif(1200, 800, clap([1, 3], [700, 1])))).toBeNull();
    expect(recordedSize(avif(1200, 800, clap([1000, 1], [3, 65537])))).toBeNull();
    expect(recordedSize(avif(1200, 800, clap([1000, 0], [700, 1])))).toBeNull();
    expect(recordedSize(avif(1200, 800, clap([2 ** 31, 1], [700, 1])))).toBeNull();
  });

  it("crops and turns the size in the order of the image's properties, from its last extents", () => {
    expect(recordedSize(avif(1200, 800, clap([1000, 1], [700, 1]), irot(1)))).toEqual({ width: 700, height: 1000 });
    expect(recordedSize(avif(1200, 800, irot(1), clap([1000, 1], [700, 1])))).toEqual({ width: 1000, height: 700 });
    expect(recordedSize(avif(1200, 800, ispe(640, 480)))).toEqual({ width: 640, height: 480 });
  });

  it("needs an image's extents for its size, and for any rotation by a quarter, mirroring or camera intrinsics", () => {
    expect(recordedSize({ items: [{ id: 1, properties: [av1C] }] })).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, clap([1000, 1], [700, 1])] }] })).toEqual({ width: 1000, height: 700 });
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, irot(2), clap([1000, 1], [700, 1])] }] })).toEqual({ width: 1000, height: 700 });
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, irot(1)] }] })).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, imir(), clap([1000, 1], [700, 1])] }] })).toBeNull();
    // A rotation with no angle.
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, ispe(1200, 800), Uint8Array.of(0, 0, 0, 8, ...new TextEncoder().encode("irot"))] }] })).toBeNull();
    // Camera intrinsics, in a `cmin` box or a draft's `uuid` one.
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, ispe(1200, 800), cmin] }] })).toEqual(size);
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, cmin, clap([1000, 1], [700, 1])] }] })).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: [av1C, uuidBox("22cc04c7d6d94e079d904eb6ecbaf3a3"), clap([1000, 1], [700, 1])] }] })).toBeNull();
    // libheif skips camera intrinsics it can't read: of another version, or without the skew their flags say they have.
    for (const intrinsics of [fullBox("cmin", 1, 0, new Uint8Array(12)), fullBox("cmin", 0, 1, new Uint8Array(12))]) {
      expect(recordedSize({ items: [{ id: 1, properties: [av1C, intrinsics, clap([1000, 1], [700, 1])] }] })).toEqual({ width: 1000, height: 700 });
    }
  });

  it("never swaps the width and height for an EXIF orientation, which libvips drops from a HEIF", () => {
    const exif = { id: 2, type: "Exif", data: exifOrientation(6) };
    const references = [{ type: "cdsc", from: 2, to: [1] }];
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, exif], references })).toEqual({ width: 1200, height: 800 });
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, exif], references, dataFirst: true })).toEqual({ width: 1200, height: 800 });
  });

  it("records the primary image's size, or where that's another's thumbnail or alpha channel, the first other image's", () => {
    expect(recordedSize({ primary: 2, items: [{ id: 1, properties: image(640, 480) }, { id: 2, properties: image(1200, 800) }] })).toEqual({ width: 1200, height: 800 });
    const thumbnail = { primary: 2, items: [{ id: 1, properties: image(1200, 800) }, { id: 2, properties: image(240, 160) }], references: [{ type: "thmb", from: 2, to: [1] }] };
    expect(recordedSize(thumbnail)).toEqual({ width: 1200, height: 800 });
    const images = [{ id: 1, properties: image(240, 160) }, { id: 2, properties: image(1200, 800) }, { id: 3, properties: image(640, 480) }];
    expect(recordedSize({ items: images, references: [{ type: "thmb", from: 1, to: [2] }] })).toEqual({ width: 1200, height: 800 });
    const withAlpha = [{ id: 1, properties: image(1200, 800) }, { id: 2, properties: image(1200, 800, alpha) }];
    expect(recordedSize({ items: withAlpha, references: [{ type: "auxl", from: 2, to: [1] }] })).toEqual({ width: 1200, height: 800 });
    const alphaFirst = [{ id: 1, properties: image(600, 400, alpha) }, { id: 2, properties: image(1200, 800) }];
    expect(recordedSize({ primary: 2, items: alphaFirst, references: [{ type: "auxl", from: 1, to: [2] }] })).toEqual({ width: 1200, height: 800 });
  });

  it("records nothing for a file whose primary item is hidden, isn't an image or isn't there", () => {
    expect(recordedSize({ items: [{ id: 1, hidden: true, properties: image(1200, 800) }] })).toBeNull();
    expect(recordedSize({ primary: 2, items: [{ id: 1, properties: image(1200, 800) }, { id: 2, type: "Exif", data: exifOrientation(1) }] })).toBeNull();
    expect(recordedSize({ primary: 9, items: [{ id: 1, properties: image(1200, 800) }] })).toBeNull();
  });

  it("records nothing for a file with an image libheif can't open, though it isn't the one shown", () => {
    // libheif 1.19 checks every image as it reads a file. Later versions read these sizes.
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, hidden: true, properties: image(20000, 20000) }] })).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, hidden: true }] })).toBeNull();
  });

  it("needs each image's codec configuration, though it isn't the one shown, and reads no file with a tiled image", () => {
    const heic = { brand: "heic", compatible: ["mif1", "heic"], items: [{ id: 1, type: "hvc1", properties: [ispe(4032, 3024)] }] };
    expect(recordedSize(heic, "image/heic")).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: [ispe(1200, 800)] }] })).toBeNull();
    /** An AVIF with a hidden image of `type` too, with `properties`. libvips doesn't ask its bit depth, which some codecs take from its picture. */
    const withHidden = (type: string, ...properties: Property[]) => ({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, hidden: true, type, properties: [...properties, ispe(640, 480)] }] });
    // libheif 1.19 needs it of every image as it reads a file, where later versions need it only of the one shown.
    for (const [type, configuration] of [["hvc1", hvcC], ["vvc1", vvcC], ["avc1", avcC], ["j2k1", j2kH], ["unci", uncC]] as const) {
      expect(recordedSize(withHidden(type, configuration)), type).toEqual({ width: 1200, height: 800 });
      expect(recordedSize(withHidden(type)), type).toBeNull();
    }
    // A JPEG's configuration is optional, and libheif reads a tiled image's only with its experimental features.
    expect(recordedSize(withHidden("jpeg"))).toEqual({ width: 1200, height: 800 });
    expect(recordedSize(withHidden("tili", box("tilC")))).toBeNull();
  });

  it("records nothing for a file with an image whose essential property libheif doesn't know", () => {
    expect(recordedSize(avif(1200, 800, unknownBox()))).toEqual({ width: 1200, height: 800 });
    expect(recordedSize(avif(1200, 800, essential(unknownBox())))).toBeNull();
    expect(recordedSize({ wide: true, items: [{ id: 1, properties: image(1200, 800, essential(unknownBox())) }] })).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, hidden: true, properties: image(1200, 800, essential(unknownBox())) }] })).toBeNull();
    // Ones it knows can be essential, as an AVIF's configuration and transformations must be.
    expect(recordedSize({ items: [{ id: 1, properties: [essential(av1C), ispe(1200, 800), essential(irot(1)), essential(imir())] }] })).toEqual({ width: 800, height: 1200 });
    // Of `uuid` boxes, it knows only camera intrinsics' and extrinsics', as a draft wrote them.
    expect(recordedSize(avif(1200, 800, essential(uuidBox("22cc04c7d6d94e079d904eb6ecbaf3a3"))))).toEqual({ width: 1200, height: 800 });
    expect(recordedSize(avif(1200, 800, essential(uuidBox("22cc04c7d6d94e079d904eb6ecbaf3a4"))))).toBeNull();
  });

  it("records nothing for a file with a reference to an item twice", () => {
    // Later versions of libheif take these: an overlay of one image twice, and Exif describing one twice.
    const overlayOf = (...to: number[]): HeifFile => ({ primary: 2, items: [tile(1), derived(2, "iovl", overlayData(to.length, 1200, 800))], references: [{ type: "dimg", from: 2, to }] });
    expect(recordedSize(overlayOf(1))).toEqual(size);
    expect(recordedSize(overlayOf(1, 1))).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, exif(2)], references: [{ type: "cdsc", from: 2, to: [1, 1] }] })).toBeNull();
  });

  it("needs a thumbnail to be of other images, none of them a thumbnail by the time libheif comes to it", () => {
    /** The size recorded for a file of an image, two smaller ones and Exif, with `references`. */
    const withThumbnails = (...references: Reference[]) =>
      recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, properties: image(240, 160) }, { id: 3, properties: image(120, 80) }, exif(4)], references });
    expect(withThumbnails({ type: "thmb", from: 2, to: [1] }, { type: "thmb", from: 3, to: [1] })).toEqual(size);
    expect(withThumbnails({ type: "thmb", from: 2, to: [1, 3] })).toEqual(size);
    // Of nothing, of itself, or of an item that isn't an image.
    for (const to of [9, 2, 4]) expect(withThumbnails({ type: "thmb", from: 2, to: [to] }), `of ${to}`).toBeNull();
    // libheif goes through the images in the order of their ids, so it takes a thumbnail of a later one's thumbnail.
    expect(withThumbnails({ type: "thmb", from: 2, to: [3] }, { type: "thmb", from: 3, to: [1] })).toEqual(size);
    expect(withThumbnails({ type: "thmb", from: 3, to: [2] }, { type: "thmb", from: 2, to: [1] })).toBeNull();
    // It doesn't look at the references of items that aren't images.
    expect(withThumbnails({ type: "thmb", from: 4, to: [9] })).toEqual(size);
  });

  it("needs an auxiliary image to say what it is, and to be of other items", () => {
    /** The size recorded for a file of an image, an auxiliary one of `to` with `properties` too, and Exif. */
    const withAuxiliary = (to: number[], ...properties: Property[]) =>
      recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, hidden: true, properties: image(600, 400, ...properties) }, exif(3)], references: [{ type: "auxl", from: 2, to }] });
    expect(withAuxiliary([1], alpha)).toEqual(size);
    expect(withAuxiliary([1, 3], depth)).toEqual(size);
    expect(withAuxiliary([1])).toBeNull();
    // Of nothing, or of itself.
    expect(withAuxiliary([9], alpha)).toBeNull();
    expect(withAuxiliary([2], alpha)).toBeNull();
    // One only of an item that isn't an image stays a top-level image, which can be shown.
    const ofExif = { primary: 2, items: [{ id: 1, properties: image(640, 480) }, { id: 2, properties: image(1200, 800, alpha) }, exif(3)], references: [{ type: "auxl", from: 2, to: [3] }] };
    expect(recordedSize(ofExif)).toEqual(size);
  });

  it("records a grid's, an overlay's or an identity's own size, where the first image it's derived from is one libheif reads", () => {
    /** A file whose primary image is a grid of `to` in a row, of two AV1 images, a layered HEVC one and Exif. */
    const gridOf = (...to: number[]): HeifFile => ({
      items: [
        derived(1, "grid", gridData(1, to.length, 1200, 800)),
        { id: 2, hidden: true, properties: image(600, 800) },
        { id: 3, hidden: true, properties: image(600, 800) },
        { id: 4, type: "lhv1", hidden: true, properties: [ispe(600, 800)] },
        exif(5),
      ],
      references: [{ type: "dimg", from: 1, to }],
    });
    expect(recordedSize(gridOf(2, 3))).toEqual(size);
    // libvips asks its bit depth, which libheif takes from the first image it's derived from, reading the others
    // only to decode the picture. The first can't be nothing, a layered HEVC image, whose bit depth libheif can't
    // read, or an item that isn't an image.
    expect(recordedSize(gridOf(2, 9))).toEqual(size);
    for (const first of [9, 4, 5]) expect(recordedSize(gridOf(first, 2)), `of ${first}`).toBeNull();
    const identities = [derived(1, "iden"), { ...derived(2, "iden"), hidden: true }, tile(3)];
    expect(recordedSize({ items: identities, references: [{ type: "dimg", from: 1, to: [2] }, { type: "dimg", from: 2, to: [3] }] })).toEqual(size);
    expect(recordedSize({ items: identities, references: [{ type: "dimg", from: 2, to: [3] }] })).toBeNull();
    expect(recordedSize({ items: [derived(1, "iovl", overlayData(0, 1200, 800)), exif(2)], references: [{ type: "cdsc", from: 2, to: [1] }] })).toBeNull();
  });

  it("needs a grid to be derived from others, and an overlay an iref box, though neither is shown", () => {
    /** The size recorded for a file of an image, a hidden `item`, a tile and Exif, with `references`. */
    const withHidden = (item: Item, ...references: Reference[]) => recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { ...item, hidden: true }, tile(3), exif(4)], references });
    const grid = derived(2, "grid", gridData(1, 1, 1200, 800));
    const overlay = derived(2, "iovl", overlayData(0, 1200, 800));
    expect(withHidden(grid, { type: "dimg", from: 2, to: [3] })).toEqual(size);
    // libvips never reads a hidden one's images.
    expect(withHidden(grid, { type: "dimg", from: 2, to: [9] })).toEqual(size);
    expect(withHidden(overlay, { type: "cdsc", from: 4, to: [1] })).toEqual(size);
    // Later versions of libheif take these.
    expect(withHidden(grid, { type: "cdsc", from: 4, to: [1] })).toBeNull();
    expect(withHidden(overlay)).toBeNull();
  });

  it("records nothing for a file whose primary image is derived from itself, along the first reference from each", () => {
    // Later versions of libheif take an AV1 image derived from itself, and a grid of a tile derived from it.
    expect(recordedSize({ items: [derived(1, "iden")], references: [{ type: "dimg", from: 1, to: [1] }] })).toBeNull();
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }], references: [{ type: "dimg", from: 1, to: [1] }] })).toBeNull();
    const grid = derived(1, "grid", gridData(1, 2, 1200, 800));
    const identity = (id: number) => ({ ...derived(id, "iden"), hidden: true });
    expect(recordedSize({ items: [grid, tile(2), identity(3)], references: [{ type: "dimg", from: 1, to: [2, 3] }, { type: "dimg", from: 3, to: [1] }] })).toBeNull();
    // Two ways to one image, a cycle the primary image doesn't come to, and a second reference from one are fine.
    const diamond = [{ type: "dimg", from: 1, to: [2, 3] }, { type: "dimg", from: 2, to: [4] }, { type: "dimg", from: 3, to: [4] }];
    expect(recordedSize({ items: [grid, identity(2), identity(3), tile(4)], references: diamond })).toEqual(size);
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, identity(2), identity(3)], references: [{ type: "dimg", from: 2, to: [3] }, { type: "dimg", from: 3, to: [2] }] })).toEqual(size);
    expect(recordedSize({ items: [derived(1, "iden"), tile(2)], references: [{ type: "dimg", from: 1, to: [2] }, { type: "dimg", from: 1, to: [1] }] })).toEqual(size);
  });

  it("needs Exif and XMP to describe items, a region images, and premultiplied alpha to be an image's", () => {
    /** The size recorded for a file of an image, its alpha channel, Exif, XMP and a region, with `references` from them. */
    const withMetadata = (...references: Reference[]) =>
      recordedSize({
        items: [
          { id: 1, properties: image(1200, 800) },
          { id: 2, hidden: true, properties: image(1200, 800, alpha) },
          exif(3),
          { id: 4, type: "mime", contentType: "application/rdf+xml", data: new TextEncoder().encode("<x:xmpmeta/>") },
          { id: 5, type: "rgan", data: regionData(1200, 800) },
        ],
        references: [{ type: "auxl", from: 2, to: [1] }, ...references],
      });
    // Exif and XMP can describe any item, though libheif 1.19 checks only the first reference from each.
    expect(withMetadata({ type: "cdsc", from: 3, to: [1, 4] }, { type: "cdsc", from: 4, to: [5] })).toEqual(size);
    expect(withMetadata({ type: "cdsc", from: 3, to: [9] })).toBeNull();
    expect(withMetadata({ type: "cdsc", from: 4, to: [9] })).toBeNull();
    expect(withMetadata({ type: "cdsc", from: 3, to: [1] }, { type: "cdsc", from: 3, to: [9] })).toEqual(size);
    // A region must describe only images, through every reference from it.
    expect(withMetadata({ type: "cdsc", from: 5, to: [1, 2] })).toEqual(size);
    expect(withMetadata({ type: "cdsc", from: 5, to: [3] })).toBeNull();
    expect(withMetadata({ type: "cdsc", from: 5, to: [1] }, { type: "cdsc", from: 5, to: [9] })).toBeNull();
    // An image's alpha can be premultiplied, but nothing else's, though libheif skips a reference from nothing.
    expect(withMetadata({ type: "prem", from: 1, to: [2] })).toEqual(size);
    expect(withMetadata({ type: "prem", from: 3, to: [1] })).toBeNull();
    expect(withMetadata({ type: "prem", from: 9, to: [1] })).toEqual(size);
  });

  it("takes a region's masks out of the top-level images, and needs them to be images libheif reads", () => {
    /** The size recorded for a file of two images, a layered HEVC one, Exif, and a region of one mask, with `references`. */
    const withRegion = (...references: Reference[]) =>
      recordedSize({
        items: [
          { id: 1, properties: image(1200, 800) },
          { id: 2, properties: image(640, 480) },
          { id: 3, type: "lhv1", hidden: true, properties: [ispe(640, 480)] },
          exif(4),
          { id: 5, type: "rgan", data: regionData(1200, 800, 1) },
        ],
        references,
      });
    expect(withRegion({ type: "mask", from: 5, to: [2] })).toEqual(size);
    expect(withRegion({ type: "mask", from: 5, to: [1] })).toEqual({ width: 640, height: 480 });
    // Only a region's.
    expect(withRegion({ type: "mask", from: 4, to: [1] })).toEqual(size);
    // Of nothing, of an item that isn't an image, or of a layered HEVC image.
    for (const to of [9, 4, 3]) expect(withRegion({ type: "mask", from: 5, to: [to] }), `of ${to}`).toBeNull();
  });

  it("lists layered HEVC images, which libheif neither reads nor shows, and JPEG mime items as images", () => {
    const layered = (id: number, ...properties: Property[]): Item => ({ id, type: "lhv1", properties: [ispe(1200, 800), ...properties] });
    // It reads none of a layered HEVC image's properties, but they must be listed. Later versions of libheif take one without.
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { ...layered(2, ispe(20000, 20000), essential(unknownBox())), hidden: true }] })).toEqual(size);
    expect(recordedSize({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, type: "lhv1", hidden: true }] })).toBeNull();
    // It can't show one, though it shows another where that's the primary one's thumbnail.
    expect(recordedSize({ items: [layered(1)] })).toBeNull();
    expect(recordedSize({ items: [layered(1), { id: 2, properties: image(1200, 800) }], references: [{ type: "thmb", from: 1, to: [2] }] })).toEqual(size);
    const firstShown = { primary: 3, items: [layered(1), { id: 2, properties: image(640, 480) }, { id: 3, properties: image(240, 160) }], references: [{ type: "thmb", from: 3, to: [2] }] };
    expect(recordedSize(firstShown)).toBeNull();
    // A JPEG's properties must be listed too. Later versions of libheif look for its picture.
    const jpeg = (properties?: Property[]) => ({ items: [{ id: 1, properties: image(1200, 800) }, { id: 2, type: "mime", contentType: "image/jpeg", hidden: true, properties }] });
    expect(recordedSize(jpeg([ispe(640, 480)]))).toEqual(size);
    expect(recordedSize(jpeg())).toBeNull();
  });

  it("reads the major brands libvips 8.16 takes, of files compatible with a brand libheif takes", () => {
    expect(recordedSize({ ...avif(1200, 800), brand: "mif1", compatible: ["mif1"] })).toEqual({ width: 1200, height: 800 });
    // An image sequence's brand, of a file later versions of libheif refuse.
    const sequence = { brand: "msf1", compatible: ["msf1", "hevc", "heic", "mif1"], items: [{ id: 1, type: "hvc1", properties: [hvcC, ispe(1200, 800)] }] };
    expect(recordedSize(sequence, "image/heif-sequence")).toEqual({ width: 1200, height: 800 });
    expect(recordedSize({ ...avif(1200, 800), brand: "avis", compatible: ["avis", "avif", "mif1", "miaf"] })).toBeNull();
    expect(recordedSize({ ...avif(1200, 800), brand: "miaf" })).toBeNull();
    expect(recordedSize({ ...avif(1200, 800), compatible: ["miaf", "MA1B"] })).toBeNull();
  });

  it("reads an ftyp box of whole words, of up to 2,048 bytes", () => {
    expect(recordedSize({ ...avif(1200, 800), compatible: ["avif", "mif1", "mi"] })).toBeNull();
    // Later versions of libheif refuse one of more than 1,024 bytes.
    expect(recordedSize({ ...avif(1200, 800), compatible: ["avif", ...Array<string>(507).fill("abcd")] })).toEqual({ width: 1200, height: 800 });
    expect(recordedSize({ ...avif(1200, 800), compatible: ["avif", ...Array<string>(508).fill("abcd")] })).toBeNull();
  });

  it("needs the boxes listing a file's items, their places and properties, and which is primary", () => {
    for (const box of ["iloc", "pitm", "iinf", "iprp"]) expect(recordedSize({ ...avif(1200, 800), without: [box] }), box).toBeNull();
    expect(recordedSize({ ...avif(1200, 800), handler: "vide" })).toBeNull();
    // libheif 1.19 takes a file with no handler, which later versions refuse.
    expect(recordedSize({ ...avif(1200, 800), handler: null })).toEqual({ width: 1200, height: 800 });
    const whole = heifFile(avif(1200, 800));
    expect(recordedSize(whole.subarray(0, whole.length - 30))).toBeNull();
  });

  it("reads no more boxes in a box, nor items, than libheif's security limits let it", () => {
    // 101 boxes in the `meta`, `iprp` and `ipco` boxes, which hold five, two and two here.
    expect(recordedSize({ ...avif(1200, 800), free: { meta: 96 } })).toEqual(size);
    expect(recordedSize({ ...avif(1200, 800), free: { meta: 97 } })).toBeNull();
    expect(recordedSize({ ...avif(1200, 800), free: { iprp: 99 } })).toEqual(size);
    expect(recordedSize({ ...avif(1200, 800), free: { iprp: 100 } })).toBeNull();
    expect(recordedSize(avif(1200, 800, ...Array.from({ length: 99 }, unknownBox)))).toEqual(size);
    expect(recordedSize(avif(1200, 800, ...Array.from({ length: 100 }, unknownBox)))).toBeNull();
    // 1,000 entries in an `ipma` box, here mostly for items the `iinf` box doesn't list, and 1,000 items in a reference.
    expect(recordedSize({ ...avif(1200, 800), unlisted: ids(2, 999).map((id) => ({ id, properties: [] })) })).toEqual(size);
    expect(recordedSize({ ...avif(1200, 800), unlisted: ids(2, 1000).map((id) => ({ id, properties: [] })) })).toBeNull();
    expect(recordedSize({ ...avif(1200, 800), references: [{ type: "zzzz", from: 1, to: ids(2, 1000) }] })).toEqual(size);
    expect(recordedSize({ ...avif(1200, 800), references: [{ type: "zzzz", from: 1, to: ids(2, 1001) }] })).toBeNull();
  });

  it("reads no more than 1,000 items or references, where libheif reads any number, so that no file keeps it long", () => {
    const items = (count: number): Item[] => [{ id: 1, properties: image(1200, 800) }, ...ids(2, count - 1).map((id) => ({ id, type: "zzzz" }))];
    expect(recordedSize({ items: items(1000) })).toEqual(size);
    expect(recordedSize({ items: items(1001) })).toBeNull();
    const references = (count: number): Reference[] => Array.from({ length: count }, () => ({ type: "zzzz", from: 1, to: [1] }));
    expect(recordedSize({ ...avif(1200, 800), references: references(1000) })).toEqual(size);
    expect(recordedSize({ ...avif(1200, 800), references: references(1001) })).toBeNull();
  });
});
