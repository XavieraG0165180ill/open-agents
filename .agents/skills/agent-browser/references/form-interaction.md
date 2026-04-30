# Form Interaction Reference

This reference covers techniques for interacting with web forms using the agent-browser skill, including filling inputs, selecting options, handling validation, and submitting forms.

## Basic Input Filling

Use the `fill` action to populate text inputs, textareas, and other editable fields.

```json
{
  "action": "fill",
  "ref": "<element-ref>",
  "value": "text to enter"
}
```

### Locating Form Fields

Form fields can be located by:
- Label text (most reliable)
- Placeholder text
- `name` or `id` attribute
- ARIA role + accessible name

```json
{
  "action": "snapshot"
}
```

After snapshot, identify the `ref` of the target input from the accessibility tree output.

## Clearing Existing Values

Before filling a field that may already have a value, use the `clear` action:

```json
{
  "action": "clear",
  "ref": "<element-ref>"
}
```

Then proceed with `fill`.

## Select / Dropdown Menus

For native `<select>` elements, use the `select` action with the option value or label:

```json
{
  "action": "select",
  "ref": "<select-element-ref>",
  "value": "option-value"
}
```

For custom dropdowns (non-native), you must:
1. Click the dropdown trigger to open it
2. Wait for the options to appear in the snapshot
3. Click the desired option by its ref

```json
{ "action": "click", "ref": "<dropdown-trigger-ref>" }
```
```json
{ "action": "snapshot" }
```
```json
{ "action": "click", "ref": "<option-ref>" }
```

## Checkboxes and Radio Buttons

Use the `click` action to toggle checkboxes or select radio buttons:

```json
{
  "action": "click",
  "ref": "<checkbox-or-radio-ref>"
}
```

To verify the state after interaction, take a snapshot and inspect the `checked` property in the accessibility tree.

## File Uploads

For `<input type="file">` elements, use the `upload` action with an absolute or relative file path:

```json
{
  "action": "upload",
  "ref": "<file-input-ref>",
  "path": "/path/to/local/file.pdf"
}
```

> **Note:** The file must be accessible on the local filesystem where the agent is running.

## Form Submission

Forms can be submitted in two ways:

### 1. Click the Submit Button

```json
{
  "action": "click",
  "ref": "<submit-button-ref>"
}
```

### 2. Press Enter on a Focused Input

```json
{
  "action": "press",
  "ref": "<input-ref>",
  "key": "Enter"
}
```

## Handling Validation Errors

After submission, always take a snapshot to check for validation errors:

```json
{ "action": "snapshot" }
```

Look for:
- Elements with `role=alert` or `aria-live` regions
- Fields with `aria-invalid=true`
- Error message text near the relevant inputs

If errors are present, correct the field values and resubmit.

## Multi-Step Forms / Wizards

For paginated or wizard-style forms:
1. Fill and validate each step individually
2. Click the "Next" or "Continue" button
3. Take a snapshot to confirm navigation to the next step
4. Repeat until the final submission step

## Date and Time Inputs

Native date inputs accept ISO 8601 format strings:

```json
{
  "action": "fill",
  "ref": "<date-input-ref>",
  "value": "2024-03-15"
}
```

For time inputs:

```json
{
  "action": "fill",
  "ref": "<time-input-ref>",
  "value": "14:30"
}
```

For custom date pickers, interact with the calendar widget by clicking day cells directly.

## Best Practices

- Always take a snapshot before and after form interactions to verify state
- Use label-based selectors when possible for resilience against DOM changes
- Check `aria-required` attributes to identify mandatory fields before submission
- Handle `aria-disabled` fields — do not attempt to fill disabled inputs
- For sensitive fields (passwords, credit cards), ensure the page is served over HTTPS before interacting

## Common Pitfalls

| Issue | Cause | Resolution |
|---|---|---|
| Fill has no effect | Input is read-only or disabled | Check `aria-readonly` / `aria-disabled` in snapshot |
| Select value not applied | Custom dropdown, not native `<select>` | Use click-based interaction sequence |
| Form submits with errors | Required fields missed | Scan snapshot for `aria-required=true` fields |
| File upload fails | Path not accessible | Verify file exists and agent has read permissions |
