import { parentPort } from "node:worker_threads";

parentPort?.once("message", () => {
  while (true) {
    // Deliberately occupy only the disposable test worker.
  }
});
