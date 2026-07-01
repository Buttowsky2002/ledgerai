import sharp from 'sharp';

/** Rasterize inline SVG to PNG for pdfkit embedding. */
export async function svgToPng(svg: string, width?: number): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(svg), { density: 144 });
  if (width) pipeline = pipeline.resize({ width: Math.round(width), withoutEnlargement: false });
  return pipeline.png().toBuffer();
}

/** Extract total page count from rendered PDF structure or footer text. */
export function pdfPageCount(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const footerMatches = text.match(/Page \d+ of (\d+)/g);
  if (footerMatches?.length) {
    const last = footerMatches[footerMatches.length - 1].match(/of (\d+)/);
    if (last) return Number(last[1]);
  }
  const pageObjs = text.match(/\/Type\s*\/Page\b/g);
  return pageObjs?.length ?? 0;
}

/** True when PDF bytes contain embedded image XObjects (chart rasters). */
export function pdfHasEmbeddedImages(pdf: Buffer): boolean {
  const text = pdf.toString('latin1');
  return text.includes('/Subtype /Image') || text.includes('/Type /XObject');
}
