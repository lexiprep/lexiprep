import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog
      title="Finish book?"
      message="This marks everything reviewed."
      confirmLabel="Finish"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel, ...utils };
}

describe("ConfirmDialog", () => {
  it("renders the title, message and action labels", () => {
    setup();
    expect(screen.getByText("Finish book?")).toBeInTheDocument();
    expect(screen.getByText("This marks everything reviewed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("fires the right callback for each button", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on overlay click but not on inner-modal click", () => {
    const { onCancel, container } = setup();
    fireEvent.click(container.querySelector(".modal")!);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".modal-overlay")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while busy", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("styles the confirm button as danger when requested", () => {
    setup({ danger: true });
    expect(screen.getByRole("button", { name: "Finish" })).toHaveClass("danger");
  });
});
