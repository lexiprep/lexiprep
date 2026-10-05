import type { AwsClient } from "aws4fetch";

/**
 * A thin S3 client over `aws4fetch` (request signing) and `fetch`, covering exactly what
 * book-file storage needs: put / get / head / delete, plus a signed upload URL. Works
 * against Cloudflare R2 and any S3-compatible store; URLs are path-style
 * (`<endpoint>/<bucket>/<key>`). See docs/specs/14-book-file-storage.md.
 */
export interface S3Config {
  /** e.g. `https://<account-id>.r2.cloudflarestorage.com` */
  endpoint: string;
  /** R2 ignores it but the signature needs one; R2's convention is `auto`. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

/** Don't hash the body into the signature — a book can be hundreds of MB. */
const UNSIGNED = { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" };

export class S3Client {
  private constructor(
    private readonly config: S3Config,
    private readonly aws: AwsClient,
  ) {}

  /**
   * `aws4fetch` is imported here, on first use, not at module load: a deploy never
   * installs dependencies (AGENTS.md → Deploying), so a release that adds one must not
   * stop the server from booting before `make install` has been run on the box.
   */
  static async create(config: S3Config): Promise<S3Client> {
    const { AwsClient } = await import("aws4fetch");
    return new S3Client(
      config,
      new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: "s3",
        region: config.region,
        retries: 3,
      }),
    );
  }

  private url(key: string): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `${base}/${encodeURIComponent(this.config.bucket)}/${path}`;
  }

  private async fail(action: string, key: string, res: Response): Promise<never> {
    const body = await res.text().catch(() => "");
    throw new S3Error(
      `${action} ${key} failed: ${res.status} ${body.slice(0, 300)}`.trim(),
      res.status,
    );
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), {
      method: "PUT",
      body: data,
      headers: { ...UNSIGNED, ...(contentType ? { "content-type": contentType } : {}) },
    });
    if (!res.ok) await this.fail("PUT", key, res);
    await res.arrayBuffer(); // drain so the connection is released
  }

  /** The object's bytes, or null when it doesn't exist. */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.aws.fetch(this.url(key), { method: "GET" });
    if (res.status === 404) {
      await res.arrayBuffer();
      return null;
    }
    if (!res.ok) await this.fail("GET", key, res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** The object's size, or null when it doesn't exist. */
  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.aws.fetch(this.url(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail("HEAD", key, res);
    return { size: Number(res.headers.get("content-length") ?? 0) };
  }

  /** Deleting a missing object is not an error (S3 answers 204 either way). */
  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) await this.fail("DELETE", key, res);
    await res.arrayBuffer();
  }

  /**
   * A URL that authorizes one `PUT` of this key for `expiresSeconds`, with the signature
   * in the query string — what a browser uses to upload straight to the bucket.
   */
  async presignPut(key: string, expiresSeconds: number): Promise<string> {
    const signed = await this.aws.sign(`${this.url(key)}?X-Amz-Expires=${expiresSeconds}`, {
      method: "PUT",
      aws: { signQuery: true },
    });
    return signed.url;
  }
}
