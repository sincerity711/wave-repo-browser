# Wave Repo Browser

`wrb` means `Wave Repo Browser`.

It is a small Wave companion for Claude Code sessions. Run it inside a repo and it opens a Wave web block with a VS Code-style file explorer. Double-clicking a file calls `wsh view <absolute-path>`, so Wave's native viewer still handles the actual file preview.

## Usage

```bash
wrb
```

By default it browses the current working directory and opens the Wave web block.
The command starts a reusable browser service in the background when needed and
returns the shell, similar to `wsh view .`. The service is not tied to one
folder; each `wrb` invocation opens the service with that shell's current
directory as the browse root.

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

To browse a specific directory:

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
wrb --no-open
```

For foreground debugging:

```bash
wrb --foreground
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

Install to a remote Linux/WSL machine from this local Mac repo:

```bash
scripts/install-to-remote-wrb ciro@win-wsl
```

This builds a Linux x64 standalone binary locally with Bun, copies it over SSH, and installs:

```text
~/.local/bin/wrb
```

The installer resolves the SSH host with `ssh -G` and writes it to the remote
config so Wave opens the Windows/remote-machine address instead of a WSL NAT
address. Override it when needed:

```bash
WRB_PUBLIC_HOST=10.59.147.90 scripts/install-to-remote-wrb ciro@win-wsl
```

For Linux arm64:

```bash
scripts/install-to-remote-wrb <ssh-host> --target bun-linux-arm64
```

If `~/.local/bin` is not on the remote PATH, add this on the remote machine:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then in the Wave remote shell:

```bash
wrb
```
