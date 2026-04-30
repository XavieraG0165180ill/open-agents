# Keyboard Shortcuts & Input Reference

This reference covers keyboard input simulation, hotkey combinations, and text input strategies for browser automation tasks.

## Basic Key Press

Use `keyboard.press()` to simulate individual key presses or combinations:

```typescript
// Single key press
await page.keyboard.press('Enter');
await page.keyboard.press('Tab');
await page.keyboard.press('Escape');

// Key with modifier
await page.keyboard.press('Control+C');
await page.keyboard.press('Meta+A'); // Cmd+A on macOS
await page.keyboard.press('Shift+Tab');
```

## Text Input

### Type vs Fill

`fill()` is preferred for form fields as it clears existing content and fires appropriate events:

```typescript
// Recommended for form inputs
await page.fill('#search-input', 'query text');

// Simulates real keystroke-by-keystroke typing (slower, triggers keydown/keyup)
await page.type('#search-input', 'query text', { delay: 50 });
```

### Clearing Input Fields

```typescript
// Clear via keyboard shortcut
await page.click('#input-field');
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');

// Clear via fill with empty string
await page.fill('#input-field', '');

// Triple-click to select all, then type replacement
await page.click('#input-field', { clickCount: 3 });
await page.type('#input-field', 'new value');
```

## Common Keyboard Shortcuts

### Navigation

| Action | Windows/Linux | macOS |
|--------|--------------|-------|
| Select all | `Control+A` | `Meta+A` |
| Copy | `Control+C` | `Meta+C` |
| Paste | `Control+V` | `Meta+V` |
| Cut | `Control+X` | `Meta+X` |
| Undo | `Control+Z` | `Meta+Z` |
| Redo | `Control+Shift+Z` | `Meta+Shift+Z` |
| Find | `Control+F` | `Meta+F` |
| Refresh | `F5` | `Meta+R` |
| Hard Refresh | `Control+Shift+R` | `Meta+Shift+R` |
| New Tab | `Control+T` | `Meta+T` |
| Close Tab | `Control+W` | `Meta+W` |
| Address Bar | `Control+L` | `Meta+L` |

### Text Editing

| Action | Key |
|--------|-----|
| Move to line start | `Home` |
| Move to line end | `End` |
| Move to doc start | `Control+Home` |
| Move to doc end | `Control+End` |
| Select to line start | `Shift+Home` |
| Select to line end | `Shift+End` |
| Delete word forward | `Control+Delete` |
| Delete word backward | `Control+Backspace` |

## Holding Modifier Keys

For drag operations or multi-select with keyboard:

```typescript
// Hold Shift while clicking to select range
await page.keyboard.down('Shift');
await page.click('.list-item:nth-child(5)');
await page.keyboard.up('Shift');

// Hold Control for multi-select
await page.keyboard.down('Control');
await page.click('.checkbox-item:nth-child(2)');
await page.click('.checkbox-item:nth-child(4)');
await page.keyboard.up('Control');
```

## Special Characters & Unicode

```typescript
// Insert special characters via insertText
await page.keyboard.insertText('Hello © World™');
await page.keyboard.insertText('Price: €42.00');

// Emoji input
await page.keyboard.insertText('Status: ✅');
```

## Function Keys

```typescript
await page.keyboard.press('F1');  // Help
await page.keyboard.press('F5');  // Refresh
await page.keyboard.press('F11'); // Fullscreen
await page.keyboard.press('F12'); // DevTools
```

## Detecting OS for Cross-Platform Scripts

```typescript
const isMac = process.platform === 'darwin';
const modifier = isMac ? 'Meta' : 'Control';

// Cross-platform select all
await page.keyboard.press(`${modifier}+A`);

// Cross-platform copy
await page.keyboard.press(`${modifier}+C`);
```

## Keyboard Navigation in Dropdowns/Menus

```typescript
// Open dropdown and navigate with arrow keys
await page.click('#dropdown-trigger');
await page.keyboard.press('ArrowDown'); // First item
await page.keyboard.press('ArrowDown'); // Second item
await page.keyboard.press('Enter');     // Select

// Close without selecting
await page.keyboard.press('Escape');
```

## Tips

- Prefer `fill()` over `type()` for speed unless keystroke events are required
- Always `await` keyboard actions to avoid race conditions
- Use `page.keyboard.insertText()` for Unicode/emoji that `type()` may not handle
- When automating rich text editors (e.g., ProseMirror, CodeMirror), keyboard shortcuts are often more reliable than direct DOM manipulation
- Add small delays (`{ delay: 30 }`) when sites have debounce logic on input events
