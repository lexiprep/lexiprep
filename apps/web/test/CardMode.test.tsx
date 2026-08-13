import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CardMode, countOptions } from "../src/components/CardMode";
import * as api from "../src/lib/api";
import type { BookWordRow, WordDetail } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  getWordDetail: vi.fn(),
  setWordStatus: vi.fn(),
  clearWordStatus: vi.fn(),
  addWordNote: vi.fn(),
  updateWordNote: vi.fn(),
  deleteWordNote: vi.fn(),
  generateAiDefinition: vi.fn(),
  checkUsage: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
  "golf", "hotel", "india", "juliet", "kilo", "lima",
];

const rows = (n: number, over: Partial<BookWordRow> = {}): BookWordRow[] =>
  WORDS.slice(0, n).map((word, i) => ({
    word,
    count: 10 - i,
    level: "B1",
    example: `a sentence containing ${word} in it`,
    status: null,
    ...over,
  }));

const detail = (over: Partial<WordDetail> = {}): WordDetail => ({
  word: "alpha",
  lemma: "alpha",
  count: 10,
  level: "B1",
  example: "a sentence containing alpha in it",
  status: null,
  forms: [{ word: "alpha", count: 10, example: null }],
  definition: [{ pos: "noun", gloss: "the first letter" }],
  notes: [],
  aiDefinition: null,
  aiDefinitionEnabled: false,
  ...over,
});

function setup(deck: BookWordRow[] = rows(12)) {
  const onDecide = vi.fn();
  const onRestore = vi.fn();
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = render(
    <CardMode
      bookId="book-1"
      language="en"
      rows={deck}
      onDecide={onDecide}
      onRestore={onRestore}
      onClose={onClose}
    />,
    { wrapper },
  );
  return { ...view, onDecide, onRestore, onClose };
}

/** Walk past the intro screen, choosing a session size. */
const start = (count: number | string) => {
  fireEvent.click(screen.getByRole("button", { name: String(count) }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
};

const progress = () => screen.getByText(/^\d+\/\d+$/).textContent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.setWordStatus).mockResolvedValue({ ok: true, count: 1 });
  vi.mocked(api.clearWordStatus).mockResolvedValue({ ok: true });
  vi.mocked(api.getWordDetail).mockResolvedValue(detail());
});

