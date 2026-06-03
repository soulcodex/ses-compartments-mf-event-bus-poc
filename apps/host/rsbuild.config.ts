import { defineConfig } from "@rsbuild/core";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";

export default defineConfig({
  server: {
    port: 3000,
    cors: {
      origin: ["http://localhost:3000"],
    },
  },
  source: {
    entry: { index: "./src/main.ts" },
  },
  html: {
    template: "./index.html",
  },
  output: {
    distPath: { root: "dist" },
  },
  plugins: [
    pluginModuleFederation({
      name: "host",
      remotes: {
        catalogRemote: "catalogRemote@http://localhost:3001/mf-manifest.json",
        cartRemote: "cartRemote@http://localhost:3002/mf-manifest.json",
      },
      shared: [],
    }),
  ],
  tools: {
    rspack: {
      module: {
        rules: [
          { resourceQuery: /raw/, type: "asset/source" },
        ],
      },
    },
  },
});
