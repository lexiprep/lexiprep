import { describe, it, expect, vi, afterEach } from "vitest";
import {
  exportDeckUrl,
  getBookWords,
  getVocabCounts,
  getVocabTimeseries,
  reviewBatch,
  clearWordStatus,
  uploadBookDirect,
} from "../src/lib/api";

function mockFetch(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  const res = new Response(status === 204 ? null : JSON.stringify(body), { status });
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
}

afterEach(() => vi.restoreAllMocks());

describe("exportDeckUrl", () => {
  it("omits all params when nothing is set", () => {
    expect(exportDeckUrl({})).toBe("/api/words/export");
  });

  it("joins multiple book ids and includes a level range", () => {
    expect(exportDeckUrl({ books: ["a", "b"], minLevel: "B1", maxLevel: "C1" })).toBe(
      "/api/words/export?books=a%2Cb&minLevel=B1&maxLevel=C1",
    );
  });

  it("drops an empty books array", () => {
    expect(exportDeckUrl({ books: [], language: "en" })).toBe(
      "/api/words/export?language=en",
    );
  });
});

describe("query-string building (via getBookWords)", () => {
  it("includes only set params and skips falsy ones", async () => {
    const f = mockFetch({ book: {}, stats: {}, words: [] });
    await getBookWords("book-1", {
      limit: 50,
      offset: 0,
      sort: "level:desc",
      minLevel: "A2",
      includeStopwords: false,
    });
    const url = f.mock.calls[0]![0] as string;
    expect(url).toContain("/api/books/book-1/words?");
    expect(url).toContain("limit=50");
    expect(url).toContain("sort=level%3Adesc");
    expect(url).toContain("minLevel=A2");
    // qs() drops only undefined / "" / false — so a `false` flag is omitted,
    // but a numeric 0 (offset) is kept.
    expect(url).toContain("offset=0");
    expect(url).not.toContain("includeStopwords");
  });
});

describe("vocabulary stats endpoints", () => {
  it("getVocabCounts hits /api/words/counts with the language", async () => {
    const f = mockFetch({ learning: 1, known: 2, ignored: 0 });
    const out = await getVocabCounts("en");
    expect(out).toEqual({ learning: 1, known: 2, ignored: 0 });
    expect(f.mock.calls[0]![0]).toBe("/api/words/counts?language=en");
  });

  it("getVocabTimeseries passes from/to/granularity", async () => {
    const f = mockFetch({ granularity: "week", baseline: { learning: 0, known: 0, learned: 0 }, buckets: [] });
    await getVocabTimeseries({ from: "2026-01-01", to: "2026-03-01", granularity: "week" });
    const url = f.mock.calls[0]![0] as string;
    expect(url).toContain("/api/words/stats/timeseries?");
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-03-01");
    expect(url).toContain("granularity=week");
  });
});

describe("request() behavior", () => {
  it("POSTs JSON with a content-type and returns the parsed body", async () => {
    const f = mockFetch({ learning: 1, resolved: 2 });
    const out = await reviewBatch("b1", ["a", "b", "c"], ["a"]);
    expect(out).toEqual({ learning: 1, resolved: 2 });

    const [, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      words: ["a", "b", "c"],
      learning: ["a"],
      rest: "known",
    });
  });

  it("throws the server-provided error message on a non-ok response", async () => {
    mockFetch({ error: "Word not in this book" }, { status: 404 });
    await expect(getBookWords("b1", { limit: 1, offset: 0 })).rejects.toThrow(
      "Word not in this book",
    );
  });

  it("resolves undefined on a 204 No Content", async () => {
    mockFetch(null, { status: 204 });
    await expect(clearWordStatus("ocean", "en", "learning")).resolves.toBeUndefined();
  });
});

describe("uploadBookDirect", () => {
  const file = new File(["%PDF-1.7 big"], "Atlas.pdf", { type: "application/pdf" });

  /** A stand-in XMLHttpRequest that answers the storage PUT with `status`. */
  function stubXhr(status: number) {
    const sent: { url?: string; method?: string } = {};
    class FakeXhr {
      upload: { onprogress?: (e: unknown) => void } = {};
      status = status;
      onload?: () => void;
      onerror?: () => void;
      open(method: string, url: string) {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader() {}
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 6, total: 12 });
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    return sent;
  }

  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status });

  afterEach(() => vi.unstubAllGlobals());

  it("reserves the book, sends the bytes to storage, then confirms", async () => {
    const sent = stubXhr(200);
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ book: { id: "b1" }, uploadUrl: "https://bucket/k?sig" }, 201))
      .mockResolvedValueOnce(json({ book: { id: "b1", status: "uploaded" } }, 202));
    const progress: number[] = [];

    const book = await uploadBookDirect(file, (p) => progress.push(p));

    expect(book).toMatchObject({ id: "b1", status: "uploaded" });
    expect(sent).toEqual({ method: "PUT", url: "https://bucket/k?sig" });
    expect(progress).toEqual([0.5]);
    expect(f.mock.calls[0]![0]).toBe("/api/books/uploads");
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toMatchObject({
      filename: "Atlas.pdf",
      sizeBytes: file.size,
    });
    expect(f.mock.calls[1]![0]).toBe("/api/books/b1/uploads/complete");
  });

  it("removes the reserved book when storage refuses the bytes", async () => {
    stubXhr(403);
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ book: { id: "b1" }, uploadUrl: "https://bucket/k?sig" }, 201))
      .mockResolvedValueOnce(json(null, 204));

    await expect(uploadBookDirect(file)).rejects.toThrow("Storage refused the upload (403)");

    expect(f.mock.calls[1]![0]).toBe("/api/books/b1");
    expect(f.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });
});
