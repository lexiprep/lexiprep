import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AiDefinitionSection } from "../src/components/AiDefinitionSection";
import * as api from "../src/lib/api";
import type { AiDefinition } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  generateAiDefinition: vi.fn(),
  generateGeneralAiDefinition: vi.fn(),
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

function renderSection(props: {
  aiDefinition?: AiDefinition | null;
  enabled?: boolean;
  bookScoped?: boolean;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <AiDefinitionSection
      bookId="book-1"
      word="whale"
      aiDefinition={props.aiDefinition ?? null}
      enabled={props.enabled ?? true}
      bookScoped={props.bookScoped ?? true}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.checkUsage).mockResolvedValue({ allowed: true, windows: [] });
  vi.mocked(api.generateAiDefinition).mockResolvedValue({
    aiDefinition: { status: "pending", senses: null, error: null },
  });
  vi.mocked(api.generateGeneralAiDefinition).mockResolvedValue({
    aiDefinition: { status: "pending", senses: null, error: null },
  });
});

describe("AiDefinitionSection", () => {
  it("renders nothing once done — the meanings show inside WordMeaning instead", () => {
    const { container } = renderSection({
      aiDefinition: {
        status: "done",
        senses: [{ pos: "noun", gloss: "a large sea animal" }],
        error: null,
      },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the generating state while pending", () => {
    renderSection({ aiDefinition: { status: "pending", senses: null, error: null } });
    expect(screen.getByText(/Generating from this book/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the generate button and fires the request", async () => {
    renderSection({ aiDefinition: null });
    const btn = screen.getByRole("button", { name: /AI definition/ });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.generateAiDefinition).toHaveBeenCalledWith("book-1", "whale"),
    );
  });

  it("switches to generating on click, without waiting for a refetch", async () => {
    // The server's `pending` only arrives with the next word-detail fetch, and that
    // request can take seconds (it may be blocked on the dictionary API). The button
    // must not stay live in the meantime — that invites a second click on a request
    // that is already running.
    renderSection({ aiDefinition: null });
    fireEvent.click(screen.getByRole("button", { name: /AI definition/ }));
    await waitFor(() =>
      expect(screen.getByText(/Generating from this book/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the button again when the request fails", async () => {
    vi.mocked(api.generateAiDefinition).mockRejectedValueOnce(new Error("network down"));
    renderSection({ aiDefinition: null });
    fireEvent.click(screen.getByRole("button", { name: /AI definition/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /AI definition/ })).toBeEnabled(),
    );
    expect(screen.queryByText(/Generating from this book/)).not.toBeInTheDocument();
  });

  it("offers a retry only for a failed generation", () => {
    renderSection({
      aiDefinition: { status: "failed", senses: null, error: "model exploded" },
    });
    expect(screen.getByText(/model exploded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try AI definition again/ })).toBeInTheDocument();
  });

  it("renders nothing when the feature is disabled on the server", () => {
    const { container } = renderSection({ enabled: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("outside a book, offers the context-free generation instead", async () => {
    // No book means no sentences to define the word *in* — but the word still has its
    // own meanings, and that generation is what the library-wide modal offers.
    renderSection({ aiDefinition: null, bookScoped: false });
    fireEvent.click(screen.getByRole("button", { name: /AI meanings/ }));
    await waitFor(() =>
      expect(api.generateGeneralAiDefinition).toHaveBeenCalledWith("whale", "en"),
    );
    expect(api.generateAiDefinition).not.toHaveBeenCalled();
    expect(screen.getByText(/Generating the word/)).toBeInTheDocument();
  });
});
