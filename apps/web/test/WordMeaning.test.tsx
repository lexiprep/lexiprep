import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WordMeaning } from "../src/components/WordMeaning";
import * as api from "../src/lib/api";
import type { WordNoteItem, WordSense } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  addWordNote: vi.fn(),
  updateWordNote: vi.fn(),
  deleteWordNote: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const DICT: WordSense[] = [{ pos: "noun", gloss: "a large body of salt water" }];
const AI: WordSense[] = [
  { pos: "noun", gloss: "a man trying to win a woman's love" },
  { pos: "verb", gloss: "to make a formal request" },
];

function renderMeaning(props: {
  notes?: WordNoteItem[];
  aiSenses?: WordSense[] | null;
  bookScoped?: boolean;
  onNotesChanged?: (notes: WordNoteItem[]) => void;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <WordMeaning
      bookId="book-1"
      word="ocean"
      definition={DICT}
      notes={props.notes ?? []}
      aiSenses={props.aiSenses ?? null}
      bookScoped={props.bookScoped ?? true}
      onNotesChanged={props.onNotesChanged}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.addWordNote).mockResolvedValue({ id: "n-new", note: "my meaning" });
  vi.mocked(api.updateWordNote).mockResolvedValue({ ok: true });
  vi.mocked(api.deleteWordNote).mockResolvedValue({ ok: true });
});

describe("WordMeaning — book-scoped definition hierarchy", () => {
  it("shows the dictionary when there is nothing else", () => {
    renderMeaning({});
    expect(screen.getByText("Definition")).toBeInTheDocument();
    expect(screen.getByText("a large body of salt water")).toBeInTheDocument();
  });

  it("AI senses replace the dictionary for this book, with POS per meaning", () => {
    renderMeaning({ aiSenses: AI });
    expect(screen.getByText(/AI definition/)).toBeInTheDocument();
    expect(screen.getByText("a man trying to win a woman's love")).toBeInTheDocument();
    expect(screen.getByText("noun")).toBeInTheDocument();
    expect(screen.getByText("verb")).toBeInTheDocument();
    expect(screen.queryByText("a large body of salt water")).not.toBeInTheDocument();
  });

  it("the user's own definitions replace the AI definition (and the dictionary)", () => {
    renderMeaning({
      aiSenses: AI,
      notes: [
        { id: "n1", note: "the sea around Ithaca" },
        { id: "n2", note: "figuratively: a vast amount" },
      ],
    });
    expect(screen.getByText("Your definitions")).toBeInTheDocument();
    expect(screen.getByText("the sea around Ithaca")).toBeInTheDocument();
    expect(screen.getByText("figuratively: a vast amount")).toBeInTheDocument();
    expect(screen.queryByText(/AI definition/)).not.toBeInTheDocument();
    expect(screen.queryByText("a large body of salt water")).not.toBeInTheDocument();
  });

  it("outside a book context the dictionary stays, notes show as an addition", () => {
    renderMeaning({
      bookScoped: false,
      aiSenses: AI,
      notes: [{ id: "n1", note: "my own take" }],
    });
    expect(screen.getByText("a large body of salt water")).toBeInTheDocument();
    expect(screen.getByText("my own take")).toBeInTheDocument();
    expect(screen.queryByText(/AI definition/)).not.toBeInTheDocument();
  });

  it("adds another definition and reports the new list", async () => {
    const onNotesChanged = vi.fn();
    renderMeaning({ notes: [{ id: "n1", note: "first meaning" }], onNotesChanged });

    fireEvent.click(screen.getByRole("button", { name: "+ Add another definition" }));
    fireEvent.change(screen.getByPlaceholderText(/Add a meaning/i), {
      target: { value: "my meaning" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.addWordNote).toHaveBeenCalledWith("book-1", "ocean", "my meaning"),
    );
    expect(onNotesChanged).toHaveBeenCalledWith([
      { id: "n1", note: "first meaning" },
      { id: "n-new", note: "my meaning" },
    ]);
  });

  it("edits one definition in place by id", async () => {
    renderMeaning({
      notes: [
        { id: "n1", note: "first meaning" },
        { id: "n2", note: "second meaning" },
      ],
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit definition" })[1]!);
    fireEvent.change(screen.getByPlaceholderText(/Add a meaning/i), {
      target: { value: "revised" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(api.updateWordNote).toHaveBeenCalledWith("book-1", "ocean", "n2", "revised"),
    );
  });

  it("removes one definition by id", async () => {
    renderMeaning({ notes: [{ id: "n1", note: "goner" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove definition" }));
    await waitFor(() =>
      expect(api.deleteWordNote).toHaveBeenCalledWith("book-1", "ocean", "n1"),
    );
  });
});
