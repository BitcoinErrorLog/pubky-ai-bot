import pg from "pg";

function result(rows = []) {
  return { rows, rowCount: rows.length };
}

class FakeClient {
  async query() {
    return result();
  }
  release() {}
}

class FakePool {
  async query() {
    return result();
  }
  async connect() {
    return new FakeClient();
  }
  async end() {}
  on() {
    return this;
  }
}

pg.Pool = FakePool;
