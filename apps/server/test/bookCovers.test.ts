import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import JSZip from "jszip";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { db, schema } from "../src/db/client.js";
import {
  COVER_WIDTH,
  extractEpubCover,
  setImageLibraryForTests,
  sniffImage,
} from "../src/books/cover.js";
import { deleteBook } from "../src/books/service.js";
import { processBook } from "../src/queue/processBook.js";
import { setObjectStoreForTests } from "../src/storage/bookFiles.js";
import { backfillBookCovers, loadBookCover } from "../src/storage/bookCovers.js";
import { addBookFile, createBook, createUser } from "./helpers/db.js";
import { makeEpub } from "./helpers/epub.js";
import { makePdf } from "./helpers/pdf.js";
import { MemoryObjectStore } from "./helpers/objectStore.js";

const { books, bookCovers } = schema;
const logger = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

// Real images, larger than a stored cover, so shrinking has something to do.
const blank = { width: 900, height: 1350, channels: 3 as const, background: "#246" };
const JPEG = await sharp({ create: blank }).jpeg().toBuffer();
const PNG = await sharp({ create: blank }).png().toBuffer();
const width = async (data: Buffer) => (await sharp(data).metadata()).width;

/** A test EPUB with extra manifest/metadata/guide lines and extra (binary) files. */
async function epubWith(
  opf: { manifest?: string; metadata?: string; guide?: string },
  files: Record<string, Buffer | string>,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeEpub("<p>The fox ran.</p>"));
  let xml = await zip.file("OEBPS/content.opf")!.async("string");
  xml = xml
    .replace("</metadata>", `${opf.metadata ?? ""}</metadata>`)
    .replace("</manifest>", `${opf.manifest ?? ""}</manifest>`)
    .replace("</package>", `${opf.guide ?? ""}</package>`);
  zip.file("OEBPS/content.opf", xml);
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  return zip.generateAsync({ type: "nodebuffer" });
}

const epub3 = () =>
  epubWith(
    { manifest: `<item id="c" href="images/front.jpg" media-type="image/jpeg" properties="cover-image"/>` },
    { "OEBPS/images/front.jpg": JPEG },
  );

const bookRow = async (id: string) =>
  (await db.select().from(books).where(eq(books.id, id)))[0]!;

let userId: string;
beforeEach(async () => {
  userId = await createUser();
});
afterEach(() => {
  setObjectStoreForTests(undefined);
  setImageLibraryForTests(undefined);
});

describe("extractEpubCover", () => {
  it("reads the EPUB 3 cover-image item", async () => {
    expect(await extractEpubCover(await epub3())).toEqual({
      data: JPEG,
      mimeType: "image/jpeg",
      ext: "jpg",
    });
  });

  it("reads the EPUB 2 meta cover, typing it by its bytes rather than the manifest", async () => {
    const epub = await epubWith(
      {
        metadata: `<meta content="img1" name="cover"/>`,
        manifest: `<item href="art%20work/one.jpg" id="img1" media-type="image/jpeg"/>`,
      },
      { "OEBPS/art work/one.jpg": PNG },
    );
    expect(await extractEpubCover(epub)).toMatchObject({ mimeType: "image/png", ext: "png" });
  });

  it("follows a guide cover page to the image it shows", async () => {
    const epub = await epubWith(
      { guide: `<guide><reference type="cover" href="text/cover.xhtml"/></guide>` },
      {
        "OEBPS/text/cover.xhtml": `<html><body><img alt="" src="../pics/a.png"/></body></html>`,
        "OEBPS/pics/a.png": PNG,
      },
    );
    expect((await extractEpubCover(epub))?.data).toEqual(PNG);
  });

  it("falls back to a manifest image named like a cover", async () => {
    const epub = await epubWith(
      { manifest: `<item id="x1" href="Cover.jpeg" media-type="image/jpeg"/>` },
      { "OEBPS/Cover.jpeg": JPEG },
    );
    expect((await extractEpubCover(epub))?.data).toEqual(JPEG);
  });

  it("returns null for no cover, a non-image cover, and a file that isn't an EPUB", async () => {
    expect(await extractEpubCover(await makeEpub("<p>Hi there.</p>"))).toBeNull();
    const svg = await epubWith(
      { manifest: `<item id="c" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>` },
      { "OEBPS/cover.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>` },
    );
    expect(await extractEpubCover(svg)).toBeNull();
    expect(await extractEpubCover(await makePdf("The fox ran."))).toBeNull();
  });

  it("sniffs webp and gif, and nothing else", () => {
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.mimeType).toBe("image/webp");
    expect(sniffImage(Buffer.from("GIF89a"))?.mimeType).toBe("image/gif");
    expect(sniffImage(Buffer.from("<svg/>"))).toBeNull();
  });
});

