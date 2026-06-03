import { defineConfig } from "@rsbuild/core";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";

export default defineConfig({
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
        // In dev mode these point to running remote dev servers.
        // The CompartmentLoader fetches these URLs as text — it does NOT
        // use MF's standard script-injection loader.
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