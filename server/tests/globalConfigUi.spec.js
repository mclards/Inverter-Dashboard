"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, _electron: electron } = require("playwright/test");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ELECTRON_EXE = path.join(
  REPO_ROOT,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const LAUNCH_ENV = { ...process.env };
delete LAUNCH_ENV.ELECTRON_RUN_AS_NODE;

async function waitForWindow(electronApp, urlFragment, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of electronApp.windows()) {
      try {
        if (String(page.url() || "").includes(urlFragment)) return page;
      } catch (_) {
        // Window may be navigating or closing; retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Electron window containing ${urlFragment}`);
}

test.describe("Global Configuration window", () => {
  test.setTimeout(120000);

  test("renders every settings tab with live values", async () => {
    expect(fs.existsSync(ELECTRON_EXE)).toBeTruthy();
    const electronApp = await electron.launch({
      executablePath: ELECTRON_EXE,
      args: [REPO_ROOT],
      cwd: REPO_ROOT,
      env: { ...LAUNCH_ENV, ELECTRON_ENABLE_LOGGING: "1" },
    });

    try {
      const loginWindow = await electronApp.firstWindow();
      await loginWindow.waitForLoadState("domcontentloaded");
      await loginWindow.evaluate(() => window.loginAPI.loginSuccess());

      const mainWindow = await waitForWindow(electronApp, "localhost:3500");
      await mainWindow.waitForLoadState("domcontentloaded");
      await mainWindow.evaluate(() => window.electronAPI.openIpConfigWindow());

      const configWindow = await waitForWindow(electronApp, "global-config.html");
      await configWindow.waitForLoadState("domcontentloaded");
      await configWindow.evaluate(() => {
        sessionStorage.setItem("adsi_auth_until", String(Date.now() + 60000));
      });
      await configWindow.reload({ waitUntil: "domcontentloaded" });

      await expect(configWindow.locator("#auth-gate")).toBeHidden();
      await expect(configWindow.locator("#inverterGrid .inv-card")).toHaveCount(27, {
        timeout: 30000,
      });
      await expect(configWindow.locator(".tabs .tab-btn")).toHaveCount(4);

      const cases = [
        ["tab-plant", "#set_plantName"],
        ["tab-hardware", "#set_inverterClockAutoSyncAt"],
        ["tab-connectivity", "#set_operationMode"],
      ];
      await expect(configWindow.locator("#tab-system")).toHaveCount(0);
      await expect(configWindow.getByRole("button", { name: "System & License" })).toHaveCount(0);
      const visualDir = path.join(REPO_ROOT, ".tmp");
      fs.mkdirSync(visualDir, { recursive: true });
      for (const [tabId, representative] of cases) {
        await configWindow.locator(`[onclick*="${tabId}"]`).click();
        await expect(configWindow.locator(`#${tabId}`)).toBeVisible();
        await expect(configWindow.locator(representative)).toBeVisible();
        await configWindow.screenshot({
          path: path.join(visualDir, `global-config-${tabId.slice(4)}.png`),
        });
      }

      await configWindow.locator('[onclick*="tab-plant"]').click();
      await expect(configWindow.locator("#set_plantName")).not.toHaveValue("");
      await expect(configWindow.locator("#set_apiUrl")).not.toHaveValue("");
      await expect(configWindow.locator("#set_inverterClockAutoSyncAt")).not.toHaveValue("");
      await expect(configWindow.locator("#saveAllBtn")).toBeVisible();

      // Exercise the global save coordinator without mutating the workstation:
      // intercept the POST after the live GET has populated the form.
      let savedPayload = null;
      await configWindow.route("**/api/settings", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        savedPayload = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, settings: savedPayload }),
        });
      });
      await configWindow.locator("#set_operatorName").fill("UI SMOKE OPERATOR");
      await configWindow.locator("#saveAllBtn").click();
      await expect(configWindow.locator("#statusText")).toContainText(
        "All pending global configuration changes were saved",
      );
      expect(savedPayload?.operatorName).toBe("UI SMOKE OPERATOR");
      expect(savedPayload?.remoteAutoSync).toEqual(expect.any(Boolean));
      expect(savedPayload?.inverterClockAutoSyncEnabled).toMatch(/^[01]$/);
      await configWindow.unroute("**/api/settings");

      const actionBarBounds = await configWindow.locator(".actionbar").evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
      });
      expect(actionBarBounds.top).toBeGreaterThanOrEqual(0);
      expect(actionBarBounds.bottom).toBeLessThanOrEqual(actionBarBounds.viewportHeight);
      await configWindow.locator("#themeToggle").click();
      await expect(configWindow.locator("html")).not.toHaveClass(/\bdark\b/);
      await expect(configWindow.locator("#tab-plant .settings-card").first()).toBeVisible();
      await configWindow.locator("#themeToggle").click();
      await expect(configWindow.locator("html")).toHaveClass(/\bdark\b/);
    } finally {
      await electronApp.close();
    }
  });
});
