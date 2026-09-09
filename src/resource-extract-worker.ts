import { parentPort } from "node:worker_threads";
import { extractResourceText } from "./resource-fetch.js";

const port = parentPort;
if (!port) throw new Error("resource extraction worker requires a parent port");

port.once("message", (body: string) => {
  port.postMessage(extractResourceText(body));
});
