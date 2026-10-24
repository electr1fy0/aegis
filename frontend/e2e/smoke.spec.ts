import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("demo replay, human review, report intake, and measured evaluation", async ({ page }) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Situation overview" })).toBeVisible();

  await page.getByLabel("Replay scenario").selectOption("demo");
  await page.getByRole("button", { name: "Start replay" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Replay step 0 of 24" })).toBeVisible();

  for (let step = 1; step <= 24; step += 1) {
    await page.getByRole("button", { name: "Next report" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Replay step ${step} of 24` })).toBeVisible();
  }

  const reportsCount = page.locator(".summary-card").filter({ hasText: "Reports received" }).locator(".summary-value");
  const groupsCount = page.locator(".summary-card").filter({ hasText: "Provisional groups" }).locator(".summary-value");
  const conflictsCount = page.locator(".summary-card").filter({ hasText: "Unresolved conflicts" }).locator(".summary-value");
  await expect(reportsCount).toHaveText("24");
  await expect(groupsCount).toHaveText("8");
  await expect(conflictsCount).toHaveText(/^[1-9]\d*$/);

  const conflictGroup = page.locator(".incident-row").filter({ hasText: "Conflict" }).first();
  await expect(conflictGroup).toBeVisible();
  await conflictGroup.locator(".incident-row-main").click();
  await expect(page.getByRole("heading", { name: "Grouping evidence" })).toBeVisible();
  await expect(page.locator(".evidence-card").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Conflicting or changing reports" })).toBeVisible();

  const token = randomUUID();
  const reportText = `Synthetic browser smoke report ${token}: a labelled test card sits on the Food Court service counter.`;
  await page.getByRole("link", { name: "New report" }).click();
  await expect(page.getByRole("heading", { name: "New report" })).toBeVisible();
  await page.getByRole("textbox", { name: "Report description" }).fill(reportText);
  await page.getByLabel("Zone").selectOption("food");
  await page.getByLabel("Sublocation").fill("service counter");
  await page.getByLabel("Event time (optional)").fill(new Date().toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Submit report" }).click();

  const receipt = page.getByRole("status", { name: "Submission receipt" });
  await expect(receipt).toContainText("Report received");
  await expect(receipt).toContainText(reportText);
  const reportId = await receipt.locator(".receipt-copy").filter({ hasText: "Report ID" }).locator(".mono").innerText();
  expect(reportId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Situation overview" })).toBeVisible();
  const reportGroup = page.locator(".incident-row-main").filter({ hasText: `Synthetic browser smoke report ${token}` });
  await expect(reportGroup).toBeVisible();
  await reportGroup.click();
  await expect(page.locator(".source-report").filter({ hasText: reportText })).toBeVisible();

  await page.getByRole("button", { name: "Confirm grouping" }).click();
  const confirmationReason = `Confirmed synthetic intake ${token} during the browser smoke run.`;
  await page.getByRole("textbox", { name: "Coordinator reason" }).fill(confirmationReason);
  await page.getByRole("button", { name: "Save coordinator decision" }).click();

  const audit = page.getByRole("region", { name: "Coordinator audit" });
  await expect(audit.getByText(confirmationReason, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Evaluation" }).click();
  await expect(page.getByRole("heading", { name: "Evaluation" })).toBeVisible();
  await expect(page.getByText("Dataset version", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grouping results" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Measured report grouping results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Policy and retention checks" })).toBeVisible();
  await expect(page.getByText(/\d+ checks/)).toBeVisible();
  await expect(page.locator(".divide-y > li").first()).toBeVisible();
  expect(browserErrors).toEqual([]);
});
