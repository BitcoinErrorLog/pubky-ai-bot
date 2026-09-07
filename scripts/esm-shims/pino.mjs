export default function pino() {
  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return log;
    },
  };
  return log;
}
