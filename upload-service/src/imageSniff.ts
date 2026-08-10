export function sniffImageMimeType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).trim();
    const heicBrands = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'];
    const heifBrands = ['mif1', 'msf1'];
    if (heicBrands.includes(brand)) return 'image/heic';
    if (heifBrands.includes(brand)) return 'image/heif';
  }
  return null;
}

// image/heic and image/heif are the same ISO-BMFF container family, and browsers/OSes are
// inconsistent about which label they attach to a given file - treat either pairing as a match
// rather than forcing the client's declared type to exactly equal the sniffed one for this family.
export function mimeTypesEquivalent(a: string, b: string): boolean {
  const heifFamily = new Set(['image/heic', 'image/heif']);
  if (heifFamily.has(a) && heifFamily.has(b)) return true;
  return a === b;
}

export const SNIFF_BYTES = 16;
