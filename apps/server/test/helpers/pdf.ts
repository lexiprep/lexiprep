import { PDFDocument, StandardFonts } from "pdf-lib";

/** Build a minimal single-page text PDF in memory (Buffer) for processBook tests. */
export async function makePdf(text: string, title = "Test PDF"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 600]);
  page.drawText(text, { x: 50, y: 540, size: 14, font });
  return Buffer.from(await doc.save());
}
