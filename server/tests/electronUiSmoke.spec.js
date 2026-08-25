"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, _electron: electron } = require("playwright/test");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PACKAGED_ELECTRON_EXE = String(process.env.ADSI_PACKAGED_ELECTRON_EXE || "").trim();
const ELECTRON_EXE = PACKAGED_ELECTRON_EXE || (
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron")
);
const ELECTRON_ARGS = PACKAGED_ELECTRON_EXE ? [] : [REPO_ROOT];
const REQUIRE_NATIVE_VIDEO = process.env.ADSI_REQUIRE_NATIVE_VIDEO === "1";
const ARTIFACT_DIR = path.join(REPO_ROOT, "server", "tests", "artifacts");
const LAUNCH_ENV = { ...process.env };
delete LAUNCH_ENV.ELECTRON_RUN_AS_NODE;

async function waitForWindow(electronApp, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastUrls = [];
  while (Date.now() < deadline) {
    const windows = electronApp.windows();
    lastUrls = [];
    for (const page of windows) {
      try {
        const url = String(page.url() || "");
        lastUrls.push(url);
        if (await predicate(page, url)) return page;
      } catch (_) {
        // Window may still be initializing; retry until timeout.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for target window. Last URLs: ${lastUrls.join(", ")}`);
}

test.describe("Electron UI smoke", () => {
  test.setTimeout(120000);

  test("dashboard, export, and connectivity surfaces render in Electron", async () => {
    expect(fs.existsSync(ELECTRON_EXE)).toBeTruthy();
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

    const electronApp = await electron.launch({
      executablePath: ELECTRON_EXE,
      args: ELECTRON_ARGS,
      cwd: REPO_ROOT,
      env: {
        ...LAUNCH_ENV,
        ELECTRON_ENABLE_LOGGING: "1",
      },
    });

    try {
      const loginWindow = await electronApp.firstWindow();
      await loginWindow.waitForLoadState("domcontentloaded");

      // Reuse the existing preload IPC instead of assuming workstation credentials.
      await loginWindow.evaluate(() => window.loginAPI.loginSuccess());

      const mainWindow = await waitForWindow(
        electronApp,
        async (page, url) => {
          if (!url.startsWith("http://localhost:3500")) return false;
          await page.waitForLoadState("domcontentloaded");
          return true;
        },
        60000,
      );

      await expect(mainWindow.locator("#totalPac")).toBeVisible();
      await expect(mainWindow.locator("#totalKwh")).toBeVisible();
      await expect(mainWindow.locator("#totalPac")).not.toHaveText(/^\s*[—-]?\s*$/);
      await expect(mainWindow.locator("#totalKwh")).not.toHaveText(/^\s*[—-]?\s*$/);

      const tapoCard = mainWindow.locator("#cameraCard");
      await expect(tapoCard).toBeVisible({ timeout: 30000 });
      await expect(mainWindow.locator("#btnCamPopout")).toHaveCount(0);
      await expect(mainWindow.locator("#btnCamFullscreen")).toBeVisible();
      await mainWindow.locator("#btnCamFullscreen").click();
      const tapoViewer = await waitForWindow(
        electronApp,
        async (page, url) => {
          if (!url.includes("popout=camera")) return false;
          await page.waitForLoadState("domcontentloaded");
          return true;
        },
        30000,
      );
      await expect(tapoViewer).toHaveTitle("ADSI – Tapo Camera Viewer");
      const tapoWindowState = await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("popout=camera"),
        );
        if (!win) return null;
        win.setSize(480, 300);
        return {
          fullscreen: win.isFullScreen(),
          maximized: win.isMaximized(),
          resizable: win.isResizable(),
          minimizable: win.isMinimizable(),
          maximizable: win.isMaximizable(),
          minimumSize: win.getMinimumSize(),
        };
      });
      expect(tapoWindowState).toEqual({
        fullscreen: false,
        maximized: false,
        resizable: true,
        minimizable: true,
        maximizable: true,
        minimumSize: [480, 300],
      });
      await expect(tapoViewer.locator("#page-camera")).toBeVisible({ timeout: 30000 });
      await expect(tapoViewer.locator("#cameraCard")).toBeVisible();
      await expect(tapoViewer.locator("#btnCamFullscreen")).toBeHidden();
      await expect(tapoViewer.locator("#camLabel")).toBeHidden();
      await expect(tapoViewer.locator("#camLiveDot")).toBeHidden();
      await expect(tapoViewer.locator("#camControls")).toBeHidden();
      await expect(tapoViewer.locator("#cameraOverlay")).toBeHidden();
      await expect(tapoViewer.locator("#chatBubble")).toBeHidden();
      await expect(tapoViewer.locator("#alarmToast")).toBeHidden();
      await tapoViewer.waitForTimeout(500);
      const tapoLayout = await tapoViewer.evaluate(() => {
        const card = document.getElementById("cameraCard").getBoundingClientRect();
        return {
          top: card.top,
          left: card.left,
          width: card.width,
          height: card.height,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        };
      });
      expect(tapoLayout.top).toBeLessThanOrEqual(1);
      expect(tapoLayout.left).toBeLessThanOrEqual(1);
      expect(tapoLayout.width).toBeGreaterThanOrEqual(tapoLayout.viewportWidth - 1);
      expect(tapoLayout.height).toBeGreaterThanOrEqual(tapoLayout.viewportHeight - 1);
      await tapoViewer.close();
      await expect.poll(
        () => electronApp.windows().filter((page) => page.url().includes("popout=camera")).length,
        { timeout: 15000 },
      ).toBe(0);

      const hikvisionCard = mainWindow.locator("#hikvisionCard");
      await expect(hikvisionCard).toBeVisible({ timeout: 30000 });
      await expect(mainWindow.locator("#btnHikvisionSettings")).toBeVisible();
      await expect(mainWindow.locator("#btnHikvisionPopout")).toHaveCount(0);
      await expect(mainWindow.locator("#btnHikvisionNativeViewer")).toBeVisible();
      await expect(hikvisionCard).toHaveCount(1);
      await expect(hikvisionCard.locator(".cam-controls .cam-ctrl-btn")).toHaveCount(2);

      await mainWindow.locator("#btnHikvisionNativeViewer").click();
      const nativeViewer = await waitForWindow(
        electronApp,
        async (page, url) => {
          if (!url.includes("hikvision-native-viewer.html")) return false;
          await page.waitForLoadState("domcontentloaded");
          return true;
        },
        30000,
      );
      await expect(nativeViewer).toHaveTitle("ADSI – Hikvision Native Viewer");
      const nativeWindowState = await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("hikvision-native-viewer.html"),
        );
        return win ? {
          fullscreen: win.isFullScreen(),
          resizable: win.isResizable(),
          minimizable: win.isMinimizable(),
          maximizable: win.isMaximizable(),
          minimumSize: win.getMinimumSize(),
        } : null;
      });
      expect(nativeWindowState).toEqual({
        fullscreen: false,
        resizable: true,
        minimizable: true,
        maximizable: true,
        minimumSize: [480, 300],
      });
      await expect(nativeViewer.locator("#nativeSurface")).toBeVisible();
      await expect(nativeViewer.locator("#nativeExit")).toHaveCount(0);
      const nativeLayout = await nativeViewer.evaluate(() => {
        const surface = document.getElementById("nativeSurface").getBoundingClientRect();
        return {
          surfaceTop: surface.top,
          surfaceLeft: surface.left,
          surfaceWidth: surface.width,
          surfaceHeight: surface.height,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        };
      });
      expect(nativeLayout.surfaceTop).toBeLessThanOrEqual(1);
      expect(nativeLayout.surfaceLeft).toBeLessThanOrEqual(1);
      expect(nativeLayout.surfaceWidth).toBeGreaterThanOrEqual(nativeLayout.viewportWidth - 1);
      expect(nativeLayout.surfaceHeight).toBeGreaterThanOrEqual(nativeLayout.viewportHeight - 1);
      expect(nativeLayout.surfaceHeight).toBeGreaterThan(100);
      if (REQUIRE_NATIVE_VIDEO) {
        await expect.poll(
          async () => nativeViewer.evaluate(() => window.electronAPI?.hikvisionNativeStatus?.()),
          { timeout: 30000 },
        ).toMatchObject({ running: true, visible: true, connected: true });
        const nativeVideoStatus = await nativeViewer.evaluate(() => window.electronAPI.hikvisionNativeStatus());
        expect(nativeVideoStatus.width).toBeGreaterThan(0);
        expect(nativeVideoStatus.height).toBeGreaterThan(0);
      }
      await nativeViewer.close();
      await expect.poll(
        () => electronApp.windows().filter((page) => page.url().includes("hikvision-native-viewer.html")).length,
        { timeout: 15000 },
      ).toBe(0);

      await mainWindow.locator("#btnHikvisionSettings").click();
      await expect(mainWindow.locator("#hikSettingsModal")).toBeVisible();
      const hikOperationMode = await mainWindow.locator("#hikOperationBadge").getAttribute("data-mode");
      expect(["gateway", "remote"]).toContain(hikOperationMode);
      await expect(mainWindow.locator("#hikOperationBadge")).toHaveText(
        hikOperationMode === "remote" ? "Remote mode" : "Gateway mode",
      );
      await expect(mainWindow.locator("#hikOperationBanner")).toHaveAttribute("data-mode", hikOperationMode);
      await expect(mainWindow.locator("#hikOperationTitle")).toHaveText(
        hikOperationMode === "remote" ? "Remote camera viewer" : "Gateway camera host",
      );
      if (hikOperationMode === "remote") {
        await expect(mainWindow.locator("#hikServiceTitle")).toHaveText(
          /^(Gateway Relay Playback|Workstation Direct Playback|Remote Camera Route Unavailable)$/,
        );
      } else {
        await expect(mainWindow.locator("#hikServiceTitle")).toHaveText("Gateway Hikvision Playback");
      }
      await expect(mainWindow.locator("#hikRoutePanel")).toBeVisible();
      await expect(mainWindow.locator("#hikCompactPath")).not.toHaveText("Checking...", { timeout: 15000 });
      await expect(mainWindow.locator("#btnHikRouteCheck")).toBeVisible();
      await mainWindow.locator("#btnHikModalClose").click();
      await expect(mainWindow.locator("#hikSettingsModal")).toBeHidden();

      await mainWindow.selectOption("#invFilter", "1");
      await expect(mainWindow.locator("#invDetailPanel")).toBeVisible();
      await expect
        .poll(
          async () => String((await mainWindow.locator("#invDetailStats").textContent()) || "").trim(),
          { timeout: 30000 },
        )
        .not.toContain("Loading");
      await expect(mainWindow.locator("#invDetailStats")).toContainText("Today Energy", {
        timeout: 30000,
      });
      await expect(mainWindow.locator("#invDetailStats")).toContainText("DC Power", {
        timeout: 30000,
      });

      await mainWindow.locator('[data-page="export"]').evaluate((el) => el.click());
      await expect(mainWindow.locator("#page-export")).toBeVisible();
      await expect(hikvisionCard).not.toHaveClass(/is-floating/);
      await expect(hikvisionCard).not.toBeVisible();
      await expect(hikvisionCard).toHaveCount(1);
      await expect(mainWindow.locator("#hikvisionVideo")).toBeHidden();
      await expect(mainWindow.locator("#expEnergyDate")).toBeVisible();
      await expect(
        mainWindow.locator('#page-export input[type="date"][id^="expEnergy"]'),
      ).toHaveCount(1);
      await expect(mainWindow.locator("#expEnergyStart")).toHaveCount(0);
      await expect(mainWindow.locator("#expEnergyEnd")).toHaveCount(0);

      await mainWindow.locator('[data-page="forecast"]').evaluate((el) => el.click());
      await expect(mainWindow.locator("#page-forecast")).toBeVisible();
      await mainWindow.locator('#fcTabTuning').evaluate((el) => el.click());
      const nowcastMode = mainWindow.locator("#setForecastVirtualNowcastMode");
      await expect(nowcastMode).toBeVisible();
      await expect(nowcastMode.locator("option")).toHaveCount(3);
      await expect(nowcastMode).toHaveValue(/^(off|shadow|active)$/);

      await mainWindow.locator('[data-page="inverters"]').evaluate((el) => el.click());
      await expect(mainWindow.locator("#page-inverters")).toBeVisible();
      await expect(hikvisionCard).toBeVisible();
      await expect(hikvisionCard).not.toHaveAttribute("hidden", "");

      await mainWindow.locator('[data-page="settings"]').evaluate((el) => el.click());
      await mainWindow
        .locator('[data-settings-section="connectivitySection"]')
        .evaluate((el) => el.click());
      // Replication-health UI (#repConnectedVal / refresh) lives under the
      // connectivity "Gateway Link" card tab in the settings-section-registry
      // card-tab layout — selecting the section alone leaves it hidden, so
      // activate the Link tab before asserting visibility.
      await mainWindow
        .locator('#connectivitySection .card-tab[data-card-tab="link"]')
        .evaluate((el) => el.click());
      await expect(mainWindow.locator("#repConnectedVal")).toBeVisible();
      await mainWindow.locator("#btnRefreshReplicationHealth").click();
      await expect
        .poll(
          async () => String((await mainWindow.locator("#repConnectedVal").textContent()) || "").trim(),
          { timeout: 20000 },
        )
        .not.toBe("—");

      await mainWindow.screenshot({
        path: path.join(ARTIFACT_DIR, "electron-ui-smoke.png"),
        fullPage: true,
      });
    } finally {
      await electronApp.close().catch(() => {});
    }
  });
});
