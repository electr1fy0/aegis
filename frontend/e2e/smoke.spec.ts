import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("demo replay, human review, report intake, and measured evaluation", async ({ page }) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Situation overview" })).toBeVisible();

  await page.locator(".replay-menu > summary").click();
  await page.getByLabel("Synthetic scenario").selectOption("demo");
  await page.getByRole("button", { name: "Start replay" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Step 0 of 24" })).toBeVisible();

  for (let step = 1; step <= 24; step += 1) {
    await page.getByRole("button", { name: "Next report" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Step ${step} of 24` })).toBeVisible();
  }

  const reportsCount = page.locator(".summary-card").filter({ hasText: "Reports received" }).locator(".summary-value");
  const groupsCount = page.locator(".summary-card").filter({ hasText: "Provisional groups" }).locator(".summary-value");
  const conflictsCount = page.locator(".summary-card").filter({ hasText: "Unresolved conflicts" }).locator(".summary-value");
  await expect(reportsCount).toHaveText("24");
  await expect(groupsCount).toHaveText("8");
  await expect(conflictsCount).toHaveText(/^[1-9]\d*$/);
  const rowsContainTheirContent = await page.locator(".incident-row").evaluateAll((rows) => rows.every((row) => {
    const button = row.querySelector(".incident-row-main")!;
    return button.getBoundingClientRect().bottom <= row.getBoundingClientRect().bottom;
  }));
  expect(rowsContainTheirContent).toBeTruthy();

  const conflictGroup = page.locator(".incident-row").filter({ hasText: "Conflict" }).first();
  await expect(conflictGroup).toBeVisible();
  await conflictGroup.locator(".incident-row-main").click();
  await page.locator(".inspector-disclosure").filter({ has: page.getByRole("heading", { name: "Grouping evidence" }) }).locator("summary").click();
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
  await page.getByRole("radio", { name: /Just observed/ }).check();
  await page.getByRole("button", { name: "Submit report" }).click();

  const receipt = page.getByRole("status", { name: "Submission receipt" });
  await expect(receipt).toContainText("Report received");
  await expect(receipt).toContainText(reportText);
  const reportId = await receipt.locator(".receipt-copy").filter({ hasText: "Report ID" }).locator(".mono").getAttribute("title");
  expect(reportId).not.toBeNull();
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

  await page.locator(".audit-section > summary").click();
  const audit = page.getByRole("region", { name: "Coordinator audit" });
  await expect(audit.getByText(confirmationReason, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Evaluation" }).click();
  await expect(page.getByRole("heading", { name: "Evaluation" })).toBeVisible();
  await expect(page.getByText("Dataset version", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grouping results" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Measured report grouping results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Policy and retention checks" })).toBeVisible();
  const policyChecks = page.getByRole("region", { name: "Policy and retention checks" });
  await expect(policyChecks.getByRole("listitem")).toHaveCount(6);
  await expect(policyChecks.getByText("Passed", { exact: true })).toHaveCount(6);
  expect(browserErrors).toEqual([]);
});

test("draft recovery, linked receipts, audited edits, undo, history, and export", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  const started = await page.request.post("/api/demo/session", { data: { scenario: "edge" } });
  expect(started.ok()).toBeTruthy();
  const initial = await started.json();
  const eventId = initial.event.id as string;
  const token = randomUUID();
  const text = `Synthetic ${token}: a visitor is unconscious beside the exhibition hall inner doorway.`;
  await page.goto(`/report?event=${eventId}`);
  await page.getByRole("textbox", { name: "Report description" }).fill(text);
  await page.getByLabel("Zone", { exact: true }).selectOption("hall");
  await page.getByLabel("Sublocation (optional)", { exact: true }).fill("inner doorway");
  await page.getByRole("radio", { name: /Just observed/ }).check();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Report description" })).toHaveValue(text);
  await expect(page.getByRole("radio", { name: /Just observed/ })).toBeChecked();
  await page.getByRole("button", { name: "Submit report", exact: true }).click();
  const receipt = page.getByRole("status", { name: "Submission receipt" });
  await expect(receipt).toContainText("Report received");
  const reportId = await receipt.locator(".receipt-copy").filter({ hasText: "Report ID" }).locator(".mono").getAttribute("title");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Report description" })).toHaveValue("");
  await page.getByRole("link", { name: "Open this incident on the operations board" }).click();
  await expect(page.locator(".source-report").filter({ hasText: text })).toBeVisible();
  const incidentId = new URL(page.url()).searchParams.get("incident");
  expect(incidentId).toBeTruthy();

  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await page.getByRole("textbox", { name: "Incident title", exact: true }).fill("Exhibition hall observation");
  await page.getByRole("textbox", { name: "Reason for title change" }).fill("Use a concise description of the recorded observation.");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Exhibition hall observation", exact: true })).toBeVisible();
  const note = "=This is a source-preserving synthetic coordinator note";
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.getByRole("textbox", { name: "Add a coordinator note" }).fill(note);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-list")).toContainText(note);

  await page.getByRole("button", { name: "Override priority", exact: true }).click();
  await page.getByLabel("Coordinator priority override").selectOption("P2");
  await page.locator(".action-form").filter({ has: page.getByLabel("Coordinator priority override") }).getByRole("textbox", { name: "Reason", exact: true }).fill("Demonstrate a reversible synthetic review decision.");
  await page.getByRole("button", { name: "Save priority", exact: true }).click();
  await page.getByRole("button", { name: "Reset to suggested priority" }).click();
  await page.getByRole("textbox", { name: /Reason for returning to P0/ }).fill("Resume the explicit exercise policy.");
  await page.getByRole("button", { name: "Reset priority", exact: true }).click();
  await page.getByRole("button", { name: /Undo last Incident.priority.reset/i }).click();
  await page.locator(".action-form").filter({ has: page.getByRole("button", { name: "Save undo", exact: true }) }).getByRole("textbox", { name: "Reason", exact: true }).fill("Verify the compensating undo audit.");
  await page.getByRole("button", { name: "Save undo", exact: true }).click();
  await expect(page.getByText("The last eligible decision was undone.", { exact: true })).toBeVisible();

  await page.locator(".export-menu > summary").click();
  const downloadPending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloadPending;
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain(reportId!);
  expect(csv).toContain("Exhibition hall observation");
  expect(csv).toContain("'=This is a source-preserving");

  const next = await page.request.post("/api/demo/session", { data: { scenario: "busy" } });
  const nextId = (await next.json()).event.id as string;
  await page.goto(`/dashboard?event=${nextId}`);
  await page.getByLabel("Exercise", { exact: true }).selectOption(eventId);
  await expect(page.locator(".incident-row-main").filter({ hasText: "Exhibition hall observation" })).toBeVisible();
  await page.getByLabel("Settings and information").click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBeFalsy();
  expect(browserErrors).toEqual([]);
});
