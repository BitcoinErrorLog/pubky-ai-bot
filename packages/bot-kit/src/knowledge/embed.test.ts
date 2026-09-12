import { beforeEach, describe, expect, it, vi } from "vitest";

type Extractor = (text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: number[] }>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadModule(pipeline: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("@huggingface/transformers", () => ({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline,
  }));
  return import("./embed.js");
}

describe("local embedding teardown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.JEB_MODEL_LOCAL_ONLY;
  });

  it("disposes a loaded extractor once", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const extractor: Extractor & { dispose: () => Promise<void> } = Object.assign(
      async () => ({ data: Array.from({ length: 384 }, () => 0) }),
      { dispose },
    );
    const pipeline = vi.fn().mockResolvedValue(extractor);
    const mod = await loadModule(pipeline);

    await mod.localEmbedder().embed(["ready"]);
    await Promise.all([mod.disposeLocalEmbeddings(), mod.disposeLocalEmbeddings()]);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("awaits an in-flight load before disposing its extractor", async () => {
    const loaded = deferred<Extractor & { dispose: () => Promise<void> }>();
    const dispose = vi.fn().mockResolvedValue(undefined);
    const extractor: Extractor & { dispose: () => Promise<void> } = Object.assign(
      async () => ({ data: Array.from({ length: 384 }, () => 0) }),
      { dispose },
    );
    const pipeline = vi.fn().mockReturnValue(loaded.promise);
    const mod = await loadModule(pipeline);

    const embedding = mod.localEmbedder().embed(["in flight"]);
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledOnce());
    const teardown = mod.disposeLocalEmbeddings();
    expect(dispose).not.toHaveBeenCalled();

    loaded.resolve(extractor);
    await Promise.all([embedding, teardown]);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("tolerates a rejected load without hiding teardown completion", async () => {
    const pipeline = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const mod = await loadModule(pipeline);

    await expect(mod.localEmbedder().embed(["reject"])).rejects.toThrow("model unavailable");
    await expect(mod.disposeLocalEmbeddings()).resolves.toBeUndefined();
  });

  it("does not start a fresh load until teardown completes", async () => {
    const disposal = deferred<void>();
    const firstDispose = vi.fn().mockImplementation(() => disposal.promise);
    const extractor = (dispose: () => Promise<void>): Extractor & { dispose: () => Promise<void> } =>
      Object.assign(async () => ({ data: Array.from({ length: 384 }, () => 0) }), { dispose });
    const first = extractor(firstDispose);
    const second = extractor(vi.fn().mockResolvedValue(undefined));
    const pipeline = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const mod = await loadModule(pipeline);

    await mod.localEmbedder().embed(["initial"]);
    const teardown = mod.disposeLocalEmbeddings();
    await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledOnce());

    const loadingAfterDispose = mod.localEmbedder().embed(["after teardown"]);
    await Promise.resolve();
    expect(pipeline).toHaveBeenCalledOnce();

    disposal.resolve();
    await Promise.all([teardown, loadingAfterDispose]);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });
});
