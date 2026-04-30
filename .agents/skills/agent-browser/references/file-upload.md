# File Upload Reference

## Overview

This reference covers file upload interactions using the browser agent skill, including single file uploads, multiple file uploads, drag-and-drop scenarios, and validation handling.

## Basic File Upload

### Using Input Element

The most common file upload pattern involves interacting with an `<input type="file">` element:

```bash
# Navigate to page with file upload
browser_action navigate "https://example.com/upload"

# Take snapshot to identify the file input element
browser_action snapshot

# Upload a file using the input ref from snapshot
browser_action upload_file --ref "s1e5" --path "/path/to/local/file.pdf"
```

### Snapshot-Based File Upload

Always take a snapshot first to get the correct element reference:

```bash
# Get current page state
browser_action snapshot

# Response includes refs like:
# - s1e5: <input type="file" accept=".pdf,.doc" />
# - s1e8: <button>Upload Document</button>

# Upload using the identified ref
browser_action upload_file --ref "s1e5" --path "~/documents/report.pdf"
```

## Multiple File Uploads

### Sequential Uploads

```bash
# For inputs that accept multiple files
browser_action upload_file --ref "s1e5" --paths "file1.jpg,file2.jpg,file3.jpg"

# Or upload files one at a time if the form supports it
browser_action upload_file --ref "s1e5" --path "image1.jpg"
browser_action snapshot
browser_action upload_file --ref "s1e12" --path "image2.jpg"
```

### Verifying Multiple File Selection

```bash
# After uploading, verify files are queued
browser_action snapshot
# Look for file list elements showing selected files
# Example refs: s2e3: "file1.jpg (245 KB)", s2e4: "file2.jpg (189 KB)"
```

## Drag and Drop Upload

Some upload interfaces use drag-and-drop zones rather than file inputs:

```bash
# Identify the drop zone from snapshot
browser_action snapshot
# s1e7: <div class="dropzone" data-testid="file-drop-zone">

# Use drag_and_drop with file path for dropzone uploads
browser_action drag_file --ref "s1e7" --path "/path/to/file.csv"

# Verify upload initiated
browser_action snapshot
# Look for progress indicator or file name appearing in drop zone
```

## Handling Upload Progress

### Waiting for Upload Completion

```bash
# After initiating upload, wait for progress to complete
browser_action upload_file --ref "s1e5" --path "large-video.mp4"

# Poll for completion - look for success indicators
browser_action snapshot
# Check for: progress bar at 100%, success message, or file appearing in list

# If upload is async, use wait with a condition
browser_action wait --selector ".upload-success" --timeout 30000
```

### Progress Indicators

```bash
# Some UIs show upload progress
browser_action snapshot
# s2e6: <div class="progress-bar" style="width: 45%">45%</div>

# Wait until progress reaches 100%
browser_action wait --selector ".upload-complete"
browser_action snapshot
```

## File Type Validation

### Handling Accept Attribute Restrictions

```bash
# Check what file types are accepted before uploading
browser_action snapshot
# s1e5: <input type="file" accept="image/jpeg,image/png,image/gif">

# Only upload accepted file types to avoid validation errors
browser_action upload_file --ref "s1e5" --path "photo.jpg"

# If wrong file type is uploaded, look for error messages
browser_action snapshot
# s2e9: <span class="error">Only image files are accepted</span>
```

### Client-Side Validation Errors

```bash
# After upload attempt, check for validation messages
browser_action snapshot

# Common error ref patterns:
# - s2e10: "File size exceeds 10MB limit"
# - s2e11: "Invalid file format. Accepted: PDF, DOC, DOCX"
# - s2e12: "Please select a file before submitting"

# Extract error text for logging
browser_action get_text --ref "s2e10"
```

## Form Submission After Upload

### Combined Upload and Submit

```bash
# Full workflow: navigate, upload, fill form, submit
browser_action navigate "https://example.com/submit-document"
browser_action snapshot

# Upload the file
browser_action upload_file --ref "s1e3" --path "contract.pdf"

# Fill additional form fields
browser_action fill --ref "s1e8" --value "John Doe"
browser_action fill --ref "s1e9" --value "Contract for Q4 2024"

# Submit the form
browser_action click --ref "s1e15"

# Verify submission success
browser_action wait --selector ".submission-confirmed"
browser_action snapshot
```

## Common Issues and Troubleshooting

### Hidden File Inputs

Some file inputs are hidden and triggered by a visible button:

```bash
# The visible button triggers the hidden input
browser_action snapshot
# s1e4: <button class="upload-btn">Choose File</button>
# s1e5: <input type="file" style="display:none" />

# Click the visible button to open file dialog, then interact with hidden input
browser_action click --ref "s1e4"
browser_action upload_file --ref "s1e5" --path "document.pdf"
```

### Iframe-Contained Upload Forms

```bash
# If upload form is inside an iframe, switch context first
browser_action switch_frame --ref "s1e2"
browser_action snapshot
browser_action upload_file --ref "s2e3" --path "file.pdf"
browser_action switch_frame --main
```

## Related References

- [Form Interaction](./form-interaction.md) — General form filling and submission
- [Element Interaction](./element-interaction.md) — Clicking and interacting with elements
- [Snapshot Refs](./snapshot-refs.md) — Understanding element references
- [Text Extraction](./text-extraction.md) — Reading validation messages and status text
