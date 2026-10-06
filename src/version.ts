import packageJson from "../package.json" with { type: "json" };

/** Shared by the CLI and dashboard; embedded into release bundles at build time. */
export const VERSION = packageJson.version;
