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

const DEFAULTS = {
  stuckAction: "notice",        // notice | reload | off
  closeDrawersOnFold: true,
  statusBarAuto: "off",         // off | always | unfolded | folded
  foldedWidth: "", foldedMaxWidth: "",
  unfoldedWidth: "", unfoldedMaxWidth: "", unfoldedPinnedWidth: "",
  logChanges: false,
  logPath: "Fold Magic log.md",
};
const TABLET_MQ = "(min-width: 600px) and (min-height: 600px)";   // Obsidian's own phone/tablet rule
const WIDTH_VARS = ["--mobile-sidebar-width", "--mobile-sidebar-max-width", "--mobile-sidebar-width-pinned"];
const STOCK = { "--mobile-sidebar-width": "84vw", "--mobile-sidebar-max-width": "450px", "--mobile-sidebar-width-pinned": "350px" };
const SETTLE_MS = 800;           // wait this long after the last resize before checking
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
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
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
    // The stuck view shows up when you close a sidebar after a fold, which isn't a resize.
    this.registerEvent(this.app.workspace.on("layout-change", () => { if (Date.now() >= (this.ignoreUntil || 0)) this.scheduleCheck("layout"); }));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) return;
      this.hub.apply();                                     // Android may have shown the bar meanwhile
      this.scheduleCheck("resume");
    });
    this.app.workspace.onLayoutReady(() => { this.applyAll(); this.scheduleCheck("startup"); });
  }

  onunload() {
    window.clearTimeout(this.checkTimer);
    if (!this.active) return;
    this.hub.leave("fold-magic");                           // shows the bar unless Day Peek still wants it hidden
    for (const v of WIDTH_VARS) document.body.style.removeProperty(v);
    // Day Peek has its own (simpler) width setting that steps aside while we're on: let it take over again.
    window.setTimeout(() => { const dp = this.app.plugins.plugins["day-peek"]; if (dp && dp.applyWidth) dp.applyWidth(); }, 0);
    if (this.notice) this.notice.hide();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.active) this.applyAll();
  }

  // ---------- screen changes ----------
  onResize() {
    if (Date.now() < (this.ignoreUntil || 0)) return;        // our own nudge
    const unfolded = this.mq.matches;
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
    const folded = this.changing;
    this.changing = false;
    if (folded) this.hub.manual = null;                    // a fold ends any hand toggle
    this.applyAll();

    let s = this.measure();
    const steps = [];
    if (s.modeMismatch) { this.fixMode(); steps.push("fixed phone/tablet mode"); await sleep(400); s = this.measure(); }
    if (s.stuck && !s.overlayOpen && this.unshove()) {
      steps.push("reset shoved main view"); await sleep(300); s = this.measure();
    }
    if (s.stuck) {
      this.nudge(); steps.push("nudged"); await sleep(600); s = this.measure();
      // Sidebars slide for a moment after a fold; look once more before calling it stuck.
      if (s.stuck) { await sleep(1500); s = this.measure(); }
      if (s.stuck) steps.push(await this.onStuck());
    }
    if (!s.stuck && this.notice) { this.notice.hide(); this.notice = null; }   // fixed itself meanwhile
    // Log folds and anything we had to fix; skip the many routine "layout" re-checks.
    if (this.settings.logChanges && (folded || steps.length || why !== "layout")) {
      await this.log(why + (folded ? ` (${this.changeFrom} → ${s.unfolded ? "unfolded" : "folded"})` : ""), s, steps.join(" + ") || "ok");
    }
    this.lastCheck = { why, state: s, steps };
  }

  measure() {
    const w = window.innerWidth, h = window.innerHeight;
    const unfolded = this.mq.matches;
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
    const pinW = (side) => drawers.filter((d) => d.side === side && d.pinned && d.open).reduce((a, d) => a + d.w, 0);
    const overlayOpen = drawers.some((d) => d.open && !d.pinned);
    const filled = root ? root.w + pinW("L") + pinW("R") : w;
    const stuck = !!ws && (ws.w < w * 0.9 || ws.l > 8 || ws.r < w - 8 ||
      (!overlayOpen && !!root && (Math.abs(root.l - pinW("L")) > 8 || Math.abs(root.r - (w - pinW("R"))) > 8)));
    return { w, h, unfolded, tablet: !!Platform.isTablet, bodyTablet, keyboard: !!Platform.mobileSoftKeyboardVisible,
      ws, root, drawers, overlayOpen, filled, modeMismatch, stuck };
  }

  fixMode() {
    const t = this.mq.matches;
    Platform.isTablet = t;
    Platform.isPhone = !t;
    document.body.classList.toggle("is-tablet", t);
    document.body.classList.toggle("is-phone", !t);
    this.nudge();
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

  async onStuck() {
    const a = this.settings.stuckAction;
    if (a === "reload") { await this.reload(); return "reloaded"; }
    if (a === "notice") { this.showFixNotice(); return "offered Fix layout"; }
    return "still stuck (fix is off)";
  }

  showFixNotice() {
    if (this.notice && this.notice.noticeEl && this.notice.noticeEl.isConnected) return;   // already showing
    const frag = createFragment((f) => {
      f.createSpan({ text: "Fold Magic: the layout didn't follow the fold. " });
      const b = f.createEl("button", { text: "Fix layout", cls: "mod-cta" });
      b.addEventListener("click", (e) => { e.stopPropagation(); this.reload(); });
    });
    this.notice = new Notice(frag, 0);                     // stays until tapped
  }

  async fixNow() {
    this.closeDrawers();
    this.unshove();
    this.fixMode();
    await sleep(500);
    const s = this.measure();
    if (s.stuck) { await this.reload(); return; }
    new Notice("Fold Magic: layout looks right now", 2500);
    if (this.settings.logChanges) await this.log("fix command", s, "fixed without reload");
  }

  async reload() {
    // "Reload app without saving" doesn't wait for pending saves, so save open notes first.
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      try { await leaf.view.save(); } catch (e) { /* ignore */ }
    }
    for (const leaf of this.app.workspace.getLeavesOfType("day-peek")) {
      try { if (leaf.view.flush) await leaf.view.flush(); } catch (e) { /* ignore */ }
    }
    if (this.settings.logChanges) await this.log("reload", this.measure(), "reloading");
    await sleep(300);
    this.app.commands.executeCommandById("app:reload");
  }

  // ---------- status bar + widths ----------
  applyAll() { this.applyWidths(); this.applyStatusBar(); }

  applyStatusBar() {
    const a = this.settings.statusBarAuto, u = this.mq.matches;
    this.hub.want("fold-magic", a === "always" || (a === "unfolded" && u) || (a === "folded" && !u));
  }

  toggleStatusBar() {
    if (!this.hub.api()) { new Notice("Fold Magic: Android's status bar can't be controlled here", 3000); return; }
    const hidden = this.hub.toggle();
    new Notice(`Fold Magic: status bar ${hidden ? "hidden" : "shown"} (until you fold, switch pane, or run it again)`, 2500);
  }

  applyWidths() {
    const s = this.settings, u = this.mq.matches;
    const vals = u ? [s.unfoldedWidth, s.unfoldedMaxWidth, s.unfoldedPinnedWidth] : [s.foldedWidth, s.foldedMaxWidth, ""];
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
    return `${s.w}×${s.h} ${s.unfolded ? "unfolded" : "folded"} · mode ${s.tablet ? "tablet" : "phone"} (body ${s.bodyTablet ? "tablet" : "phone"}) · keyboard ${s.keyboard ? "up" : "down"} · workspace ${r(s.ws)} · main ${r(s.root)} · drawers ${d || "none"}`;
  }

  async log(why, s, result) {
    const line = `- ${moment().format("YYYY-MM-DD HH:mm:ss")} · ${why} · ${this.describe(s)} · **${s.stuck ? "STUCK" : s.modeMismatch ? "mode mismatch" : "ok"}** → ${result}\n`;
    await this.appendLog(line);
  }

  async appendLog(text) {
    const path = normalizePath(this.settings.logPath || DEFAULTS.logPath);
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
    const probe = document.body.createDiv({ attr: { style: "position:fixed;top:0;left:0;height:100vh;width:0;visibility:hidden" } });
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

function validLength(x, varName) {
  const prop = varName && varName.includes("max-width") ? "max-width" : "width";
  try { return CSS.supports(prop, x); } catch (e) { return false; }
}

class FoldMagicSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin, s = p.settings;
    el.empty();
    if (!p.active) el.createEl("p", { cls: "mod-warning", text: "Fold Magic only works in the Obsidian mobile app. On this device it does nothing; these settings are for your phone." });

    el.createEl("h3", { text: "Stuck layout" });
    new Setting(el).setName("When the layout gets stuck after folding")
      .setDesc("First Fold Magic fixes the phone/tablet mode and nudges the layout by itself. If that isn't enough, it can show a Fix layout button (reloads Obsidian after saving your notes) or reload straight away.")
      .addDropdown((d) => d.addOptions({ notice: "Show a Fix layout button", reload: "Reload automatically", off: "Do nothing" })
        .setValue(s.stuckAction).onChange(async (v) => { s.stuckAction = v; await p.saveSettings(); }));
    new Setting(el).setName("Close sidebars when you fold or unfold")
      .setDesc("Open sidebars during a fold are the usual trigger for the stuck layout.")
      .addToggle((t) => t.setValue(s.closeDrawersOnFold).onChange(async (v) => { s.closeDrawersOnFold = v; await p.saveSettings(); }));

    el.createEl("h3", { text: "Android status bar" });
    new Setting(el).setName("Hide automatically")
      .setDesc("The command “Toggle Android status bar” works any time (bind it to the pull-down gesture in Settings → Mobile). A toggle lasts until you fold/unfold or Day Peek changes its mind.")
      .addDropdown((d) => d.addOptions({ off: "Never", always: "Always", unfolded: "When unfolded", folded: "When folded" })
        .setValue(s.statusBarAuto).onChange(async (v) => { s.statusBarAuto = v; await p.saveSettings(); }));

    el.createEl("h3", { text: "Sidebar width" });
    el.createEl("p", { cls: "setting-item-description", text: "Any CSS length: 70vw (70% of the screen), 500px, … Leave empty for Obsidian's default. Switches automatically when you fold or unfold." });
    const width = (key, name, stock, varName) => new Setting(el).setName(name).setDesc(`Obsidian's default: ${stock}`)
      .addText((t) => {
        t.setPlaceholder(stock).setValue(s[key]);
        t.inputEl.addEventListener("change", async () => {
          const v = t.getValue().trim();
          if (v && !validLength(v, varName)) { new Notice(`Fold Magic: “${v}” isn't a CSS length (try 70vw or 500px)`, 4000); t.inputEl.addClass("fold-magic-bad"); return; }
          t.inputEl.removeClass("fold-magic-bad");
          s[key] = v; await p.saveSettings();
        });
      });
    width("foldedWidth", "Folded: width", STOCK["--mobile-sidebar-width"], WIDTH_VARS[0]);
    width("foldedMaxWidth", "Folded: maximum width", STOCK["--mobile-sidebar-max-width"], WIDTH_VARS[1]);
    width("unfoldedWidth", "Unfolded: width", STOCK["--mobile-sidebar-width"], WIDTH_VARS[0]);
    width("unfoldedMaxWidth", "Unfolded: maximum width", STOCK["--mobile-sidebar-max-width"] + " (none = no limit)", WIDTH_VARS[1]);
    width("unfoldedPinnedWidth", "Unfolded: pinned sidebar width", STOCK["--mobile-sidebar-width-pinned"], WIDTH_VARS[2]);

    el.createEl("h3", { text: "Troubleshooting" });
    new Setting(el).setName("Log screen changes")
      .setDesc("Writes one line per fold/unfold to a note, so you can see what happened. The command “Save a layout snapshot” always writes there too.")
      .addToggle((t) => t.setValue(s.logChanges).onChange(async (v) => { s.logChanges = v; await p.saveSettings(); }));
    new Setting(el).setName("Log note").setDesc("Path of the log note in your vault.")
      .addText((t) => t.setPlaceholder(DEFAULTS.logPath).setValue(s.logPath).onChange(async (v) => { s.logPath = v.trim() || DEFAULTS.logPath; await p.saveSettings(); }));
  }
}
