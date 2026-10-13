import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AiSynonymsSection } from "../src/components/AiSynonymsSection";
import * as api from "../src/lib/api";
import type { AiSynonyms } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  generateAiSynonyms: vi.fn(),
  checkUsage: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function renderSection(props: { aiSynonyms?: AiSynonyms | null; enabled?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <AiSynonymsSection
      bookId="book-1"
      word="happy"
      aiSynonyms={props.aiSynonyms ?? null}
      enabled={props.enabled ?? true}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.checkUsage).mockResolvedValue({ allowed: true, windows: [] });
  vi.mocked(api.generateAiSynonyms).mockResolvedValue({
    aiSynonyms: { status: "pending", synonyms: null, error: null },
  });
});

describe("AiSynonymsSection", () => {
  it("lists the synonyms in their order once done", () => {
    renderSection({
      aiSynonyms: { status: "done", synonyms: ["glad", "cheerful", "content"], error: null },
    });
    expect(screen.getByText("Synonyms")).toBeInTheDocument();
    expect(screen.getAllByText(/^(glad|cheerful|content)$/).map((el) => el.textContent)).toEqual([
      "glad",
      "cheerful",
      "content",
    ]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says so when the word has no close synonym, rather than showing loose ones", () => {
    renderSection({ aiSynonyms: { status: "done", synonyms: [], error: null } });
    expect(screen.getByText(/No close synonyms/)).toBeInTheDocument();
  });

  it("shows the finding state while pending", () => {
    renderSection({ aiSynonyms: { status: "pending", synonyms: null, error: null } });
    expect(screen.getByText(/Finding synonyms/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the button for a word without synonyms, with the book as context", async () => {
    renderSection({ aiSynonyms: null });
    fireEvent.click(screen.getByRole("button", { name: /AI synonyms/ }));
    await waitFor(() =>
      expect(api.generateAiSynonyms).toHaveBeenCalledWith("happy", "en", "book-1"),
    );
    // Switches to finding on click, without waiting for the refetch.
    expect(await screen.findByText(/Finding synonyms/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the button again when the request fails", async () => {
    vi.mocked(api.generateAiSynonyms).mockRejectedValueOnce(new Error("network down"));
    renderSection({ aiSynonyms: null });
    fireEvent.click(screen.getByRole("button", { name: /AI synonyms/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /AI synonyms/ })).toBeEnabled(),
    );
  });

  it("offers a retry for a failed generation", () => {
    renderSection({ aiSynonyms: { status: "failed", synonyms: null, error: "model exploded" } });
    expect(screen.getByText(/model exploded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try AI synonyms again/ })).toBeInTheDocument();
  });

  it("offers no button when the feature is disabled on the server, but still shows done synonyms", () => {
    const { container, unmount } = renderSection({ aiSynonyms: null, enabled: false });
    expect(container).toBeEmptyDOMElement();
    unmount();
    renderSection({
      aiSynonyms: { status: "done", synonyms: ["glad"], error: null },
      enabled: false,
    });
    expect(screen.getByText("glad")).toBeInTheDocument();
  });
});
