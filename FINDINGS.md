# Findings

Non-trivial behaviour we discovered while building the UI. Each entry
documents a real bug, its root cause, and how we fixed it.

---

## React key reuse across view transitions

**Affected area:** `ToolPanel` collapse detection (`packages/ui/src/App.tsx`)

### The bug

When navigating from a parent session to a subagent, some tool panels
displayed wrong collapse state — short panels appeared collapsed (with
blank space below the text), and tall panels were not collapsible.
Switching the view mode (chat → context → chat) fixed the panels
permanently.

### Root cause

`renderPanels()` assigns positional keys (`key={0}`, `key={1}`, …) to
panel components. When the user navigates to a subagent, two renders
occur in sequence:

1. `setView({ mode: "chat" })` triggers a render with the **parent's**
   messages still in state. React mounts `ToolPanel` instances at keys
   0, 1, 2, … and runs their `useEffect` — measuring the parent's
   panel content.

2. `setMessages(subagentMessages)` triggers a second render. The
   subagent's panels get the same positional keys (0, 1, 2, …). React
   **reuses** the existing `ToolPanel` component instances — it updates
   their props and children, but does **not** remount them. The
   `useEffect` dependency was `[observe]`, which didn't change (it was
   `false` both times). The effect never re-ran. The collapse state
   from the parent's content stuck to the subagent's content.

Switching view modes (chat → context → chat) unmounts all panels and
remounts fresh ones, which is why that sequence fixed the problem.

### Fix

Add a `content` prop (the raw markdown string) to `ToolPanel` and
include it in the effect's dependency array. When React reuses a
component instance but the content has changed, the effect re-runs and
measures the new content.

### Lesson

When using positional keys (`key={n++}`) and the underlying data set
can be swapped entirely (e.g. navigating between views), any `useEffect`
that depends on the rendered content must include a content-derived
value in its dependency array — otherwise React reuses the component
and the effect never re-fires.

---

## `height` vs `max-height` for collapsed panels

**Affected area:** `.panel--tool.panel--collapsed > .md` (CSS)

### The bug

When a short panel (e.g. one line) was incorrectly marked collapsed,
CSS `height: 6em` **stretched** it from its natural ~1em to 6em,
creating visible blank space. Collapsing made the panel bigger instead
of smaller.

### Fix

Use `max-height: 6em` instead of `height: 6em`. A panel shorter than
6em stays at its natural height regardless of collapse state.
