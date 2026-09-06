import { $ } from "bun";
import { mkdirSync } from "fs";

const targets = [
  { target: "bun-linux-x64", outfile: "dist/pboss-linux-x64" },
  { target: "bun-linux-arm64", outfile: "dist/pboss-linux-arm64" },
  { target: "bun-linux-x64-musl", outfile: "dist/pboss-linux-x64-musl" },
  { target: "bun-linux-arm64-musl", outfile: "dist/pboss-linux-arm64-musl" },
  { target: "bun-darwin-x64", outfile: "dist/pboss-darwin-x64" },
  { target: "bun-darwin-arm64", outfile: "dist/pboss-darwin-arm64" },
  { target: "bun-windows-x64", outfile: "dist/pboss-windows-x64.exe" },
  { target: "bun-windows-arm64", outfile: "dist/pboss-windows-arm64.exe" },
];

mkdirSync("dist", { recursive: true });

for (const { target, outfile } of targets) {
  console.log(`Building target: ${target} -> ${outfile}...`);
  await $`bun build --compile --minify --bytecode --target=${target} ./src/index.ts --outfile=${outfile}`;
}

console.log("All target binaries built successfully in dist/");
