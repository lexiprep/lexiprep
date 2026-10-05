import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DictionaryPage } from "../src/pages/DictionaryPage";
import * as api from "../src/lib/api";
import type { Book, BookWordRow } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  getBook: vi.fn(),
  searchBookDictionary: vi.fn(),
  recordWordLookup: vi.fn(),
}));

// The modal is the book page's own and is tested there; here only that it opens.
vi.mock("../src/components/WordModal", () => ({
  WordModal: ({ word, onClose }: { word: string; onClose: () => void }) => (
    <div role="dialog">
      <span>modal:{word}</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const row = (word: string, count: number): BookWordRow => ({
  word,
  count,
  level: "B2",
  example: null,
  status: null,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/books/book-1/dictionary"]}>
        <Routes>
          <Route path="/books/:id/dictionary" element={<DictionaryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getBook).mockResolvedValue({
    id: "book-1",
    title: "The Odyssey",
    language: "en",
    status: "ready",
  } as Book);
  vi.mocked(api.searchBookDictionary).mockResolvedValue([row("stride", 5), row("astride", 1)]);
  vi.mocked(api.recordWordLookup).mockResolvedValue({ ok: true });
});

describe("DictionaryPage", () => {
  it("starts empty and searches only once something is typed", async () => {
    renderPage();
    const input = await screen.findByLabelText("Look up a word");
    expect(screen.queryByRole("list")).toBeNull();
    expect(api.searchBookDictionary).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "strode" } });
    expect(await screen.findByText("stride")).toBeInTheDocument();
    expect(api.searchBookDictionary).toHaveBeenCalledWith("book-1", "strode");
  });

  it("counts a lookup when a match is opened, then resets for the next word", async () => {
    renderPage();
    const input = await screen.findByLabelText("Look up a word");
    fireEvent.change(input, { target: { value: "strode" } });
    fireEvent.click(await screen.findByText("stride"));

    expect(api.recordWordLookup).toHaveBeenCalledTimes(1);
    expect(api.recordWordLookup).toHaveBeenCalledWith("book-1", "stride");
    expect(screen.getByText("modal:stride")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(input).toHaveValue("");
    expect(screen.queryByRole("list")).toBeNull();
    expect(input).toHaveFocus();
  });

  it("opens the top match on Enter", async () => {
    renderPage();
    const input = await screen.findByLabelText("Look up a word");
    fireEvent.change(input, { target: { value: "stride" } });
    await screen.findByText("astride");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("modal:stride")).toBeInTheDocument();
    expect(api.recordWordLookup).toHaveBeenCalledWith("book-1", "stride");
  });

  it("says so when nothing matches", async () => {
    vi.mocked(api.searchBookDictionary).mockResolvedValue([]);
    renderPage();
    fireEvent.change(await screen.findByLabelText("Look up a word"), {
      target: { value: "zebra" },
    });
    expect(await screen.findByText(/No word in this book matches/)).toBeInTheDocument();
  });
});
