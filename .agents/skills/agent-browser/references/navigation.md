# Browser Navigation Reference

This reference covers navigation patterns for the agent-browser skill, including page navigation, history management, and multi-tab workflows.

## Basic Navigation

### Navigate to URL

Use the `goto` action to navigate to a specific URL:

```json
{
  "action": "goto",
  "url": "https://example.com"
}
```

Options:
- `waitUntil`: When to consider navigation complete
  - `"load"` — wait for `load` event (default)
  - `"domcontentloaded"` — wait for DOMContentLoaded
  - `"networkidle"` — wait until no network requests for 500ms
  - `"commit"` — navigation committed, response received
- `timeout`: Max milliseconds to wait (default: 30000)

```json
{
  "action": "goto",
  "url": "https://example.com/dashboard",
  "waitUntil": "networkidle",
  "timeout": 15000
}
```

---

## History Navigation

### Go Back

```json
{
  "action": "goBack",
  "waitUntil": "load"
}
```

### Go Forward

```json
{
  "action": "goForward",
  "waitUntil": "load"
}
```

### Reload Page

```json
{
  "action": "reload",
  "waitUntil": "networkidle"
}
```

---

## Waiting for Navigation

When clicking links or submitting forms that trigger navigation, use `waitForNavigation`:

```json
{
  "action": "click",
  "ref": "e45",
  "waitForNavigation": true,
  "waitUntil": "networkidle"
}
```

Alternatively, use `waitForURL` to wait until the page URL matches a pattern:

```json
{
  "action": "waitForURL",
  "url": "**/dashboard**",
  "timeout": 10000
}
```

Supports glob patterns:
- `*` — matches any string except `/`
- `**` — matches any string including `/`
- `?` — matches any single character

---

## Multi-Tab Management

### Open New Tab

```json
{
  "action": "newTab",
  "url": "https://example.com/page2"
}
```

### Switch Between Tabs

Tabs are referenced by index (0-based) or by URL pattern:

```json
{
  "action": "switchTab",
  "index": 1
}
```

```json
{
  "action": "switchTab",
  "urlPattern": "**/dashboard**"
}
```

### Close Tab

```json
{
  "action": "closeTab",
  "index": 1
}
```

---

## Handling Redirects

For pages that redirect, use `networkidle` or `waitForURL`:

```json
{
  "action": "goto",
  "url": "https://example.com/login",
  "waitUntil": "networkidle"
}
```

Then verify the final URL using `getCurrentURL`:

```json
{
  "action": "getCurrentURL"
}
```

Response:
```json
{
  "url": "https://example.com/dashboard"
}
```

---

## Common Patterns

### Login and Redirect Flow

1. Navigate to login page
2. Fill credentials (see `form-interaction.md`)
3. Submit form with navigation wait
4. Verify redirect to authenticated route

```json
[
  { "action": "goto", "url": "https://app.example.com/login" },
  { "action": "fill", "ref": "e12", "value": "user@example.com" },
  { "action": "fill", "ref": "e13", "value": "password" },
  { "action": "click", "ref": "e14", "waitForNavigation": true, "waitUntil": "networkidle" },
  { "action": "waitForURL", "url": "**/dashboard**" }
]
```

### Paginated Content

```json
[
  { "action": "goto", "url": "https://example.com/results?page=1" },
  { "action": "snapshot" },
  { "action": "click", "ref": "e_next_page", "waitForNavigation": true },
  { "action": "snapshot" }
]
```

---

## Error Handling

- If navigation times out, a `TimeoutError` is returned with the current URL state.
- If the URL is unreachable (DNS failure, connection refused), a `NavigationError` is returned.
- Always check `statusCode` when navigating to ensure the page loaded successfully.

```json
{
  "action": "goto",
  "url": "https://example.com",
  "waitUntil": "load"
}
```

Response includes:
```json
{
  "statusCode": 200,
  "url": "https://example.com/",
  "title": "Example Domain"
}
```

---

## Related References

- `snapshot-refs.md` — referencing elements after navigation
- `element-interaction.md` — clicking links and buttons
- `form-interaction.md` — form submission with navigation
- `session-management.md` — persisting cookies across navigations
