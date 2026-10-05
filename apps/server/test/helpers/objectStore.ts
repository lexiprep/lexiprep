import type { ObjectStore } from "../../src/storage/bookFiles.js";

/** An in-memory bucket for tests. `failNext` makes the next call of that kind throw. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  failNext: "put" | "get" | "delete" | null = null;

  private maybeFail(op: "put" | "get" | "delete"): void {
    if (this.failNext === op) {
      this.failNext = null;
      throw new Error(`bucket ${op} failed`);
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.maybeFail("put");
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer | null> {
    this.maybeFail("get");
    return this.objects.get(key) ?? null;
  }
  async head(key: string): Promise<{ size: number } | null> {
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async delete(key: string): Promise<void> {
    this.maybeFail("delete");
    this.objects.delete(key);
  }
  async presignPut(key: string, expiresSeconds: number): Promise<string> {
    return `https://bucket.test/${key}?X-Amz-Expires=${expiresSeconds}&X-Amz-Signature=test`;
  }
}
