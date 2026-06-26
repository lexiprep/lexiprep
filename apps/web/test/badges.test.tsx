import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LevelBadge, StatusBadge } from "../src/components/badges";
import { LEVEL_COLOR } from "../src/lib/levels";

describe("LevelBadge", () => {
  it("renders an em dash for a missing level", () => {
    render(<LevelBadge level={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the level with its band color", () => {
    render(<LevelBadge level="B1" />);
    const badge = screen.getByText("B1");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveStyle({ background: LEVEL_COLOR.B1 });
  });
});

describe("StatusBadge", () => {
  it("renders 'new' for an untriaged word", () => {
    render(<StatusBadge status={null} />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("renders the status text with its pill class", () => {
    const { container } = render(<StatusBadge status="learning" />);
    const pill = screen.getByText("learning");
    expect(pill).toHaveClass("pill", "blue");
    expect(container.querySelector(".pill.green")).toBeNull();
  });
});
