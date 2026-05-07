import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "node_modules", "@vscode", "codicons", "dist");
const cssPath = path.join(dist, "codicon.css");
const fontPath = path.join(dist, "codicon.ttf");
const outPath = path.join(root, "src", "codicons-embedded.mjs");

let css = await fs.readFile(cssPath, "utf8");
const font = await fs.readFile(fontPath);
const dataUrl = `data:font/ttf;base64,${font.toString("base64")}`;

css = css.replace(/url\([^)]*codicon\.ttf[^)]*\)/g, `url("${dataUrl}")`);

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(
  outPath,
  `export const CODICON_CSS = ${JSON.stringify(css)};\n`,
);
