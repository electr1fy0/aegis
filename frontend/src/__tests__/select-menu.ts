import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export async function chooseOption(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, value: string) {
  await user.click(trigger);
  const option = (await screen.findAllByRole("option")).find((item) => item.dataset["value"] === value);
  if (!option) throw new Error(`Option ${value} was not found`);
  await user.click(option);
}

export async function filterControl(name: string) {
  const existing = screen.queryByRole("combobox", { name });
  if (existing) return existing;
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  return screen.findByRole("combobox", { name });
}
