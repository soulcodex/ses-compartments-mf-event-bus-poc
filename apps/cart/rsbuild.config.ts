import { defineConfig } from "@rsbuild/core";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";

export default defineConfig({
  server: {
    port: 3002,
    cors: {
      origin: ["http://localhost:3000"],
    },
  },
  output: { distPath: { root: "dist" } },
  plugins: [
    pluginModuleFederation({
      name: "cartRemote",
      filename: "remoteEntry.js",
      exposes: {
        "./plugin": "./src/plugin.ts",
        "./realm": "./src/realm.ts",
      },
      shared: [],
    }),
  ],
});


