import { context } from "esbuild";

const production = process.argv[2] === "production";
const build = await context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2021",
  minify: production,
  sourcemap: production ? false : "inline",
  outfile: "main.js",
  logLevel: "info"
});

if (production) {
  await build.rebuild();
  await build.dispose();
} else {
  await build.watch();
}
