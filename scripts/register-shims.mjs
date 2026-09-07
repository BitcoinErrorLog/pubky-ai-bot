import { register } from "node:module";

register(new URL("./shim-loader.mjs", import.meta.url).href);
