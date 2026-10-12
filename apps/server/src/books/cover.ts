import { posix } from "node:path";
import JSZip from "jszip";

export interface CoverImage {
  data: Buffer;
  mimeType: string;
  /** File extension for the object key, without the dot. */
  ext: string;
}

/** A cover is shown as a thumbnail; anything bigger than this isn't worth keeping. */
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Identify a raster image by its leading bytes. The type always comes from here, never
 * from the EPUB manifest: these bytes are served back to a browser, so a file that merely
 * claims to be an image (or an SVG, which can carry script) must not get through.
 */
export function sniffImage(data: Uint8Array): { mimeType: string; ext: string } | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, n) => data[i + n] === b);
  if (at(0, 0xff, 0xd8, 0xff)) return { mimeType: "image/jpeg", ext: "jpg" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { mimeType: "image/png", ext: "png" };
  }
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { mimeType: "image/gif", ext: "gif" };
  // "RIFF" <size> "WEBP"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return { mimeType: "image/webp", ext: "webp" };
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** Attributes of every `<name …>` tag in `xml`, namespace prefix on the tag ignored. */
function tags(xml: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const tagRe = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>`, "gi");
  for (const tag of xml.matchAll(tagRe)) {
    const attrs: Record<string, string> = {};
    for (const a of tag[1]!.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]!.toLowerCase()] = (a[2] ?? a[3] ?? "").replace(
        /&(?:amp|lt|gt|quot|apos);/g,
        (e) => ENTITIES[e]!,
      );
    }
    out.push(attrs);
  }
  return out;
}

/** Resolve an href found in the file at `from` to a path inside the zip. */
function resolve(from: string, href: string): string {
  const bare = href.split("#")[0]!.split("?")[0]!;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // not percent-encoded after all — use it as written
  }
  return posix.normalize(posix.join(posix.dirname(from), decoded)).replace(/^\/+/, "");
}

function zipFile(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const exact = zip.file(path);
  if (exact) return exact;
  // Manifests are often sloppy about case; zips are not.
  const lower = path.toLowerCase();
  return zip.filter((p) => p.toLowerCase() === lower)[0] ?? null;
}

/**
 * The cover image of an EPUB, or null when it declares none we can read. Looks, in
 * order, at the EPUB 3 `cover-image` manifest property, the EPUB 2 `<meta name="cover">`,
 * the `<guide>` cover reference, and finally any manifest image named like a cover. A
 * candidate that is an XHTML cover page is followed to the first image it shows.
 */
export async function extractEpubCover(data: Uint8Array): Promise<CoverImage | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return null;
  }
  const container = await zipFile(zip, "META-INF/container.xml")?.async("string");
  const opfPath = container && tags(container, "rootfile")[0]?.["full-path"];
  if (!opfPath) return null;
  const opf = await zipFile(zip, opfPath)?.async("string");
  if (!opf) return null;

  const items = tags(opf, "item").filter((i) => i.href);
  const isImage = (i: Record<string, string>) => /^image\//i.test(i["media-type"] ?? "");
  const candidates: string[] = [];

  const declared = items.find((i) => /\bcover-image\b/.test(i.properties ?? ""));
  if (declared) candidates.push(declared.href!);

  const metaId = tags(opf, "meta").find((m) => m.name?.toLowerCase() === "cover")?.content;
  const byMeta = metaId && items.find((i) => i.id === metaId);
  if (byMeta) candidates.push(byMeta.href!);

  const guide = tags(opf, "reference").find((r) => r.type?.toLowerCase() === "cover");
  if (guide?.href) candidates.push(guide.href);

  for (const i of items) {
    if (isImage(i) && /cover/i.test(`${i.id ?? ""} ${i.href}`)) candidates.push(i.href!);
  }

  const read = async (path: string): Promise<CoverImage | null> => {
    const bytes = await zipFile(zip, path)?.async("nodebuffer");
    if (!bytes || bytes.length === 0 || bytes.length > COVER_MAX_BYTES) return null;
    const kind = sniffImage(bytes);
    return kind ? { data: bytes, ...kind } : null;
  };

  for (const href of new Set(candidates)) {
    const path = resolve(opfPath, href);
    const image = await read(path);
    if (image) return image;
    if (!/\.x?html?$/i.test(path)) continue;
    // A cover *page*: take the first image it references (<img src> or SVG <image href>).
    const page = await zipFile(zip, path)?.async("string");
    if (!page) continue;
    const src =
      tags(page, "img")[0]?.src ??
      tags(page, "image").map((t) => t["xlink:href"] ?? t.href)[0];
    const inPage = src ? await read(resolve(path, src)) : null;
    if (inPage) return inPage;
  }
  return null;
}
