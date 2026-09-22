import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterSheet } from "../src/components/FilterSheet";

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FilterSheet", () => {
  it("keeps the controls inline on a wide screen", () => {
    mockMatchMedia(false);
    render(
      <FilterSheet applied={["Level A2–B1"]}>
        <label>
          Level <select aria-label="Level from" />
        </label>
      </FilterSheet>,
    );
    expect(screen.getByRole("combobox", { name: "Level from" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("shows applied filters on the page and the controls in a modal on a phone", () => {
    mockMatchMedia(true);
    render(
      <FilterSheet applied={["Level A2–B1", "“suit”"]}>
        <label>
          Level <select aria-label="Level from" />
        </label>
      </FilterSheet>,
    );
    expect(screen.getByText("Level A2–B1")).toBeInTheDocument();
    expect(screen.getByText("“suit”")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Level from" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(screen.getByRole("combobox", { name: "Level from" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Filters" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("combobox", { name: "Level from" })).not.toBeInTheDocument();
    expect(screen.getByText("Level A2–B1")).toBeInTheDocument();
  });
});
