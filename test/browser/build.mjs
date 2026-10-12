// Bundles the real Restock pages with a fake API (entry.tsx) for the browser test
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
await esbuild.build({
  entryPoints: [here + "entry.tsx"],
  bundle: true,
  outfile: here + ".out/bundle.js",
  jsx: "automatic",
  loader: { ".module.css": "local-css" },
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "warning",
});
