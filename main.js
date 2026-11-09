/* Fold Magic: fixes for Obsidian on foldable phones.
 * Made by Tailnet 4 in 2026 (written by Big Len, the team's Claude Code). Plain JS, no build step.
 *
 * 1. Stuck layout: Obsidian decides phone vs tablet with one media query and skips the check
 *    while it thinks the keyboard is up, so a fold at the wrong moment can leave the old layout.
 *    After every screen change we re-check (mode + real geometry), fix the mode, nudge the
 *    workspace, and if it's still wrong offer a one-tap reload (or reload by itself).
 * 2. Android status bar: hide/show toggle + optional auto-hide, shared with Day Peek.
 * 3. Sidebar (drawer) widths, separate for folded and unfolded.
 * Does nothing on desktop. Disabling/updating puts everything back to stock.
 */
const { Plugin, Platform, Notice, PluginSettingTab, Setting, normalizePath, moment } = require("obsidian");
const FIX_ICON = "wand-sparkles";

const DEFAULTS = {
  stuckFix: "stuck",            // 0.3.0: off | stuck (Fix layout button when stuck) | always (button always) | reload
  closeDrawersOnFold: true,
  statusBarAuto: "off",         // off | always | unfolded | folded
  foldedWidth: "", foldedMaxWidth: "",
  unfoldedWidth: "", unfoldedMaxWidth: "", unfoldedPinnedWidth: "",
  foldedFontSize: "", unfoldedFontSize: "",   // 0.2.0: note text size per fold state ("" = Obsidian's)
  logChanges: false,
  logPath: "Fold Magic log.md",
};
const TABLET_MQ = "(min-width: 600px) and (min-height: 600px)";   // Obsidian's own phone/tablet rule
const WIDTH_VARS = ["--mobile-sidebar-width", "--mobile-sidebar-max-width", "--mobile-sidebar-width-pinned"];
const STOCK = { "--mobile-sidebar-width": "84vw", "--mobile-sidebar-max-width": "450px", "--mobile-sidebar-width-pinned": "350px" };
const SETTLE_MS = 800;           // wait this long after the last resize before checking
const AUTO_RELOAD_GAP_MS = 5 * 60 * 1000;   // review: at most one automatic reload per 5 minutes
const AUTO_RELOAD_KEY = "fold-magic-last-auto-reload";
const sleep = (ms) => new Promise((ok) => window.setTimeout(ok, ms));

// ---- Shared with Day Peek: one keeper of Android's status bar for all Tailnet 4 plugins ----
// Each plugin says what it wants ("hidden" or not); the bar is hidden if anyone wants it hidden,
// unless the user toggled it by hand. A hand toggle lasts until something changes (a plugin's
// wish changes, or the phone is folded/unfolded). Same code in both plugins; newest version wins.
function statusBarHub() {
  const VERSION = 1;
  let hub = window.__tailnet4StatusBar;
  if (hub && hub.version >= VERSION) return hub;
  const old = hub || {};
  hub = {
    version: VERSION,
    owners: old.owners || new Set(),
    wants: old.wants || new Map(),
    manual: old.manual === undefined ? null : old.manual,   // null = automatic, true/false = toggled by hand
    touched: !!old.touched,                                 // did one of us ever hide it?
    api() {
      const cap = window.Capacitor;
      if (cap && cap.isPluginAvailable && cap.getPlatform && cap.getPlatform() === "android" && cap.isPluginAvailable("StatusBar")) return cap.Plugins.StatusBar;
      return window.__tailnet4FakeStatusBar || null;      // only set by tests
    },
    join(owner) { this.owners.add(owner); },
    leave(owner) {
      this.owners.delete(owner); this.wants.delete(owner);
      if (!this.owners.size) this.manual = null;            // last plugin gone: back to stock
      this.apply();
    },
    want(owner, hidden) {
      const before = this.wants.has(owner);
      if (hidden) this.wants.set(owner, true); else this.wants.delete(owner);
      if (before !== !!hidden) this.manual = null;          // something changed: back to automatic
      this.apply();
    },
    hidden() { return this.manual !== null ? this.manual : this.wants.size > 0; },
    toggle() { this.manual = !this.hidden(); this.apply(); return this.manual; },
    automatic() { this.manual = null; this.apply(); },
    apply() {
      const sb = this.api();
      if (!sb) return;
      const h = this.hidden();
      if (!h && !this.touched) return;                      // never hid it: leave it alone
      if (h) this.touched = true;
      // Not cached on purpose: Android shows the bar again on a swipe, so re-applying is the point.
      Promise.resolve(h ? sb.hide({ animation: "FADE" }) : sb.show({ animation: "FADE" })).catch(() => {});
    },
  };
  window.__tailnet4StatusBar = hub;
  return hub;
}

