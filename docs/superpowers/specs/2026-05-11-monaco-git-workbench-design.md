# Monaco Git Workbench Design

## Goal

Upgrade WRB from a file-tree launcher into a VS Code-style workbench: a left sidebar for Explorer and Source Control, and a right editor area powered by Monaco for text preview and git diffs.

## Scope

The first implementation will provide read-only file preview, read-only git diff review, and Wave-native fallback actions. It will not add editing, staging, unstaging, discard, commit, branch switching, or merge-conflict resolution.

## User Experience

WRB opens as a two-column layout. The left side stays compact and contains an activity bar with Explorer and Source Control icons. The Explorer view keeps the current file tree behavior, but selecting a text file opens it in the Monaco editor on the right. Double-click and the context menu still offer `Open in Wave` for native Wave viewing.

The Source Control view lists changed files in VS Code-like groups:

- `Staged Changes`
- `Changes`
- `Untracked`

Selecting a changed file opens a Monaco diff editor on the right. The diff title shows the file path and whether the selected version is staged, worktree, or untracked. The Source Control view includes refresh and open-in-Wave actions.

For image, binary, missing, unreadable, or oversized files, WRB shows a compact fallback state in the editor area with the file path and an `Open in Wave` action. This keeps WRB usable without trying to make Monaco handle formats it is not meant to display.

## Architecture

The existing Bun HTTP service remains the only backend. It continues to serve one HTML app from `src/main.mjs`, and it gains API endpoints for file content, git status, and git diff data.

The frontend becomes a small workbench inside the existing HTML string:

- Sidebar state owns the active view: Explorer or Source Control.
- Explorer state owns loaded directory rows and selection.
- Source Control state owns status groups, selected change, and refresh state.
- Editor state owns the active Monaco model or diff models.

Monaco will be integrated through the open-source `monaco-editor` package, licensed MIT. The preferred implementation is local static Monaco assets served by WRB so local and remote Wave sessions do not require internet access. If Bun's compiled binary cannot embed or locate those assets reliably, WRB will copy the needed Monaco files into a runtime asset directory as part of build/install and serve them from there.

## Backend API

### `GET /api/file`

Query parameters:

- `root`: browse root
- `path`: relative file path

Behavior:

- Resolve the requested path through the existing `safeResolve` boundary.
- Reject directories.
- Reject files larger than the configured preview limit.
- Detect likely binary content by sampling bytes.
- Return UTF-8 text content for previewable files.

Response:

```json
{
  "path": "src/main.mjs",
  "absPath": "/repo/src/main.mjs",
  "language": "javascript",
  "content": "...",
  "size": 12345,
  "readOnly": true
}
```

### `GET /api/git/status`

Query parameters:

- `root`: browse root

Behavior:

- Verify the root is inside a git worktree.
- Use `git status --porcelain=v1 -z --branch`.
- Return branch metadata and grouped changes.
- Preserve rename source and destination when git reports renames.

Response:

```json
{
  "root": "/repo",
  "repoRoot": "/repo",
  "branch": "main",
  "ahead": 0,
  "behind": 0,
  "staged": [],
  "unstaged": [
    {
      "path": "src/main.mjs",
      "oldPath": "",
      "status": "M",
      "absPath": "/repo/src/main.mjs"
    }
  ],
  "untracked": []
}
```

### `GET /api/git/diff`

Query parameters:

- `root`: browse root
- `path`: relative file path from repo root
- `area`: `staged`, `worktree`, or `untracked`

Behavior:

- Resolve the repo root through git and ensure the target remains in the repo.
- For `staged`, use `git diff --cached -- <path>`.
- For `worktree`, use `git diff -- <path>`.
- For `untracked`, synthesize a diff against an empty old file for previewable text files.
- Return a structured pair of old/new contents for Monaco DiffEditor instead of only returning raw patch text.

Response:

```json
{
  "path": "src/main.mjs",
  "area": "worktree",
  "language": "javascript",
  "original": "...",
  "modified": "...",
  "originalLabel": "HEAD",
  "modifiedLabel": "Working Tree"
}
```

## Git Data Model

WRB will treat staged and unstaged changes independently because the same file can appear in both groups. A file with staged changes and additional worktree changes appears once under `Staged Changes` and once under `Changes`.

Status mapping:

- `M`: modified
- `A`: added
- `D`: deleted
- `R`: renamed
- `C`: copied
- `U`: unmerged or unknown conflict-like state
- `?`: untracked

Renames are displayed as the destination path with the old path shown as secondary text.

## Editor Behavior

The right editor has these modes:

- Empty state: no file selected.
- Text preview: Monaco editor, read-only.
- Diff preview: Monaco DiffEditor, read-only.
- Fallback: non-previewable file, missing file, or error.

Language IDs are inferred from file extension with a small local map. Unknown extensions use plaintext.

Preview limits:

- Text preview limit defaults to 1 MiB.
- Diff preview refuses binary files and oversized untracked files.
- Large tracked diffs should still rely on git output and Monaco rendering, but the UI should show a clear error if command output exceeds the backend buffer.

## Error Handling

Backend APIs return JSON errors with concrete HTTP status codes: `400` for invalid input, `403` for escaped paths, `404` for missing files, `409` for non-previewable content, and `500` for unexpected command or filesystem failures. The frontend shows errors in the editor area or Source Control status line instead of using alert boxes for normal preview/diff failures.

Expected failures include:

- Root is not a git repository.
- File escapes browse root or repo root.
- File no longer exists.
- File is binary.
- File is too large to preview.
- Git command fails.
- Monaco asset loading fails.

## Testing

Backend tests use Node's test runner and temporary git repositories. They cover:

- File preview accepts text files and rejects directories, binary files, escaped paths, and oversized files.
- Git status grouping handles staged, unstaged, untracked, deleted, and renamed files.
- Git diff returns correct original/modified content for staged and worktree changes.
- Untracked diff returns empty original content and current file content.
- Existing service reuse tests continue to pass.

Frontend verification will use a local WRB server and browser checks:

- Explorer selection opens a text file in Monaco.
- Source Control refresh lists changed files.
- Selecting a changed file opens Monaco DiffEditor.
- Open-in-Wave remains available from file rows and fallback states.

## Build And Packaging

`package.json` gains a dependency on `monaco-editor`. The build must verify:

- `bun run check` passes.
- The compiled `dist/wrb` can serve Monaco assets.
- Remote install keeps Monaco assets available without internet access.

If standalone Monaco packaging is too brittle, the implementation will prefer a deterministic local asset copy step over CDN loading.
