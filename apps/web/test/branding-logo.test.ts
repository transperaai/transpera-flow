import { describe, expect, it } from "vitest";
import { LOGO_ERRORS, MAX_LOGO_BYTES, checkLogo } from "@/lib/branding/logo-check";

// Client branding (issue #34, B5): the logo check works on content, with fixtures built here from bytes.

const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
  return Uint8Array.from(out);
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunk = (type: string, data: number[]) => bytes(u32(data.length), type, data, [0, 0, 0, 0]);
const png = (w: number, h: number, extra: Uint8Array[] = []) =>
  bytes(SIG, chunk("IHDR", [...u32(w), ...u32(h), 8, 6, 0, 0, 0]), ...extra, chunk("IDAT", [0]), chunk("IEND", []));
const jpeg = (w: number, h: number, sof = 0xc0) =>
  bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46], [0xff, sof, 0x00, 0x0b, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 0x11, 0], [0xff, 0xda, 0x00, 0x02]);
const riff = (fourcc: string, body: number[]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", fourcc, u32(body.length).reverse(), body);
const vp8 = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255, 0, 0]);
const vp8l = (w: number, h: number) => {
  const wm = w - 1;
  const hm = h - 1;
  return riff("VP8L", [0x2f, wm & 255, ((wm >> 8) & 0x3f) | ((hm & 3) << 6), (hm >> 2) & 255, (hm >> 10) & 0x0f, 0]);
};
const vp8x = (w: number, h: number, flags = 0) =>
  riff("VP8X", [flags, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);

describe("PNG", () => {
  it("accepts 16 x 16, and 2048 x 16", () => {
    expect(checkLogo(png(16, 16))).toEqual({ ok: true, type: "png", width: 16, height: 16 });
    expect(checkLogo(png(2048, 16))).toEqual({ ok: true, type: "png", width: 2048, height: 16 });
    expect(checkLogo(png(2048, 2048))).toMatchObject({ ok: true });
  });
  it("refuses 2049 wide, 15 x 15, and a wordmark one pixel high", () => {
    expect(checkLogo(png(2049, 100))).toEqual({ ok: false, error: LOGO_ERRORS.large });
    expect(checkLogo(png(15, 15))).toEqual({ ok: false, error: LOGO_ERRORS.small });
    expect(checkLogo(png(2048, 1))).toEqual({ ok: false, error: LOGO_ERRORS.small });
    // A small file that declares a huge size (a decompression bomb).
    expect(checkLogo(png(20000, 20000))).toEqual({ ok: false, error: LOGO_ERRORS.large });
  });
  it("refuses an animated PNG (acTL before IDAT)", () => {
    expect(checkLogo(png(32, 32, [chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0])]))).toEqual({ ok: false, error: LOGO_ERRORS.animated });
  });
  it("refuses a truncated one", () => {
    expect(checkLogo(png(32, 32).subarray(0, 20))).toEqual({ ok: false, error: LOGO_ERRORS.unreadable });
    expect(checkLogo(Uint8Array.from(SIG))).toEqual({ ok: false, error: LOGO_ERRORS.unreadable });
  });
});

describe("JPEG", () => {
  it("accepts a frame header (SOF0 and a progressive SOF2)", () => {
    expect(checkLogo(jpeg(64, 48))).toEqual({ ok: true, type: "jpg", width: 64, height: 48 });
    expect(checkLogo(jpeg(64, 48, 0xc2))).toMatchObject({ ok: true, width: 64, height: 48 });
  });
  it("refuses one with no SOF, and an oversize one", () => {
    expect(checkLogo(bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46], [0xff, 0xda, 0x00, 0x02]))).toEqual({ ok: false, error: LOGO_ERRORS.unreadable });
    expect(checkLogo(bytes([0xff, 0xd8, 0xff]))).toEqual({ ok: false, error: LOGO_ERRORS.unreadable });
    expect(checkLogo(jpeg(4000, 100))).toEqual({ ok: false, error: LOGO_ERRORS.large });
  });
});

describe("WebP", () => {
  it("accepts VP8, VP8L and a still VP8X", () => {
    expect(checkLogo(vp8(100, 50))).toEqual({ ok: true, type: "webp", width: 100, height: 50 });
    expect(checkLogo(vp8l(100, 50))).toEqual({ ok: true, type: "webp", width: 100, height: 50 });
    expect(checkLogo(vp8l(2048, 1500))).toMatchObject({ ok: true, width: 2048, height: 1500 });
    expect(checkLogo(vp8x(300, 200))).toEqual({ ok: true, type: "webp", width: 300, height: 200 });
  });
  it("refuses an animated VP8X, a truncated file and an oversize one", () => {
    expect(checkLogo(vp8x(300, 200, 0x02))).toEqual({ ok: false, error: LOGO_ERRORS.animated });
    expect(checkLogo(vp8(100, 50).subarray(0, 22))).toEqual({ ok: false, error: LOGO_ERRORS.unreadable });
    expect(checkLogo(vp8x(3000, 200))).toEqual({ ok: false, error: LOGO_ERRORS.large });
    expect(checkLogo(vp8(8, 8))).toEqual({ ok: false, error: LOGO_ERRORS.small });
  });
});

describe("everything else", () => {
  it("refuses SVG, GIF, AVIF-like and plain text by content, however they are named", () => {
    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<?xml version="1.0"?><svg/>',
      "GIF89a\u0010\u0000\u0010\u0000",
      "\u0000\u0000\u0000\u001cftypavif",
      "hello",
    ]) {
      expect(checkLogo(bytes(body)), body).toEqual({ ok: false, error: LOGO_ERRORS.type });
    }
  });
  it("refuses an empty file, and one byte over 512 KB", () => {
    expect(checkLogo(new Uint8Array(0))).toEqual({ ok: false, error: LOGO_ERRORS.unreadable });
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(png(32, 32));
    expect(checkLogo(big)).toEqual({ ok: false, error: LOGO_ERRORS.big });
    const exact = new Uint8Array(MAX_LOGO_BYTES);
    exact.set(png(32, 32));
    expect(checkLogo(exact)).toMatchObject({ ok: true });
  });
  it("the words are the brief's", () => {
    expect(LOGO_ERRORS.type).toBe("Use a PNG, JPG or WebP image. SVG isn't accepted because it can carry scripts.");
    expect(LOGO_ERRORS.big).toBe("That image is over 512 KB.");
  });
});
