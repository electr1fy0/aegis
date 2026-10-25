import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MenuSelect } from "../components/ui/menu-select";
import { chooseOption } from "./select-menu";

afterEach(cleanup);

function LocationForm({ onSubmit }: { onSubmit: (data: FormData) => void }) {
  const [zone, setZone] = useState("");
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}>
    <label htmlFor="zone">Zone</label>
    <MenuSelect id="zone" name="zone_id" value={zone} onChange={(event) => setZone(event.target.value)}>
      <option value="">Unknown / not provided</option>
      <option value="a-block">A Block</option>
      <option value="technology-tower">Technology Tower</option>
      <option value="retired" disabled>Retired location</option>
    </MenuSelect>
    <button type="submit">Submit</button>
  </form>;
}

describe("shadcn option menus", () => {
  it("selects a campus location without submitting the form and preserves its form value", async () => {
    const user = userEvent.setup();
    const submitted = vi.fn();
    render(<LocationForm onSubmit={submitted} />);
    const trigger = screen.getByRole("combobox", { name: "Zone" });
    await chooseOption(user, trigger, "technology-tower");
    expect(trigger).toHaveTextContent("Technology Tower");
    expect(submitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted.mock.calls[0]?.[0].get("zone_id")).toBe("technology-tower");
    await chooseOption(user, trigger, "");
    expect(trigger).toHaveTextContent("Unknown / not provided");
  });

  it("retains a selected identity when a background update removes its option", async () => {
    const changed = vi.fn();
    const view = render(<MenuSelect aria-label="Destination" value="target" onChange={changed}><option value="target">Target group</option></MenuSelect>);
    view.rerender(<MenuSelect aria-label="Destination" value="target" onChange={changed}><option value="other">Other group</option></MenuSelect>);
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveValue("target");
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveTextContent("Unavailable selection");
    expect(changed).not.toHaveBeenCalled();
  });

  it("supports keyboard navigation, disabled choices, Escape, and focus return", async () => {
    const user = userEvent.setup();
    render(<LocationForm onSubmit={() => {}} />);
    const trigger = screen.getByRole("combobox", { name: "Zone" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Retired location" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("Unknown / not provided");
  });
});
