# Text Extraction Reference

This reference covers techniques for extracting text content from web pages using the agent-browser skill.

## Overview

Text extraction allows you to retrieve visible text, structured data, and metadata from web pages. The agent-browser skill supports multiple extraction strategies depending on the content type and page structure.

## Basic Text Extraction

### Get All Visible Text

Extract all visible text from the current page:

```bash
# Using snapshot to get page text content
browser_snapshot
# The snapshot returns structured text with element context
```

### Extract Text from Specific Elements

Target specific elements using CSS selectors or element references:

```bash
# Click on an element to focus, then read surrounding context
browser_click --ref "element-ref-id"

# Use snapshot refs to identify text-bearing elements
browser_snapshot --format text
```

## Structured Data Extraction

### Tables

For tabular data, snapshots preserve table structure:

```
Strategy:
1. Navigate to page containing table
2. Take snapshot - tables are rendered with row/column context
3. Parse the structured snapshot output
4. Each cell is accessible via its snapshot reference
```

### Lists

Ordered and unordered lists are captured with hierarchy:

```
Strategy:
1. Identify list container via snapshot
2. List items appear with positional context (1 of N, 2 of N)
3. Nested lists preserve indentation levels
```

### Article / Blog Content

```bash
# Navigate to article
browser_navigate --url "https://example.com/article"

# Take full snapshot to get article text
browser_snapshot

# For paginated content, scroll and re-snapshot
browser_scroll --direction down --amount 500
browser_snapshot
```

## Dynamic Content Extraction

### Waiting for Content to Load

Some content loads asynchronously. Use wait strategies:

```bash
# Wait for a specific element to appear before extracting
browser_wait_for --selector ".content-loaded"
browser_snapshot

# For infinite scroll pages, scroll incrementally
browser_scroll --direction down --amount 800
browser_wait --duration 1000
browser_snapshot
```

### JavaScript-Rendered Content

Single-page applications render content via JavaScript:

```bash
# Allow time for JS execution after navigation
browser_navigate --url "https://spa-example.com"
browser_wait --duration 2000
browser_snapshot

# For content behind interactions (tabs, accordions)
browser_click --ref "tab-ref-id"
browser_wait --duration 500
browser_snapshot
```

## Metadata Extraction

### Page Title and Meta Tags

Page metadata is included in snapshot output:

```
Snapshot output includes:
- Page title (from <title> tag)
- URL of current page
- Meta description when available
- Open Graph tags when present
```

### Link Extraction

Links are captured with their href and anchor text:

```bash
# Snapshot includes all links with text and destination
browser_snapshot

# Links appear as: [Link Text](https://destination.com)
# Internal links appear as: [Link Text](/relative/path)
```

## Multi-Page Extraction

### Pagination Handling

```bash
# Pattern for extracting across paginated content:
# 1. Extract current page
browser_snapshot

# 2. Find and click next page button
browser_click --ref "next-page-btn-ref"
browser_wait --duration 1000

# 3. Verify page changed (URL or content)
browser_snapshot

# 4. Repeat until no next button found
```

### Search Results

```bash
# Navigate to search
browser_navigate --url "https://example.com/search?q=query"
browser_wait --duration 1500

# Extract results list
browser_snapshot
# Results appear with titles, snippets, and links
```

## Best Practices

1. **Use snapshots over screenshots** for text extraction — snapshots provide machine-readable structured text
2. **Wait for dynamic content** before snapshotting to avoid partial extractions
3. **Scroll through long pages** in sections to capture all content
4. **Verify extraction completeness** by checking for pagination or "load more" elements
5. **Handle cookie/consent banners** before extracting to avoid capturing overlay text

## Common Issues

### Text Behind Modals

If a modal or overlay is blocking content:

```bash
# Close modal first
browser_press_key --key Escape
# Or click the close button
browser_click --ref "modal-close-ref"
browser_snapshot
```

### Lazy-Loaded Images with Alt Text

Scroll to trigger lazy loading before snapshot to capture alt text:

```bash
browser_scroll --direction down --amount 300
browser_wait --duration 800
browser_snapshot
```

### Iframes

Content inside iframes requires explicit frame switching:

```bash
# Switch to iframe context
browser_switch_frame --ref "iframe-ref-id"
browser_snapshot

# Return to main frame
browser_switch_frame --main
```

## Related References

- [Snapshot Refs](./snapshot-refs.md) — Understanding snapshot reference IDs
- [Navigation](./navigation.md) — Page navigation techniques
- [Element Interaction](./element-interaction.md) — Interacting with page elements
