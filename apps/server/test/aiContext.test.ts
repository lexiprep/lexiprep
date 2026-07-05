import { describe, it, expect, beforeEach } from "vitest";
import { pickSpread, extractContextExamples } from "../src/ai/context.js";
import { addBookFile, createBook, createUser } from "./helpers/db.js";
import { makeEpub } from "./helpers/epub.js";

describe("pickSpread", () => {
  it("returns everything when the list fits", () => {
    expect(pickSpread([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(pickSpread([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("spreads across the list, always including first and last", () => {
    const ten = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // round(i * 9 / 4) for i=0..4 → beginning, middle and end — never the first five.
    expect(pickSpread(ten, 5)).toEqual([0, 2, 5, 7, 9]);
    expect(pickSpread(ten, 2)).toEqual([0, 9]);
  });

  it("handles the edges", () => {
    expect(pickSpread([], 5)).toEqual([]);
    expect(pickSpread([7, 8], 1)).toEqual([7]);
    expect(pickSpread([1], 0)).toEqual([]);
  });

  it("preserves document order for larger selections", () => {
    const many = Array.from({ length: 100 }, (_, i) => i);
    const picked = pickSpread(many, 5);
    expect(picked).toEqual([0, 25, 50, 74, 99]);
  });
});

describe("extractContextExamples", () => {
  let bookId: string;

  beforeEach(async () => {
    const userId = await createUser();
    const book = await createBook(userId);
    bookId = book.id;
  });

  const BODY = `
    <p>The fox appeared at dawn near the henhouse and watched quietly for a while.</p>
    <p>Nothing else stirred in the yard that morning, not even the old dog.</p>
    <p>Later the foxes returned together and circled the fence line without a sound.</p>
    <p>A foxglove grew by the gate, its purple bells nodding over the path.</p>
    <p>By nightfall the fox had gone back into the dark woods beyond the field.</p>
  `;

  it("finds sentences for any surface form, in document order, word-bounded", async () => {
    await addBookFile(bookId, await makeEpub(BODY));
    const examples = await extractContextExamples(bookId, "fox", ["fox", "foxes"]);
    expect(examples).toHaveLength(3);
    expect(examples[0]).toContain("appeared at dawn");
    expect(examples[1]).toContain("foxes returned");
    expect(examples[2]).toContain("nightfall");
    // "foxglove" must never match "fox".
    expect(examples.some((s) => s.includes("purple bells"))).toBe(false);
  });

  it("caps the selection and spreads it across the text", async () => {
    const sentences = Array.from(
      { length: 10 },
      (_, i) => `<p>Sentence number ${i} mentions the whale swimming in scene ${i}.</p>`,
    ).join("\n");
    await addBookFile(bookId, await makeEpub(sentences));
    const examples = await extractContextExamples(bookId, "whale", ["whale"], 5);
    expect(examples).toHaveLength(5);
    expect(examples[0]).toContain("number 0");
    expect(examples[4]).toContain("number 9");
  });

  it("returns [] when the book has no stored file", async () => {
    expect(await extractContextExamples(bookId, "fox", ["fox"])).toEqual([]);
  });

  it("returns [] on an unparseable file instead of throwing", async () => {
    await addBookFile(bookId, Buffer.from("not an epub at all"));
    expect(await extractContextExamples(bookId, "fox", ["fox"])).toEqual([]);
  });

  it("returns [] when no sentence contains the word", async () => {
    await addBookFile(bookId, await makeEpub("<p>Nothing relevant lives in this text.</p>"));
    expect(await extractContextExamples(bookId, "zeppelin", ["zeppelin"])).toEqual([]);
  });
});
