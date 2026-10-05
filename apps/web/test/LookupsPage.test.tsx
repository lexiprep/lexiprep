import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { LookupsPage } from "../src/pages/LookupsPage";
import * as api from "../src/lib/api";
import type { Book, LookupRow } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  getLookups: vi.fn(),
  listBooks: vi.fn(),
}));

// The modal is the book page's own and is tested there; here only how it is opened.
vi.mock("../src/components/WordModal", () => ({
  WordModal: ({ word, bookId, bookScoped }: { word: string; bookId: string; bookScoped?: boolean }) => (
    <div role="dialog">
      modal:{word}:{bookId}:{String(Boolean(bookScoped))}
    </div>
  ),
}));

const row = (over: Partial<LookupRow>): LookupRow => ({
  word: "stride",
  lookups: 4,
  lastAt: new Date().toISOString(),
  count: 15,
  bookCount: 2,
  level: "B2",
  example: null,
  bookTitle: "Iliad",
  bookId: "book-iliad",
  status: "known",
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LookupsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.listBooks).mockResolvedValue([
    { id: "book-iliad", title: "Iliad", status: "ready" } as Book,
  ]);
  vi.mocked(api.getLookups).mockResolvedValue({
    stats: { words: 2, lookups: 5 },
    words: [row({}), row({ word: "wrath", lookups: 1, bookId: null, status: null, count: 0 })],
  });
});

describe("LookupsPage", () => {
  it("lists looked-up words of any status, most looked-up first by default", async () => {
    renderPage();
    expect(await screen.findByText("stride")).toBeInTheDocument();
    expect(screen.getByText("5 lookups of 2 words while reading")).toBeInTheDocument();
    expect(screen.getByTitle("Looked up 4 times")).toBeInTheDocument();
    expect(screen.getByTitle("Looked up 1 time")).toBeInTheDocument();
    expect(api.getLookups).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "lookups:desc", offset: 0 }),
    );
  });

  it("re-sorts from a column header and flips on a second click", async () => {
    renderPage();
    await screen.findByText("stride");
    fireEvent.click(screen.getByText("Last"));
    await waitFor(() =>
      expect(api.getLookups).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "last:desc" }),
      ),
    );
    fireEvent.click(screen.getByText("Last"));
    await waitFor(() =>
      expect(api.getLookups).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "last:asc" }),
      ),
    );
  });

  it("filters to one book and opens the modal scoped to it", async () => {
    renderPage();
    await screen.findByText("stride");
    fireEvent.change(screen.getByLabelText("Book"), { target: { value: "book-iliad" } });
    await waitFor(() =>
      expect(api.getLookups).toHaveBeenLastCalledWith(
        expect.objectContaining({ bookId: "book-iliad" }),
      ),
    );
    fireEvent.click(screen.getByText("stride"));
    expect(screen.getByRole("dialog")).toHaveTextContent("modal:stride:book-iliad:true");
  });

  it("leaves a word with no book left unclickable", async () => {
    renderPage();
    const orphan = await screen.findByText("wrath");
    expect(orphan.tagName).toBe("SPAN");
    fireEvent.click(orphan);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("points to the dictionary when nothing has been looked up", async () => {
    vi.mocked(api.getLookups).mockResolvedValue({ stats: { words: 0, lookups: 0 }, words: [] });
    renderPage();
    expect(await screen.findByText(/Nothing looked up yet/)).toBeInTheDocument();
  });
});
