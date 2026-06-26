import { describe, it, expect, vi, afterEach } from "vitest";
import {
  exportDeckUrl,
  getBookWords,
  reviewBatch,
  clearWordStatus,
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
    await expect(clearWordStatus("ocean")).resolves.toBeUndefined();
  });
});
