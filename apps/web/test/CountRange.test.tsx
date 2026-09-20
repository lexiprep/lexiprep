import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CountRange } from "../src/components/CountRange";

function setup(props: Partial<Parameters<typeof CountRange>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(<CountRange min="" max="" onChange={onChange} {...props} />);
  return { onChange, ...utils };
}

/** Run past the component's debounce. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CountRange", () => {
  it("summarises the active bounds on the trigger", () => {
    const { rerender, onChange } = setup();
    expect(screen.getByRole("button", { name: /Any/ })).toBeInTheDocument();
    rerender(<CountRange min="10" max="" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /10\+/ })).toBeInTheDocument();
    rerender(<CountRange min="10" max="50" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /10–50/ })).toBeInTheDocument();
    rerender(<CountRange min="" max="50" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /≤ 50/ })).toBeInTheDocument();
  });

  it("opens the dropdown and reports edited bounds once typing settles", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Any/ }));
    fireEvent.change(screen.getByLabelText("Minimum count"), { target: { value: "12" } });
    expect(onChange).not.toHaveBeenCalled(); // debounced, not per keystroke
    settle();
    expect(onChange).toHaveBeenCalledWith({ min: "12", max: "" });
  });

  it("ignores anything that isn't a count", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Any/ }));
    const min = screen.getByLabelText("Minimum count") as HTMLInputElement;
    fireEvent.change(min, { target: { value: "-5" } });
    settle();
    expect(min.value).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears both bounds", () => {
    const { onChange } = setup({ min: "10", max: "50" });
    fireEvent.click(screen.getByRole("button", { name: /10–50/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    settle();
    expect(onChange).toHaveBeenCalledWith({ min: "", max: "" });
  });
});
