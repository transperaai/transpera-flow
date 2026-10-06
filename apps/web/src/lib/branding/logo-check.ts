// Client branding (issue #34): what a logo file must be. Checked by content (magic bytes), never by file name or declared
// type, in the browser before upload and again on the server after it. Pure and framework-free.

export const MAX_LOGO_BYTES = 524_288; // 512 KB (the bucket's limit too)
export const LOGO_MIN_PX = 16;
export const LOGO_MAX_PX = 2048;
export type LogoType = "png" | "jpg" | "webp";
export const LOGO_MIME: Record<LogoType, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
export type LogoCheck = { ok: true; type: LogoType; width: number; height: number } | { ok: false; error: string };

export const LOGO_ERRORS = {
  type: "Use a PNG, JPG or WebP image. SVG isn't accepted because it can carry scripts.",
  big: "That image is over 512 KB.",
  large: "That image is too large: up to 2048 × 2048 pixels.",
  small: "That image is too small: at least 16 pixels each side.",
  animated: "Use a still image, not an animation.",
  unreadable: "That file isn't an image we can read.",
} as const;

const fail = (error: string): LogoCheck => ({ ok: false, error });
type Dims = { width: number; height: number } | "animated" | null;

const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function pngDims(b: Uint8Array): Dims {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  // Walk the chunks up to the first IDAT: an `acTL` chunk before it marks an animated PNG.
  let pos = 8;
  while (pos + 8 <= b.length) {
    const type = ascii(b, pos + 4, 4);
    if (type === "acTL") return "animated";
    if (type === "IDAT" || type === "IEND") break;
    pos += 12 + u32be(b, pos);
  }
  return { width, height };
}

function jpegDims(b: Uint8Array): Dims {
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) return null;
    while (b[pos] === 0xff && pos < b.length) pos++; // fill bytes
    const marker = b[pos]!;
    pos++;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue; // standalone markers
    if (pos + 2 > b.length) return null;
    const len = u16be(b, pos);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 7 > b.length) return null;
      return { height: u16be(b, pos + 3), width: u16be(b, pos + 5) };
    }
    if (marker === 0xda) return null; // the scan starts: no frame header was found
    if (len < 2) return null;
    pos += len;
  }
  return null;
}

function webpDims(b: Uint8Array): Dims {
  if (b.length < 25) return null;
  const chunk = ascii(b, 12, 4);
  // Each form needs its header bytes: VP8 up to byte 29, VP8L up to 24, VP8X up to 29.
  if ((chunk === "VP8 " || chunk === "VP8X") && b.length < 30) return null;
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const width = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const height = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return { width, height };
  }
  if (chunk === "VP8X") {
    if (b[20]! & 0x02) return "animated";
    return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  return null;
}

/** By content (magic bytes), never by name or declared type. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return fail(LOGO_ERRORS.unreadable);
  if (bytes.length > MAX_LOGO_BYTES) return fail(LOGO_ERRORS.big);
  let type: LogoType | null = null;
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) type = "png";
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = "jpg";
  else if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") type = "webp";
  if (!type) return fail(LOGO_ERRORS.type);
  const dims = type === "png" ? pngDims(bytes) : type === "jpg" ? jpegDims(bytes) : webpDims(bytes);
  if (dims === "animated") return fail(LOGO_ERRORS.animated);
  if (!dims) return fail(LOGO_ERRORS.unreadable);
  if (dims.width > LOGO_MAX_PX || dims.height > LOGO_MAX_PX) return fail(LOGO_ERRORS.large);
  if (dims.width < LOGO_MIN_PX || dims.height < LOGO_MIN_PX) return fail(LOGO_ERRORS.small);
  return { ok: true, type, width: dims.width, height: dims.height };
}
