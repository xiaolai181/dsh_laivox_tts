// The host may zoom the plugin: its on-screen box is then larger or smaller
// than its layout box. Anything placed with viewport coordinates (dialogs and
// popovers in the top layer) must divide by this scale, or it drifts away from
// what it belongs to.
export function workbenchFrame(node) {
  const workbench = node?.closest?.('.lv-workbench') ?? null
  const area = workbench?.getBoundingClientRect() ?? null
  const ratio = area && workbench.offsetWidth ? area.width / workbench.offsetWidth : 1
  return { workbench, area, scale: Number.isFinite(ratio) && ratio > 0 ? ratio : 1 }
}

// Where the top bar ends and the transport dock begins, in the workbench's own
// layout pixels (offset values are not affected by zoom). Sheets and toasts sit
// between the two so they never cover navigation or playback controls.
export function workbenchInsets(workbench) {
  const top = workbench?.querySelector(':scope > .lv-top')
  const dock = workbench?.querySelector(':scope > .lv-transport')
  const height = workbench?.clientHeight ?? 0
  return {
    top: top ? top.offsetTop + top.offsetHeight : 0,
    bottom: dock ? Math.max(0, height - dock.offsetTop) : 0,
  }
}