describe("countOptions", () => {
  it("offers multiples of five, then the whole deck", () => {
    expect(countOptions(12)).toEqual([5, 10, 12]);
    expect(countOptions(47)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 47]);
  });

  it("caps at 50 for bigger batches", () => {
    expect(countOptions(100)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect(countOptions(50)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
  });

  it("offers only the whole deck when it is tiny", () => {
    expect(countOptions(3)).toEqual([3]);
    expect(countOptions(5)).toEqual([5]);
    expect(countOptions(0)).toEqual([]);
  });
});

describe("CardMode intro", () => {
  it("opens on the intro screen, not the deck", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Card mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "alpha" })).not.toBeInTheDocument();
  });

  it("offers the batch-appropriate sizes, with the remainder as All (N)", () => {
    setup(rows(12));
    expect(screen.getByRole("button", { name: "5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All (12)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "15" })).not.toBeInTheDocument();
  });

  // The default is 20, which a 12-word batch can't honour.
  it("clamps a remembered size that overshoots this batch", () => {
    localStorage.setItem("lexiprep.book.book-1.cards", JSON.stringify({ count: 50 }));
    setup(rows(12));
    expect(screen.getByRole("button", { name: "All (12)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("remembers the chosen size for the book", () => {
    const { unmount } = setup(rows(12));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    unmount();

    setup(rows(12));
    expect(screen.getByRole("button", { name: "5" })).toHaveAttribute("aria-pressed", "true");
  });

  it("deals only the chosen number of cards", () => {
    setup(rows(12));
    start(5);
    expect(progress()).toBe("1/5");
    expect(screen.getByRole("heading", { name: "alpha" })).toBeInTheDocument();
  });

  it("cancels back to the book page without dealing", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CardMode deck", () => {
  it("shows the word and its context, and withholds the definition until asked", async () => {
    setup(rows(12));
    start(5);

    expect(screen.getByRole("heading", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByText(/a sentence containing/)).toBeInTheDocument();
    expect(screen.queryByText("the first letter")).not.toBeInTheDocument();
    // Nothing is fetched for a card you never reveal.
    expect(api.getWordDetail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show definition" }));
    expect(await screen.findByText("the first letter")).toBeInTheDocument();
    expect(api.getWordDetail).toHaveBeenCalledWith("book-1", "alpha");
  });

  it("re-hides the definition on the next card", async () => {
    setup(rows(12));
    start(5);
    fireEvent.click(screen.getByRole("button", { name: "Show definition" }));
    expect(await screen.findByText("the first letter")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    expect(screen.queryByText("the first letter")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show definition" })).toBeInTheDocument();
  });

  it("marks known and advances", async () => {
    const { onDecide } = setup(rows(12));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    // The decision is handed to the host immediately — the animation doesn't gate it.
    expect(onDecide).toHaveBeenCalledWith("alpha", "known");
    await waitFor(() => expect(progress()).toBe("2/5"));
    expect(screen.getByRole("heading", { name: "bravo" })).toBeInTheDocument();
  });

  it("marks learning and ignored from the bottom bar", async () => {
    const { onDecide } = setup(rows(12));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Learning/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    fireEvent.click(screen.getByRole("button", { name: /Ignore/ }));
    await waitFor(() => expect(progress()).toBe("3/5"));

    expect(onDecide).toHaveBeenNthCalledWith(1, "alpha", "learning");
    expect(onDecide).toHaveBeenNthCalledWith(2, "bravo", "ignored");
  });

  it("takes arrow keys on the desktop", async () => {
    const { onDecide } = setup(rows(12));
    start(5);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(onDecide).toHaveBeenCalledWith("alpha", "known");
    await waitFor(() => expect(progress()).toBe("2/5"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(onDecide).toHaveBeenCalledWith("bravo", "learning");
  });

  it("exits on Escape", () => {
    const { onClose } = setup(rows(12));
    start(5);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CardMode undo", () => {
  it("is unavailable on the first card", () => {
    setup(rows(12));
    start(5);
    expect(screen.getByRole("button", { name: /Undo/ })).toBeDisabled();
  });

  it("steps back and clears the status of a word that had none", async () => {
    const { onRestore } = setup(rows(12));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(progress()).toBe("1/5");
    expect(screen.getByRole("heading", { name: "alpha" })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.clearWordStatus).toHaveBeenCalledWith("alpha", "en", "book"),
    );
    // The word goes back into the book page's batch only once the revert lands.
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("alpha"));
    expect(api.setWordStatus).not.toHaveBeenCalled();
  });

  it("restores the status a word already had", async () => {
    setup(rows(12, { status: "learning" }));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));

    await waitFor(() =>
      expect(api.setWordStatus).toHaveBeenCalledWith("alpha", "learning", "en", "book"),
    );
    expect(api.clearWordStatus).not.toHaveBeenCalled();
  });

  // Two decisions deep, one undo must NOT walk the whole session back.
  it("is single-step — one undo, then it's spent", async () => {
    setup(rows(12));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("3/5"));

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(progress()).toBe("2/5");
    await waitFor(() => expect(screen.getByRole("button", { name: /Undo/ })).toBeDisabled());
    // alpha (the first decision) stays decided — only bravo was walked back.
    expect(api.clearWordStatus).toHaveBeenCalledTimes(1);
    expect(api.clearWordStatus).toHaveBeenCalledWith("bravo", "en", "book");
  });

  it("re-arms after the next decision", async () => {
    setup(rows(12));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Undo/ })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: /Learning/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    expect(screen.getByRole("button", { name: /Undo/ })).toBeEnabled();
  });

  // If the revert fails the server still holds the decision, so the deck has to agree
  // with it rather than show a card that is already marked.
  it("puts the card back when the revert fails", async () => {
    const { onRestore } = setup(rows(12));
    vi.mocked(api.clearWordStatus).mockRejectedValue(new Error("network down"));
    start(5);

    fireEvent.click(screen.getByRole("button", { name: /Known/ }));
    await waitFor(() => expect(progress()).toBe("2/5"));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(progress()).toBe("1/5");

    await waitFor(() => expect(progress()).toBe("2/5"));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("comes back out of the summary", async () => {
    setup(rows(12));
    start(5);
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /Known/ }));
      await waitFor(() => expect(api.setWordStatus).not.toBe(undefined));
      if (i < 4) await waitFor(() => expect(progress()).toBe(`${i + 2}/5`));
    }
    expect(await screen.findByRole("heading", { name: "Deck finished" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(progress()).toBe("5/5");
    expect(screen.getByRole("heading", { name: "echo" })).toBeInTheDocument();
  });
});

describe("CardMode summary", () => {
  const finishDeck = async (statuses: RegExp[]) => {
    for (let i = 0; i < statuses.length; i++) {
      fireEvent.click(screen.getByRole("button", { name: statuses[i] }));
      if (i < statuses.length - 1) {
        await waitFor(() => expect(progress()).toBe(`${i + 2}/5`));
      }
    }
  };

  it("tallies the session", async () => {
    setup(rows(12));
    start(5);
    await finishDeck([/Known/, /Known/, /Learning/, /Ignore/, /Known/]);

    expect(await screen.findByRole("heading", { name: "Deck finished" })).toBeInTheDocument();
    expect(screen.getByText("3 known")).toBeInTheDocument();
    expect(screen.getByText("1 learning")).toBeInTheDocument();
    expect(screen.getByText("1 ignored")).toBeInTheDocument();
  });

  it("re-deals just the learning words on request", async () => {
    setup(rows(12));
    start(5);
    await finishDeck([/Known/, /Learning/, /Learning/, /Known/, /Known/]);
    await screen.findByRole("heading", { name: "Deck finished" });

    fireEvent.click(screen.getByRole("button", { name: /Review the 2 learning words again/ }));
    expect(progress()).toBe("1/2");
    expect(screen.getByRole("heading", { name: "bravo" })).toBeInTheDocument();
  });

  it("offers no re-deal when nothing was left learning", async () => {
    setup(rows(12));
    start(5);
    await finishDeck([/Known/, /Known/, /Known/, /Known/, /Known/]);
    await screen.findByRole("heading", { name: "Deck finished" });

    expect(screen.queryByRole("button", { name: /again/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
  });

  it("closes on Done", async () => {
    const { onClose } = setup(rows(12));
    start(5);
    await finishDeck([/Known/, /Known/, /Known/, /Known/, /Known/]);
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
