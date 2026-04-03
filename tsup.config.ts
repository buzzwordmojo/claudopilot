import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    dts: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["mcp-server/src/index.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "mcp-server/dist",
    clean: true,
    sourcemap: false,
    dts: false,
    external: [/@modelcontextprotocol\/sdk/, "zod"],
  },
]);
