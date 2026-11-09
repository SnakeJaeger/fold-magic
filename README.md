# Fold Magic

An Obsidian plugin that fixes Obsidian mobile's bugs on **foldable phones**. Turn it on and fold away.

Made by **Tailnet 4**.

## What it does

- **Un-sticks the layout after folding.** Obsidian sometimes keeps the old layout when you fold or unfold, for example with a sidebar open: the main view stays shoved to one side, with black next to it. Fold Magic checks the layout after every fold, sidebar change and app resume, and fixes it:
  - it clears the leftover "slide aside" offset on the main view (the usual cause);
  - it closes a sidebar that's stuck half-way;
  - it re-runs Obsidian's own phone/tablet switch, which Obsidian skips while the keyboard is up.

  If none of that helps, a ✨ **Fix layout** button appears in the note header, left of the reading-view icon. It saves your notes and reloads. You can also have it reload automatically, or keep the button there all the time.
- **Android status bar.** The command *Toggle Android status bar* works any time; bind it to the pull-down gesture in Settings → Mobile → Quick action. There's also an optional auto-hide: always, only unfolded, or only folded. It works together with [Day Peek](https://github.com/SnakeJaeger/day-peek): both use one shared controller for the bar, so they never fight over it.
- **Sidebar width, folded and unfolded.** Obsidian limits the slide-out sidebar to 84% of the screen and at most 450 px, so unfolded it only fills about half the screen. Set your own width, maximum and pinned width for each state; they switch by themselves when you fold. Settings show your current screen width live.
- **Troubleshooting.** *Log screen changes* writes one line per fold to a note. The command *Save a layout snapshot* records the full layout, including the keyboard toolbar.

Fold Magic does nothing on desktop. Turning it off or updating it puts the status bar and widths back to stock.

## Common foldable screen widths

Widths are in **CSS pixels**, the units the width settings use. They're smaller than the phone's spec-sheet resolution, and they change with the display size setting (Settings → Display → Screen zoom). The quickest way to know yours: open Fold Magic's settings, which show your current width live.

| Phone | Folded (cover) | Unfolded (inner) | Source |
|---|---|---|---|
| Samsung Galaxy Z Fold 7 | 411 × 960 | 749 × 832 | measured in Obsidian with Fold Magic (default zoom) |
| Samsung Galaxy Z Fold 6 | ≈ 402 × 956 | ≈ 904 × 968 | reported by [tinyfont](https://tinyfont-me.pages.dev/screenresolutions/device/samsung-galaxy-z-fold-6-open), [cover](https://tinyfont-me.pages.dev/screenresolutions/device/samsung-galaxy-z-fold-6-cover) |
| Google Pixel 9 Pro Fold | — | ≈ 755 × 783 | estimated by [What Is My Screen Size?](https://www.whatismyscreensize.com/device/pixel-9-pro-fold) |

Heights in Obsidian are a little smaller than the full screen, because of the status and navigation bars. Got another foldable? Run *Save a layout snapshot* and send us the numbers.

**Tip:** for a sidebar that's wide but leaves a sliver of your note visible, use about the unfolded width minus 50 px. On the Fold 7 that's around `700px`, with the maximum set to `none`.

## Settings

| Setting | Options |
|---|---|
| When the layout gets stuck after folding | Show a Fix layout button · Reload automatically · Do nothing |
| Fix layout button in the note header | Only when stuck · Always · Never |
| Close sidebars when you fold or unfold | On / off |
| Android status bar: hide automatically | Never · Always · When unfolded · When folded |
| Sidebar width (folded / unfolded) | width, maximum width, pinned width (unfolded); any CSS length |
| Log screen changes / Log note | On / off, path of the note |

## Good to know

Fold Magic reads and adjusts Obsidian's own layout. The phone/tablet rule `(min-width: 600px) and (min-height: 600px)` and the `--mobile-sidebar-*` CSS variables are Obsidian internals, so a big Obsidian update could change them.

No build step: `main.js` is plain JavaScript.
