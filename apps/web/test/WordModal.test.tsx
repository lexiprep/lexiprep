import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WordModal, type WordModalInitial } from "../src/components/WordModal";
import * as api from "../src/lib/api";
import { toast } from "sonner";
import type { WordDetail } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  getWordDetail: vi.fn(),
  setWordStatus: vi.fn(),
  clearWordStatus: vi.fn(),
  setWordNote: vi.fn(),
  deleteWordNote: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const detail = (over: Partial<WordDetail> = {}): WordDetail => ({
  word: "ocean",
  lemma: "ocean",
  count: 8,
  level: "B1",
  example: "the deep ocean",
  status: null,
  forms: [{ word: "ocean", count: 8, example: null }],
  definition: [{ pos: "noun", gloss: "a large body of salt water" }],
  note: null,
  ...over,
});

function renderModal(
  initial?: WordModalInitial,
  onStatusChange?: (word: string, status: api.UserWordStatus | null) => void,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <WordModal
      bookId="book-1"
      word="ocean"
      language="en"
      source="book"
      initial={initial}
      onStatusChange={onStatusChange}
      onClose={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks(); // module-level mocks retain call history across tests otherwise
  vi.mocked(api.setWordStatus).mockResolvedValue({ ok: true, count: 1 });
  vi.mocked(api.clearWordStatus).mockResolvedValue({ ok: true });
  vi.mocked(api.setWordNote).mockResolvedValue({ ok: true });
});

describe("WordModal", () => {
  it("renders the word, level, example and definition", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail());
    renderModal();

    expect(await screen.findByRole("heading", { name: "ocean" })).toBeInTheDocument();
    expect(await screen.findByText("B1")).toBeInTheDocument();
    expect(
      await screen.findByText("a large body of salt water"),
    ).toBeInTheDocument();
    // The example renders with the studied word bolded (so it splits "the deep" / "ocean").
    expect(screen.getByText(/the deep/)).toBeInTheDocument();
    expect(screen.getByText("ocean", { selector: ".ctx-hl" })).toBeInTheDocument();
  });

  it("bolds the studied word and its surface forms in the context line", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(
      detail({
        example: "the deep oceans and the calm ocean",
        forms: [
          { word: "ocean", count: 8, example: null },
          { word: "oceans", count: 2, example: null },
        ],
      }),
    );
    renderModal();

    const bolded = await screen.findAllByText(/oceans?/, { selector: ".ctx-hl" });
    expect(bolded.map((n) => n.textContent)).toEqual(["oceans", "ocean"]);
  });

  it("paints the row data instantly and loads the definition in parallel", () => {
    // The detail request never resolves: the modal must still show what the row knows.
    vi.mocked(api.getWordDetail).mockReturnValue(new Promise<WordDetail>(() => {}));
    renderModal({
      word: "ocean",
      level: "B1",
      count: 8,
      status: null,
      example: "the deep ocean",
    });

    expect(screen.getByRole("heading", { name: "ocean" })).toBeInTheDocument();
    expect(screen.getByText("B1")).toBeInTheDocument();
    expect(screen.getByText(/the deep/)).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument(); // definition still pending
  });

  it("reflects the new status instantly when a button is clicked", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: null }));
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Known" }));
    // Optimistic: the button shows active immediately, without awaiting the request.
    expect(screen.getByRole("button", { name: "✓ Known" })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.setWordStatus).toHaveBeenCalledWith("ocean", "known", "en", "book"),
    );
  });

  it("resets the button and toasts when the request fails", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: null }));
    vi.mocked(api.setWordStatus).mockRejectedValue(new Error("network down"));
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Known" }));
    expect(screen.getByRole("button", { name: "✓ Known" })).toBeInTheDocument();

    // On failure the optimistic state rolls back and a toast is shown.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Known" })).toBeInTheDocument(),
    );
    expect(toast.error).toHaveBeenCalledWith("network down");
  });

  it("marks a word as learning when its status is unset", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: null }));
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Learning" }));
    await waitFor(() =>
      expect(api.setWordStatus).toHaveBeenCalledWith("ocean", "learning", "en", "book"),
    );
  });

  it("clears the status when the active button is clicked again (toggle off)", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: "learning" }));
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "✓ Learning" }));
    await waitFor(() =>
      expect(api.clearWordStatus).toHaveBeenCalledWith("ocean", "en", "book"),
    );
    expect(api.setWordStatus).not.toHaveBeenCalled();
  });

  // The host (e.g. the book page) owns its word list and freezes the review batch. The modal
  // must hand it a status change via onStatusChange — and never refetch the list itself — so
  // marking a word from the modal drops it from the batch without pulling new words in.
  it("notifies the host via onStatusChange after a status change succeeds", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: null }));
    const onStatusChange = vi.fn();
    renderModal(undefined, onStatusChange);

    fireEvent.click(await screen.findByRole("button", { name: "Known" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith("ocean", "known"),
    );
  });

  it("notifies the host with null when the status is cleared (toggle off)", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: "learning" }));
    const onStatusChange = vi.fn();
    renderModal(undefined, onStatusChange);

    fireEvent.click(await screen.findByRole("button", { name: "✓ Learning" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith("ocean", null),
    );
  });

  it("does NOT notify the host when the status change fails", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ status: null }));
    vi.mocked(api.setWordStatus).mockRejectedValue(new Error("network down"));
    const onStatusChange = vi.fn();
    renderModal(undefined, onStatusChange);

    fireEvent.click(await screen.findByRole("button", { name: "Known" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does NOT notify the host when only a note is saved", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ note: null }));
    const onStatusChange = vi.fn();
    renderModal(undefined, onStatusChange);

    const textarea = await screen.findByPlaceholderText(/Add a meaning/i);
    fireEvent.change(textarea, { target: { value: "god of the sea here" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(api.setWordNote).toHaveBeenCalled());
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("saves a per-book note", async () => {
    vi.mocked(api.getWordDetail).mockResolvedValue(detail({ note: null }));
    renderModal();

    const textarea = await screen.findByPlaceholderText(/Add a meaning/i);
    fireEvent.change(textarea, { target: { value: "god of the sea here" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(api.setWordNote).toHaveBeenCalledWith("book-1", "ocean", "god of the sea here"),
    );
  });
});