describe("covers without object storage", () => {
  beforeEach(() => setObjectStoreForTests(null));

  it("processBook stores a shrunk cover in Postgres and stamps the book", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    await addBookFile(book.id, await epub3());

    await processBook(book.id, logger);

    const updated = await bookRow(book.id);
    expect(updated.status).toBe("ready");
    expect(updated.coverVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(updated.coverCheckedAt).not.toBeNull();
    const cover = await loadBookCover(book.id);
    expect(cover?.mimeType).toBe("image/webp");
    expect(await width(cover!.data)).toBe(COVER_WIDTH);
    expect(cover!.data.length).toBeLessThan(JPEG.length);
    const [row] = await db.select().from(bookCovers).where(eq(bookCovers.bookId, book.id));
    expect(row).toMatchObject({ width: COVER_WIDTH, sizeBytes: cover!.data.length });
  });

  it("treats a cover that does not decode as no cover", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    const broken = await epubWith(
      { manifest: `<item id="c" href="c.jpg" media-type="image/jpeg" properties="cover-image"/>` },
      { "OEBPS/c.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) },
    );
    await addBookFile(book.id, broken);

    await processBook(book.id, logger);

    const updated = await bookRow(book.id);
    expect(updated.status).toBe("ready");
    expect(updated.coverVersion).toBeNull();
    expect(updated.coverCheckedAt).not.toBeNull();
  });

  it("processBook stamps a book that has no cover", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    await addBookFile(book.id, await makePdf("The fox ran. The dog played."), "book.pdf");

    await processBook(book.id, logger);

    const updated = await bookRow(book.id);
    expect(updated.status).toBe("ready");
    expect(updated.coverVersion).toBeNull();
    expect(updated.coverCheckedAt).not.toBeNull();
    expect(await loadBookCover(book.id)).toBeNull();
  });
});

describe("covers in object storage", () => {
  let store: MemoryObjectStore;
  beforeEach(() => {
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
  });

  it("backfills unchecked books into the bucket, once", async () => {
    const withCover = await createBook(userId);
    await addBookFile(withCover.id, await epub3());
    const plain = await createBook(userId);
    await addBookFile(plain.id, await makeEpub("<p>Hi there.</p>"));
    const noFile = await createBook(userId);
    const unprocessed = await createBook(userId, { status: "uploaded" });

    const result = await backfillBookCovers();

    expect(result.found).toEqual([withCover.id]);
    expect(result.none.sort()).toEqual([plain.id, noFile.id].sort());
    expect(result.failed).toEqual([]);
    const key = `books/covers/${withCover.id}.webp`;
    expect(await width(store.objects.get(key)!)).toBe(COVER_WIDTH);
    const [row] = await db.select().from(bookCovers).where(eq(bookCovers.bookId, withCover.id));
    expect(row).toMatchObject({ objectKey: key, data: null, mimeType: "image/webp" });
    expect((await loadBookCover(withCover.id))?.data).toEqual(store.objects.get(key));
    expect((await bookRow(unprocessed.id)).coverCheckedAt).toBeNull();

    expect(await backfillBookCovers()).toMatchObject({ found: [], none: [], shrunk: [], failed: [] });
  });

  it("keeps the original while the image library is missing, then shrinks it and drops the original", async () => {
    const book = await createBook(userId);
    await addBookFile(book.id, await epub3());
    setImageLibraryForTests(null);

    const first = await backfillBookCovers();
    expect(first).toMatchObject({ found: [book.id], shrunk: [], libraryMissing: true });
    const original = `books/covers/${book.id}.jpg`;
    expect(store.objects.get(original)).toEqual(JPEG);
    const before = (await bookRow(book.id)).coverVersion;

    setImageLibraryForTests(undefined);
    const second = await backfillBookCovers();
    expect(second).toMatchObject({ found: [], shrunk: [book.id], failed: [], libraryMissing: false });
    expect([...store.objects.keys()]).toEqual([`books/covers/${book.id}.webp`]);
    const [row] = await db.select().from(bookCovers).where(eq(bookCovers.bookId, book.id));
    expect(row).toMatchObject({ width: COVER_WIDTH, mimeType: "image/webp" });
    expect((await bookRow(book.id)).coverVersion).not.toBe(before);

    expect((await backfillBookCovers()).shrunk).toEqual([]);
  });

  it("leaves a book pending when the bucket upload fails", async () => {
    const book = await createBook(userId);
    await addBookFile(book.id, await epub3());
    store.failNext = "put";

    expect((await backfillBookCovers()).failed).toEqual([book.id]);
    expect((await bookRow(book.id)).coverCheckedAt).toBeNull();

    expect((await backfillBookCovers()).found).toEqual([book.id]);
  });

  it("removes the cover object with the book", async () => {
    const book = await createBook(userId);
    await addBookFile(book.id, await epub3());
    await backfillBookCovers();
    expect(store.objects.size).toBe(1);

    expect(await deleteBook(userId, book.id)).toBe(true);
    expect(store.objects.size).toBe(0);
  });
});

describe("GET /api/books/:id/cover", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { email, password: "supersecret123", name: "Test" },
    });
    const raw = res.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw : [raw])
      .filter((c): c is string => Boolean(c))
      .map((c) => c.split(";")[0])
      .join("; ");
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    return { cookie, userId: (me.json() as { user: { id: string } }).user.id };
  }

  it("serves the owner's cover, cacheable, and 404s for anyone else or no cover", async () => {
    setObjectStoreForTests(null);
    const alice = await signUp("alice@example.com");
    const bob = await signUp("bob@example.com");
    const book = await createBook(alice.userId);
    await addBookFile(book.id, await epub3());
    const bare = await createBook(alice.userId);
    await backfillBookCovers();

    const url = `/api/books/${book.id}/cover`;
    const ok = await app.inject({ method: "GET", url, headers: { cookie: alice.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/webp");
    expect(ok.headers["cache-control"]).toContain("immutable");
    expect(await width(ok.rawPayload)).toBe(COVER_WIDTH);

    expect((await app.inject({ method: "GET", url, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const none = await app.inject({
      method: "GET",
      url: `/api/books/${bare.id}/cover`,
      headers: { cookie: alice.cookie },
    });
    expect(none.statusCode).toBe(404);
  });
});
