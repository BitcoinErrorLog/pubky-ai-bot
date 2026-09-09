import { parentPort } from "node:worker_threads";

parentPort.once("message", (body) => {
  parentPort.postMessage({ received: body.length });
});
