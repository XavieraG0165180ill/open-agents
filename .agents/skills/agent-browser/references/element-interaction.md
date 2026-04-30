# Element Interaction Reference

This reference covers how to interact with page elements using the agent-browser skill, including clicking, typing, selecting, and waiting for elements.

## Overview

Element interaction is the core of browser automation. The agent-browser skill provides a set of actions to interact with DOM elements using Playwright's locator API under the hood.

## Snapshot-Based Interaction

Before interacting with elements, always take a snapshot to get current element references:

```bash
# Take a snapshot to get element refs
browser_snapshot
```

The snapshot returns a list of interactive elements with their `ref` IDs, roles, and labels. Use these refs in subsequent actions.

## Clicking Elements

### Basic Click

```bash
browser_click ref="e123"
```

### Click with Coordinates (fallback)

When a ref is unavailable or stale, use coordinate-based clicking:

```bash
browser_click coordinate="[640, 360]"
```

### Double Click

```bash
browser_click ref="e123" double=true
```

### Right Click

```bash
browser_click ref="e123" button="right"
```

## Typing and Input

### Type into a Field

Always click the field first to focus it, then type:

```bash
browser_click ref="e45"
browser_type text="Hello, World!"
```

### Clear and Replace

To replace existing content, use the `slowly` flag and select-all first:

```bash
browser_click ref="e45"
browser_key key="Control+a"
browser_type text="New content"
```

### Typing with Delay (human-like)

```bash
browser_type text="search query" slowly=true
```

## Keyboard Actions

### Press a Key

```bash
browser_key key="Enter"
browser_key key="Tab"
browser_key key="Escape"
browser_key key="ArrowDown"
```

### Key Combinations

```bash
browser_key key="Control+c"
browser_key key="Control+v"
browser_key key="Shift+Tab"
```

## Select / Dropdown

### Select by Visible Text

```bash
browser_select_option ref="e67" value="Option Label"
```

### Select by Value Attribute

```bash
browser_select_option ref="e67" value="option-value"
```

## Hovering

```bash
browser_hover ref="e89"
```

Useful for revealing tooltip content or triggering hover menus before taking a snapshot.

## Scrolling

### Scroll the Page

```bash
browser_scroll direction="down" distance=500
browser_scroll direction="up" distance=500
```

### Scroll to Element

```bash
browser_scroll ref="e101" direction="into-view"
```

## Waiting for Elements

### Wait for Element to Appear

```bash
browser_wait_for ref="e102" state="visible" timeout=5000
```

### Wait for Navigation

After clicking a link or submitting a form:

```bash
browser_click ref="e55"
browser_wait_for url="https://example.com/dashboard" timeout=10000
```

## File Upload

```bash
browser_click ref="e77"  # click the file input
browser_upload_file path="/tmp/document.pdf"
```

## Best Practices

1. **Always snapshot before interacting** — refs become stale after navigation or DOM mutations.
2. **Prefer refs over coordinates** — refs are more resilient to layout changes.
3. **Check element state** — verify an element is enabled/visible before clicking.
4. **Use waits after navigation** — page loads asynchronously; wait for stable state.
5. **Handle modals** — if a modal appears after an action, snapshot again before continuing.

## Common Patterns

### Form Fill and Submit

```bash
browser_snapshot
browser_click ref="e10"        # focus name field
browser_type text="Jane Doe"
browser_click ref="e11"        # focus email field
browser_type text="jane@example.com"
browser_click ref="e12"        # submit button
browser_wait_for url="**/success" timeout=8000
browser_snapshot               # verify success state
```

### Search and Select Result

```bash
browser_snapshot
browser_click ref="e5"         # search input
browser_type text="open agents" slowly=true
browser_wait_for ref="e20" state="visible" timeout=3000
browser_snapshot               # get updated refs for results
browser_click ref="e20"        # first result
```