module.exports = class FoldMagicPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, saved);
    // 0.3.0: stuckAction + fixButton merged into stuckFix
    if (saved.stuckFix === undefined && (saved.stuckAction !== undefined || saved.fixButton !== undefined)) {
      const a = saved.stuckAction || "notice", b = saved.fixButton || "stuck";
      this.settings.stuckFix = a === "reload" ? "reload" : b === "always" ? "always" : a === "off" || b === "never" ? "off" : "stuck";
    }
    const migrated = "stuckAction" in this.settings || "fixButton" in this.settings;
    delete this.settings.stuckAction; delete this.settings.fixButton;
    if (!["off", "stuck", "always", "reload"].includes(this.settings.stuckFix)) this.settings.stuckFix = "stuck";
    if (migrated) await this.saveData(this.settings);       // tidy old keys out of data.json once
    this.addSettingTab(new FoldMagicSettings(this.app, this));
    this.active = Platform.isMobileApp || !!window.__foldMagicTest;
    if (!this.active) return;                               // desktop: do nothing at all

    this.mq = window.matchMedia(TABLET_MQ);
    this.unfolded = this.mq.matches;
    this.hub = statusBarHub();
    this.hub.join("fold-magic");

    this.addCommand({ id: "toggle-status-bar", name: "Toggle Android status bar", callback: () => this.toggleStatusBar() });
    this.addCommand({ id: "status-bar-auto", name: "Status bar back to automatic", callback: () => { this.hub.automatic(); new Notice("Fold Magic: status bar is automatic again", 2000); } });
    this.addCommand({ id: "fix-layout", name: "Fix layout now", callback: () => this.fixNow() });
    this.addCommand({ id: "snapshot", name: "Save a layout snapshot (for bug reports)", callback: () => this.snapshot() });

    this.registerDomEvent(window, "resize", () => this.onResize());
    // Obsidian re-applies its own font size when you change it (Appearance, pinch-zoom): put ours back.
    this.registerEvent(this.app.workspace.on("css-change", () => { if (this.fontSet) this.applyFont(); }));
    // The stuck view shows up when you close a sidebar after a fold, which isn't a resize.
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.updateFixButtons();                              // new tabs get the button too
      if (Date.now() >= (this.ignoreUntil || 0)) this.scheduleCheck("layout");
    }));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) return;
      this.hub.apply();                                     // Android may have shown the bar meanwhile
      this.scheduleCheck("resume");
    });
    this.app.workspace.onLayoutReady(() => { this.applyAll(); this.updateFixButtons(); this.scheduleCheck("startup"); });
  }

  onunload() {
    window.clearTimeout(this.checkTimer);
    if (!this.active) return;
    this.hub.leave("fold-magic");                           // shows the bar unless Day Peek still wants it hidden
    for (const v of WIDTH_VARS) document.body.style.removeProperty(v);
    if (this.fontSet) this.restoreFont();                   // Obsidian's own font size back
    // Day Peek has its own (simpler) width setting that steps aside while we're on: let it take over again.
    window.setTimeout(() => { const dp = this.app.plugins.plugins["day-peek"]; if (dp && dp.applyWidth) dp.applyWidth(); }, 0);
    this.stuckNow = false; this.active = false; this.updateFixButtonsOff();
  }

  updateFixButtonsOff() {
    this.app.workspace.iterateAllLeaves((leaf) => { const v = leaf.view; if (v && v.foldMagicFixEl) { v.foldMagicFixEl.remove(); v.foldMagicFixEl = null; } });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.active) { this.applyAll(); this.updateFixButtons(); }
  }

  // ---------- screen changes ----------
  onResize() {
    const unfolded = this.mq.matches;
    if (Date.now() < (this.ignoreUntil || 0) && unfolded === this.unfolded) return;   // our own nudge
    // On some phones the keyboard shrinks the window; that's not a fold. Decide once it's down.
    if (Platform.mobileSoftKeyboardVisible && unfolded !== this.unfolded) { this.scheduleCheck("keyboard"); return; }
    if (unfolded !== this.unfolded) {                       // folded <-> unfolded
      if (!this.changing) {
        this.changing = true;
        this.changeFrom = this.unfolded ? "unfolded" : "folded";
        if (this.settings.closeDrawersOnFold) this.closeDrawers();
      }
      this.unfolded = unfolded;
    }
    this.scheduleCheck(this.changing ? "fold" : "resize");
  }

  scheduleCheck(why) {
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => this.check(why), SETTLE_MS);
  }

  async check(why, tries = 0) {
    if (this.checking) { this.scheduleCheck(why); return; } // one check at a time
    // Obsidian itself won't switch phone/tablet while the keyboard is up, so wait for it too
    // (but not forever, in case the flag is stuck).
    if (Platform.mobileSoftKeyboardVisible && tries < 10) {
      this.checkTimer = window.setTimeout(() => this.check(why, tries + 1), SETTLE_MS);
      return;
    }
    this.checking = true;
    try { await this.runCheck(why); } finally { this.checking = false; }
  }

  async runCheck(why) {
    let folded = this.changing;
    this.changing = false;
    // A fold that happened while the keyboard was up (we waited it out) still counts as a fold.
    const nowUnfolded = this.mq.matches;
    if (!folded && nowUnfolded !== this.unfolded) {
      folded = true;
      this.changeFrom = this.unfolded ? "unfolded" : "folded";
      if (this.settings.closeDrawersOnFold) this.closeDrawers();
    }
    this.unfolded = nowUnfolded;
    if (folded) this.hub.manual = null;                    // a fold ends any hand toggle
    this.applyAll();

    let s = this.measure();
    const steps = [];
    if (s.modeMismatch && !this.modeFixBroken) {
      if (this.fixMode()) steps.push("fixed phone/tablet mode");
      else steps.push("couldn't fix phone/tablet mode (Obsidian refused it; not trying again)");
      await sleep(400); s = this.measure();
    }
    if (s.stuck && s.overlayOpen) {                           // stuck with a sidebar out: close it first
      this.closeDrawers(); steps.push("closed sidebars"); await sleep(500); s = this.measure();
    }
    if (s.stuck && !s.overlayOpen && this.unshove()) {
      steps.push("reset shoved main view"); await sleep(300); s = this.measure();
    }
    if (s.stuck) {
      this.nudge(); steps.push("nudged"); await sleep(600); s = this.measure();
      // Sidebars slide for a moment after a fold; look once more before calling it stuck.
      if (s.stuck) { await sleep(1500); s = this.measure(); }
      if (s.stuck) steps.push(await this.onStuck(folded));
    }
    if (!s.stuck) this.setStuck(false);                      // fixed itself meanwhile
    // Log folds and anything we had to fix; skip the many routine "layout" re-checks.
    if (this.settings.logChanges && (folded || steps.length || (why !== "layout" && why !== "resume"))) {
      await this.log(why + (folded ? ` (${this.changeFrom} → ${s.unfolded ? "unfolded" : "folded"})` : ""), s, steps.join(" + ") || "ok");
    }
    this.lastCheck = { why, state: s, steps };
  }

  measure() {
    const w = window.innerWidth, h = window.innerHeight;
    const unfolded = this.mq.matches;
    // Judge against the box Obsidian lays the workspace out in, not the raw screen: in landscape it
    // can be inset (camera cutout, navigation bar), which isn't "stuck".
    const boxEl = document.querySelector(".horizontal-main-container") || document.body;
    const br = boxEl.getBoundingClientRect();
    const bl = Math.round(br.left), bw = Math.round(br.width) || w;
    const body = document.body;
    const bodyTablet = body.classList.contains("is-tablet"), bodyPhone = body.classList.contains("is-phone");
    const modeMismatch = unfolded !== !!Platform.isTablet || bodyTablet !== unfolded || bodyPhone === unfolded;
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
    const ws = rect(".workspace"), root = rect(".workspace-split.mod-root");
    const drawers = Array.from(document.querySelectorAll(".workspace-drawer")).map((d) => {
      const r = d.getBoundingClientRect();
      return { side: d.classList.contains("mod-left") ? "L" : "R", pinned: d.classList.contains("is-pinned"),
        open: r.width > 0 && r.right > 1 && r.left < w - 1, w: Math.round(r.width) };
    });
    // While a sliding (overlay) sidebar is open, Obsidian shoves the main view aside on purpose,
    // so only judge when none is open. Then the main view must sit between the pinned sidebars
    // (if any) and fill the rest of the screen. The bug: it stays shoved aside / too narrow.
    // 0.1.1 (from the Fold log): the main view may only sit in its place, or be moved by EXACTLY the
    // width of an open sliding sidebar. The stuck runs had it moved by the folded sidebar's width
    // (346 px) while the unfolded one (525 px) was open, which 0.1.0 never judged.
    const pinW = (side) => drawers.filter((d) => d.side === side && d.pinned && d.open).reduce((a, d) => a + d.w, 0);
    const overlays = drawers.filter((d) => d.open && !d.pinned);
    const overlayOpen = overlays.length > 0;
    const filled = root ? root.w + pinW("L") + pinW("R") : bw;
    const shift = root ? root.l - bl - pinW("L") : 0;
    const okShifts = [0].concat(overlays.map((d) => (d.side === "L" ? d.w : -d.w)));
    const shiftOk = okShifts.some((x) => Math.abs(shift - x) <= 8);
    const widthOk = !root || Math.abs(root.w - (bw - pinW("L") - pinW("R"))) <= 8;
    const stuck = !!ws && (ws.w < bw * 0.9 || ws.l - bl > 8 || ws.r < bl + bw - 8 || !shiftOk || !widthOk);
    return { w, h, unfolded, tablet: !!Platform.isTablet, bodyTablet, keyboard: !!Platform.mobileSoftKeyboardVisible,
      box: { l: bl, w: bw }, ws, root, drawers, overlayOpen, filled, shift, modeMismatch, stuck };
  }

  // Same switch Obsidian does on a screen change. Platform isn't public API, so check it took;
  // if Obsidian ever makes it read-only, stop trying instead of nudging on every check.
  fixMode() {
    const t = this.mq.matches;
    try { Platform.isTablet = t; Platform.isPhone = !t; } catch (e) { /* read-only */ }
    document.body.classList.toggle("is-tablet", t);
    document.body.classList.toggle("is-phone", !t);
    this.nudge();
    const ok = !!Platform.isTablet === t && !!Platform.isPhone === !t;
    if (!ok) this.modeFixBroken = true;
    return ok;
  }

  // The bug itself: after a fold with a sidebar open, the main view keeps the inline
  // "slide aside" offset (transform: translateX(-…px)) although the sidebar is closed.
  unshove() {
    const root = document.querySelector(".workspace-split.mod-root");
    if (!root || !root.style.transform) return false;
    root.style.transform = "";
    return true;
  }

  nudge() {
    this.ignoreUntil = Date.now() + 400;
    try { this.app.workspace.trigger("resize"); } catch (e) { /* ignore */ }
    try { if (this.app.workspace.onLayoutChange) this.app.workspace.onLayoutChange(); } catch (e) { /* ignore */ }
    window.dispatchEvent(new Event("resize"));
  }

  closeDrawers() {
    const ws = this.app.workspace;
    for (const split of [ws.leftSplit, ws.rightSplit]) {
      try { if (split && !split.collapsed) split.collapse(); } catch (e) { /* ignore */ }
    }
  }

  async onStuck(folded) {
    const a = this.settings.stuckFix;
    if (a === "reload") {
      // A wrong "stuck" reading must never turn into a reload loop (the startup check after a reload
      // would see the same layout): only right after a real fold, and at most once per 5 minutes.
      let last = 0;
      try { last = Number(window.localStorage.getItem(AUTO_RELOAD_KEY)) || 0; } catch (e) { /* ignore */ }
      if (folded && Date.now() - last > AUTO_RELOAD_GAP_MS) {
        try { window.localStorage.setItem(AUTO_RELOAD_KEY, String(Date.now())); } catch (e) { /* ignore */ }
        return (await this.reload()) ? "reloaded" : "reload skipped (a note couldn't be saved)";
      }
      this.setStuck(true);
      return "showed Fix layout button (automatic reload only right after a fold, once per 5 min)";
    }
    if (a === "stuck" || a === "always") { this.setStuck(true); return "showed Fix layout button"; }
    return "still stuck (set to do nothing)";
  }

  // ---------- the Fix layout button (note header, left of the reading-view icon) ----------
  setStuck(on, quiet) {
    const was = this.stuckNow;
    this.stuckNow = on;
    this.updateFixButtons();
    if (on && !was && !quiet) new Notice("Fold Magic: layout stuck. Tap the ✨ wand in the note header to fix it.", 5000);
  }

  wantFixButton() {
    const m = this.settings.stuckFix;
    return m === "always" || ((m === "stuck" || m === "reload") && this.stuckNow);   // reload mode falls back to the button
  }

  updateFixButtons() {
    const want = this.active && this.wantFixButton();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!v || typeof v.addAction !== "function" || !v.actionsEl) return;
      if (want && !(v.foldMagicFixEl && v.foldMagicFixEl.isConnected)) {
        // addAction() puts the button first in the header's action row: left of the book icon
        v.foldMagicFixEl = v.addAction(FIX_ICON, "Fix layout (Fold Magic)", () => this.fixNow());
        v.foldMagicFixEl.addClass("fold-magic-fix");
        // Notes: sit right in front of the reading-view (book) button, even if other buttons come first.
        if (v.modeButtonEl && v.modeButtonEl.parentElement === v.actionsEl) v.actionsEl.insertBefore(v.foldMagicFixEl, v.modeButtonEl);
      }
      if (v.foldMagicFixEl) {
        if (!want) { v.foldMagicFixEl.remove(); v.foldMagicFixEl = null; }
        else v.foldMagicFixEl.toggleClass("is-stuck", !!this.stuckNow);
      }
    });
  }

  async fixNow() {
    this.closeDrawers();
    await sleep(400);
    this.unshove();
    this.fixMode();
    await sleep(500);
    const s = this.measure();
    if (s.stuck) { await this.reload(); return; }
    this.setStuck(false);
    new Notice("Fold Magic: layout fixed", 2000);
    if (this.settings.logChanges) await this.log("fix button", s, "fixed without reload");
  }

  // "Reload app without saving" doesn't wait for pending saves, so save everything that can be
  // saved first: notes, Canvas, Kanban, Excalidraw, Day Peek… If anything fails, don't reload.
  async saveAll() {
    const leaves = [];
    this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
    const failed = [];
    for (const leaf of leaves) {
      const v = leaf.view;
      if (!v) continue;
      try {
        if (typeof v.flush === "function") await v.flush();   // Day Peek's embedded editor
        if (typeof v.save === "function") await v.save();
      } catch (e) {
        failed.push((v.getDisplayText && v.getDisplayText()) || (v.getViewType && v.getViewType()) || "a view");
      }
    }
    return failed;
  }

  async reload() {
    const failed = await this.saveAll();
    if (failed.length) {
      new Notice(`Fold Magic: couldn't save ${failed.join(", ")}, so I didn't reload. Save or close it, then tap Fix layout again.`, 8000);
      this.setStuck(true, true);
      if (this.settings.logChanges) await this.log("reload", this.measure(), `not reloaded: couldn't save ${failed.join(", ")}`);
      return false;
    }
    if (this.settings.logChanges) await this.log("reload", this.measure(), "reloading");
    await sleep(300);
    let ok = false;
    try { ok = this.app.commands.executeCommandById("app:reload"); } catch (e) { ok = false; }
    if (!ok) {
      // Obsidian's command is just window.location.reload(); if it was ever renamed, do that directly.
      try { window.location.reload(); } catch (e) { new Notice("Fold Magic: couldn't reload Obsidian. Close and reopen the app.", 8000); return false; }
    }
    return true;
  }

  // ---------- status bar + widths ----------
  applyAll() { this.applyWidths(); this.applyFont(); this.applyStatusBar(); }

  // ---------- note font size (0.2.0) ----------
  // Obsidian puts your Appearance size on <body> as --font-text-size (app.updateFontSize()).
  // The inner screen has a lower pixel density, so the same size looks ~15% bigger unfolded.
  fontFor(unfolded) {
    const x = normalizeFontSize(unfolded ? this.settings.unfoldedFontSize : this.settings.foldedFontSize);
    return x && validFontSize(x) ? x : "";
  }

  applyFont() {
    const x = this.fontFor(this.mq.matches);
    if (x) {
      if (document.body.style.getPropertyValue("--font-text-size") !== x) document.body.style.setProperty("--font-text-size", x);
      this.fontSet = true;
    } else if (this.fontSet) {
      this.restoreFont();
    }
  }

  restoreFont() {
    this.fontSet = false;
    try { this.app.updateFontSize(); }                      // Obsidian re-applies its own size
    catch (e) { document.body.style.removeProperty("--font-text-size"); }
  }

  applyStatusBar() {
    const a = this.settings.statusBarAuto, u = this.mq.matches;
    this.hub.want("fold-magic", a === "always" || (a === "unfolded" && u) || (a === "folded" && !u));
  }

  toggleStatusBar() {
    if (!this.hub.api()) { new Notice("Fold Magic: Android's status bar can't be controlled here", 3000); return; }
    const hidden = this.hub.toggle();
    new Notice(`Fold Magic: status bar ${hidden ? "hidden" : "shown"} (until you fold or unfold, Day Peek changes what it wants, or you run this again)`, 2500);
  }

  applyWidths() {
    const s = this.settings, u = this.mq.matches;
    const vals = u ? [s.unfoldedWidth, s.unfoldedMaxWidth, s.unfoldedPinnedWidth] : [s.foldedWidth, s.foldedMaxWidth, ""];
    // 0.3.0: a width you type is the width: lift Obsidian's 450px cap unless an Advanced max width is set.
    const w = (vals[0] || "").trim();
    if (w && validLength(w, WIDTH_VARS[0]) && !(vals[1] || "").trim()) vals[1] = "none";
    WIDTH_VARS.forEach((v, i) => {
      const x = (vals[i] || "").trim();
      if (x && validLength(x, v)) document.body.style.setProperty(v, x);
      else document.body.style.removeProperty(v);
    });
  }

  // ---------- logging ----------
  describe(s) {
    const r = (x) => (x ? `${x.l}–${x.r}` : "none");
    const d = s.drawers.map((x) => `${x.side}:${x.open ? (x.pinned ? "pinned " : "open ") + x.w : "closed"}`).join(" ");
    return `${s.w}×${s.h} ${s.unfolded ? "unfolded" : "folded"} · mode ${s.tablet ? "tablet" : "phone"} (body ${s.bodyTablet ? "tablet" : "phone"}) · keyboard ${s.keyboard ? "up" : "down"} · workspace ${r(s.ws)} · main ${r(s.root)} (shift ${s.shift}) · drawers ${d || "none"}`;
  }

  async log(why, s, result) {
    const line = `- ${moment().format("YYYY-MM-DD HH:mm:ss")} · ${why} · ${this.describe(s)} · **${s.stuck ? "STUCK" : s.modeMismatch ? "mode mismatch" : "ok"}** → ${result}\n`;
    await this.appendLog(line);
  }

  async appendLog(text) {
    let path = normalizePath(this.settings.logPath || DEFAULTS.logPath);
    if (!path.toLowerCase().endsWith(".md")) path += ".md";   // otherwise it isn't a note
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f) { await this.app.vault.append(f, text); return; }
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      await this.app.vault.create(path, "# Fold Magic log\nOne line per screen change (setting *Log screen changes*), plus snapshots.\n\n" + text);
    } catch (e) { console.warn("Fold Magic: couldn't write the log", e); }
  }

  async snapshot() {
    const s = this.measure();
    const vv = window.visualViewport;
    const probe = document.body.createDiv({ cls: "fold-magic-probe" });
    const vh100 = Math.round(probe.getBoundingClientRect().height); probe.remove();
    const tb = document.querySelector(".mobile-toolbar");
    const tr = tb ? tb.getBoundingClientRect() : null;
    const list = document.querySelector(".mobile-toolbar-options-list");
    const css = getComputedStyle(document.body);
    const lines = [
      `### Snapshot ${moment().format("YYYY-MM-DD HH:mm:ss")}`,
      `- layout: ${this.describe(s)} · filled ${s.filled}px · **${s.stuck ? "STUCK" : s.modeMismatch ? "mode mismatch" : "ok"}**`,
      `- screen ${screen.width}×${screen.height} · window ${window.innerWidth}×${window.innerHeight} · 100vh = ${vh100}px · visualViewport ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}` : "n/a"} · dpr ${window.devicePixelRatio}`,
      `- keyboard-height ${css.getPropertyValue("--keyboard-height").trim() || "?"} · toolbar ${tr ? `top ${Math.round(tr.top)} bottom ${Math.round(tr.bottom)} left ${Math.round(tr.left)} right ${Math.round(tr.right)}` : "not shown"} · toolbar list ${list ? `${list.scrollWidth}/${list.clientWidth}px` : "n/a"}`,
      `- sidebar vars: ${WIDTH_VARS.map((v) => `${v.replace("--mobile-sidebar-", "")}=${css.getPropertyValue(v).trim()}`).join(" ")}`,
      `- status bar: ${this.hub.hidden() ? "hidden" : "shown"} (manual ${this.hub.manual === null ? "no" : this.hub.manual ? "hide" : "show"}, wants: ${Array.from(this.hub.wants.keys()).join(", ") || "none"})`,
      `- device: ${Platform.isAndroidApp ? "Android app" : Platform.isIosApp ? "iOS app" : "other"} · body: ${document.body.className}`,
      "",
    ];
    await this.appendLog("\n" + lines.join("\n") + "\n");
    new Notice(`Fold Magic: snapshot saved to ${this.settings.logPath}`, 3000);
  }
};

function normalizeFontSize(x) {
  x = (x || "").trim();
  return /^\d+(\.\d+)?$/.test(x) ? x + "px" : x;       // "14" means 14px
}

function validFontSize(x) {
  try { return CSS.supports("font-size", x); } catch (e) { return false; }
}

function validLength(x, varName) {
  const prop = varName && varName.includes("max-width") ? "max-width" : "width";
  try { return CSS.supports(prop, x); } catch (e) { return false; }
}

class FoldMagicSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  hide() { if (this.liveOff) this.liveOff(); }
  display() {
    const el = this.containerEl, p = this.plugin, s = p.settings;
    el.empty();
    if (!p.active) el.createEl("p", { cls: "mod-warning", text: "Fold Magic only works in the Obsidian mobile app. On this device it does nothing; these settings are for your phone." });

    new Setting(el).setName("Stuck layout").setHeading();
    new Setting(el).setName("When the layout gets stuck after folding")
      .setDesc("First Fold Magic fixes the layout by itself. If that isn't enough: the Fix layout button is a ✨ wand left of the reading-view (book) icon. Tap it to close sidebars and reset the layout; it saves your notes and reloads only if that wasn't enough. Automatic reload happens at most once every 5 minutes, and only right after a fold; otherwise you get the button.")
      .addDropdown((d) => d.addOptions({ off: "Do nothing", stuck: "Show Fix layout button when stuck", always: "Always show Fix layout button", reload: "Reload automatically" })
        .setValue(s.stuckFix).onChange(async (v) => { s.stuckFix = v; if (v !== "stuck" && v !== "always") p.stuckNow = false; await p.saveSettings(); }));
    new Setting(el).setName("Close sidebars when you fold or unfold")
      .setDesc("Open sidebars during a fold are the usual trigger for the stuck layout.")
      .addToggle((t) => t.setValue(s.closeDrawersOnFold).onChange(async (v) => { s.closeDrawersOnFold = v; await p.saveSettings(); }));

    new Setting(el).setName("Android status bar").setHeading();
    new Setting(el).setName("Hide automatically")
      .setDesc("The command “Toggle Android status bar” works any time (bind it to the pull-down gesture in Settings → Mobile). A toggle lasts until you fold or unfold, Day Peek changes what it wants, or you run it again.")
      .addDropdown((d) => d.addOptions({ off: "Never", always: "Always", unfolded: "When unfolded", folded: "When folded" })
        .setValue(s.statusBarAuto).onChange(async (v) => { s.statusBarAuto = v; await p.saveSettings(); }));

    new Setting(el).setName("Sidebar width").setHeading();
    el.createEl("p", { cls: "setting-item-description", text: "Any CSS length: 70vw (70% of the screen), 500px, … Whatever you type is the width you get. Leave empty for Obsidian's default. Switches automatically when you fold or unfold." });
    // "Your screen right now" only under the field you're typing in (0.2.0).
    let liveSpan = null;
    const width = (key, name, stock, varName, parent = el) => new Setting(parent).setName(name)
      .setDesc(createFragment((f) => {
        f.appendText(`Obsidian's default: ${stock}`);
        f.createDiv({ cls: "fold-magic-live" }).hide();
      }))
      .addText((t) => {
        t.inputEl.addEventListener("focus", () => {
          const live = t.inputEl.closest(".setting-item").querySelector(".fold-magic-live");
          liveSpan = live; showLive(); live.show();
        });
        t.inputEl.addEventListener("blur", () => {
          const live = t.inputEl.closest(".setting-item").querySelector(".fold-magic-live");
          live.hide(); if (liveSpan === live) liveSpan = null;
        });
        t.setPlaceholder(stock).setValue(s[key]);
        t.inputEl.addEventListener("change", async () => {
          const v = t.getValue().trim();
          if (v && !validLength(v, varName)) { new Notice(`Fold Magic: “${v}” isn't a CSS length (try 70vw or 500px)`, 4000); t.inputEl.addClass("fold-magic-bad"); return; }
          t.inputEl.removeClass("fold-magic-bad");
          s[key] = v; await p.saveSettings();
        });
      });
    width("foldedWidth", "Folded (outer screen) width", STOCK["--mobile-sidebar-width"], WIDTH_VARS[0]);
    width("unfoldedWidth", "Unfolded (inner screen) width", STOCK["--mobile-sidebar-width"], WIDTH_VARS[0]);
    width("unfoldedPinnedWidth", "Unfolded (inner screen) pinned sidebar width", STOCK["--mobile-sidebar-width-pinned"], WIDTH_VARS[2]);
    const adv = el.createEl("details", { cls: "fold-magic-advanced" });
    adv.createEl("summary", { text: "Advanced" });
    adv.createEl("p", { cls: "setting-item-description", text: "Fold Magic removes Obsidian's maximum width whenever you set a width above. Only fill these in to cap a width yourself (e.g. 70vw with a 600px maximum)." });
    width("foldedMaxWidth", "Folded (outer screen) max width", STOCK["--mobile-sidebar-max-width"] + " (none = no limit)", WIDTH_VARS[1], adv);
    width("unfoldedMaxWidth", "Unfolded (inner screen) max width", STOCK["--mobile-sidebar-max-width"] + " (none = no limit)", WIDTH_VARS[1], adv);
    function showLive() {
      if (!liveSpan) return;
      liveSpan.setText(`Your screen right now: ${window.innerWidth} px wide, ${window.matchMedia(TABLET_MQ).matches ? "unfolded (inner screen)" : "folded (outer screen)"} (CSS pixels: the same units as this setting, not your phone's spec-sheet resolution).`);
    }
    if (this.liveOff) this.liveOff();
    window.addEventListener("resize", showLive);
    this.liveOff = () => { window.removeEventListener("resize", showLive); this.liveOff = null; };

    new Setting(el).setName("Note font size").setHeading();
    el.createEl("p", { cls: "setting-item-description", text: "The inner screen has a lower pixel density than the cover screen, so the same size looks about 15% bigger unfolded. Set each one here (16 or 16px; empty = your Appearance size). Switches when you fold or unfold. While a size is set here, it wins over pinch-to-zoom." });
    const font = (key, name) => new Setting(el).setName(name)
      .setDesc(`Your Appearance size: ${(() => { try { return this.app.vault.getConfig("baseFontSize") || 16; } catch (e) { return 16; } })()}px`)
      .addText((t) => {
        t.setPlaceholder("e.g. 14").setValue(s[key]);
        t.inputEl.addEventListener("change", async () => {
          const v = normalizeFontSize(t.getValue());
          if (v && !validFontSize(v)) { new Notice(`Fold Magic: “${t.getValue()}” isn't a font size (try 14 or 15px)`, 4000); t.inputEl.addClass("fold-magic-bad"); return; }
          t.inputEl.removeClass("fold-magic-bad");
          s[key] = t.getValue().trim(); await p.saveSettings();
        });
      });
    font("foldedFontSize", "Folded (outer screen) font size");
    font("unfoldedFontSize", "Unfolded (inner screen) font size");

    new Setting(el).setName("Troubleshooting").setHeading();
    new Setting(el).setName("Log screen changes")
      .setDesc("Writes one line per fold/unfold to a note, so you can see what happened. The command “Save a layout snapshot” always writes there too.")
      .addToggle((t) => t.setValue(s.logChanges).onChange(async (v) => { s.logChanges = v; await p.saveSettings(); }));
    new Setting(el).setName("Log note").setDesc("Path of the log note in your vault.")
      .addText((t) => t.setPlaceholder(DEFAULTS.logPath).setValue(s.logPath).onChange(async (v) => { s.logPath = v.trim() || DEFAULTS.logPath; await p.saveSettings(); }));
  }
}
