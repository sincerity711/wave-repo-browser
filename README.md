# Wave Repo Browser

`wrb` means `Wave Repo Browser`.

It is a small Wave companion for Claude Code sessions. Run it inside a repo and it opens a Wave web block with a VS Code-style file explorer. Double-clicking a file calls `wsh view <absolute-path>`, so Wave's native viewer still handles the actual file preview.

## Usage

```bash
wrb
```

By default it uses the current git repo root and opens the Wave web block.

In a local Wave shell, `wrb` listens on `127.0.0.1` with a random port.

In a Wave remote shell, detected by `WAVETERM_CONN`, `wrb` automatically switches to remote mode:

```bash
wrb
```

Remote mode listens on:

```text
0.0.0.0:17876
```

and opens:

```text
http://<auto-detected-remote-ip>:17876
```

To point at a specific directory:

```bash
wrb /path/to/repo
```

You can override network settings:

```bash
wrb --remote --host 0.0.0.0 --port 17876 --public-host 192.168.1.20
wrb --local --port 0
```

For local testing without opening Wave:

```bash
wrb . --no-open
```

## Development

```bash
bun install
bun run dev
```

Build a standalone executable:

```bash
bun run build
mkdir -p ~/.local/share/wave-repo-browser ~/bin
cp dist/wrb ~/.local/share/wave-repo-browser/wrb-bin
cp scripts/wrb-launcher ~/bin/wrb
chmod +x ~/.local/share/wave-repo-browser/wrb-bin ~/bin/wrb
```

On this machine the command is also installed as:

```bash
/opt/homebrew/bin/wrb
```

The UI uses VS Code's open-source `@vscode/codicons` package. The build embeds the font into `src/codicons-embedded.mjs`, so the final binary does not need `node_modules` at runtime.

## Remote Install

From the Mac/local project:

```bash
scripts/package-remote-wrb
```

Then in the Wave remote shell:

```bash
bash <(wsh file cat wsh://local/~/Documents/Codex/2026-05-07/python-node-js-ui-html-js/scripts/install-remote-wrb)
```

The installer copies the local source bundle into the remote machine, installs Bun if needed, builds a remote-native executable, and installs:

```text
~/.local/bin/wrb
```

If `~/.local/bin` is not on the remote PATH, add:

```bash
export PATH="$HOME/.local/bin:$PATH"
```
