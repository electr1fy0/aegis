import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import campus from "../../../data/campus-map.json";
import { CampusMap } from "../components/campus-map";
import { chooseOption } from "./select-menu";

const zones = campus.zones.map((zone) => ({ ...zone, x: 0, y: 0 }));
afterEach(cleanup);

function Picker() {
  const [value, setValue] = useState("");
  return <CampusMap zones={zones} value={value} onValueChange={setValue} />;
}

describe("campus map region selection", () => {
  it("selects actual traced regions, clears the location, and synchronizes an external selection", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const view = render(<CampusMap zones={zones} value="a-block" onValueChange={changed} />);
    expect(screen.getByRole("button", { name: "Select A Block" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Select Technology Tower" }));
    expect(changed).toHaveBeenLastCalledWith("technology-tower");
    view.rerender(<CampusMap zones={zones} value="technology-tower" onValueChange={changed} />);
    expect(screen.getByRole("button", { name: "Select Technology Tower" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Select A Block" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Clear location" }));
    expect(changed).toHaveBeenLastCalledWith("");
  });

  it("offers precise choices when the source groups services in one region", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByRole("button", { name: "Choose a location in Campus services" }));
    await chooseOption(user, screen.getByRole("combobox", { name: /Campus services.*choose a location/ }), "pharmacy");
    expect(screen.getByText("Pharmacy", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a location in Campus services" })).toHaveAttribute("aria-pressed", "true");
  });

  it("supports keyboard selection, a single tab stop, zoom controls, and fit", async () => {
    const user = userEvent.setup();
    const { container } = render(<Picker />);
    const first = screen.getByRole("button", { name: "Select A Block" });
    expect(container.querySelectorAll('polygon[tabindex="0"]')).toHaveLength(1);
    first.focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(container.querySelector('polygon[aria-pressed="true"]')).not.toBeNull();
    expect(container.querySelectorAll('polygon[tabindex="0"]')).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Map zoom 150 percent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fit campus map" }));
    expect(screen.getByLabelText("Map zoom 100 percent")).toBeInTheDocument();
  });

  it("does not select while disabled and excludes unavailable event locations", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<CampusMap zones={zones.filter((zone) => zone.id === "a-block")} value="" disabled onValueChange={changed} />);
    expect(screen.queryByRole("button", { name: "Select Technology Tower" })).not.toBeInTheDocument();
    const aBlock = screen.getByRole("button", { name: "Select A Block" });
    expect(aBlock).toHaveAttribute("tabindex", "-1");
    await user.click(aBlock);
    expect(changed).not.toHaveBeenCalled();
  });
});
