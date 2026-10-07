import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AiDefinitionButton } from "../src/components/AiDefinitionButton";
import * as api from "../src/lib/api";
import type { AiDefinitionStatus } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  generateAiDefinition: vi.fn(),
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

function renderButton(props: { aiStatus?: AiDefinitionStatus | null; enabled?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <AiDefinitionButton
      bookId="book-1"
      word="whale"
      aiStatus={props.aiStatus ?? null}
      enabled={props.enabled ?? true}
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
});

describe("AiDefinitionButton", () => {
  it("requests the definition on click and disappears", async () => {
    renderButton({});
    fireEvent.click(screen.getByRole("button", { name: /AI definition for whale/ }));
    await waitFor(() => expect(api.generateAiDefinition).toHaveBeenCalledWith("book-1", "whale"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each(["pending", "done"] as const)("renders nothing when the word is %s", (aiStatus) => {
    renderButton({ aiStatus });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a retry for a failed definition", () => {
    renderButton({ aiStatus: "failed" });
    expect(screen.getByRole("button")).toHaveAttribute("title", "Try AI definition again");
  });

  it("renders nothing when AI definitions are not configured", () => {
    renderButton({ enabled: false });
    expect(screen.queryByRole("button")).toBeNull();
    expect(api.checkUsage).not.toHaveBeenCalled();
  });

  it("comes back when the request fails", async () => {
    vi.mocked(api.generateAiDefinition).mockRejectedValue(new Error("boom"));
    renderButton({});
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(api.generateAiDefinition).toHaveBeenCalled());
    expect(await screen.findByRole("button")).toBeInTheDocument();
  });

  it("stays hidden on a 409 (already generated)", async () => {
    vi.mocked(api.generateAiDefinition).mockRejectedValue(new api.ApiError("dup", 409));
    renderButton({});
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(api.generateAiDefinition).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });
});
