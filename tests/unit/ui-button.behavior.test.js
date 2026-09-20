// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Button from "@/shared/components/Button.js";

afterEach(cleanup);

// Behavior tests for the shared Button primitive (complement the source-level
// tripwires in ui-button.test.js — these actually render the component).
describe("Button rendered behavior (a11y)", () => {
  it("renders its label and hides decorative icons from screen readers", () => {
    render(
      <Button icon="save" iconRight="arrow_forward">
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    const icons = button.querySelectorAll(".material-symbols-outlined");
    expect(icons.length).toBe(2);
    for (const icon of icons) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("keeps an accessible name on icon-only buttons (icon text is announced)", () => {
    render(<Button icon="folder_open" />);

    const button = screen.getByRole("button", { name: "folder_open" });
    const icon = button.querySelector(".material-symbols-outlined");
    expect(icon.getAttribute("aria-hidden")).toBe(null);
  });

  it("prefers an explicit aria-label over the icon ligature on icon-only buttons", () => {
    render(<Button icon="folder_open" aria-label="Abrir pasta" />);

    expect(screen.getByRole("button", { name: "Abrir pasta" })).toBeTruthy();
  });

  it("marks the loading state with aria-busy, disables the button and hides the spinner", () => {
    render(
      <Button icon="save" loading>
        Save
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    const spinner = button.querySelector(".material-symbols-outlined");
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.textContent.trim()).toBe("progress_activity");
  });

  it("keeps the keyboard focus-visible ring classes", () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole("button").className).toContain("focus-visible:ring-2");
    expect(screen.getByRole("button").className).toContain("focus-visible:outline-none");
  });
});
