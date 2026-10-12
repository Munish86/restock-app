// Where uploaded sheets, images and run reports are kept: Cloudflare R2 in production, local disk in
// development. Both sit behind the same interface, so nothing else changes.
import fs from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface FileStorage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export class FileMissingError extends Error {}

// Keys look like "my-store.myshopify.com/files/<id>". They are built by the app, never taken from
// a merchant's file name, but are still checked so a bad key can never leave the shop's folder.
export function checkKey(key: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com(\/[\w.-]+)+$/i.test(key) || key.split("/").includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return key;
}

export const shopPrefix = (shop: string) => checkKey(`${shop}/files`);
export const fileKey = (shop: string, id: string) => checkKey(`${shop}/files/${id}`);
export const reportKey = (shop: string, jobId: string) => checkKey(`${shop}/files/report-${jobId}.json`);

export class LocalDiskStorage implements FileStorage {
  constructor(private root: string) {}

  private file(key: string) {
    return path.join(this.root, ...checkKey(key).split("/"));
  }

  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
  }

  async get(key: string) {
    try {
      return await fs.readFile(this.file(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new FileMissingError(key);
      throw e;
    }
  }

  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    const dir = path.join(this.root, ...checkKey(prefix).split("/"));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Cloudflare R2 through its S3-compatible API
export class R2Storage implements FileStorage {
  private s3: S3Client;

  constructor(
    private bucket: string,
    opts: { accountId: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, data: Buffer, contentType = "application/octet-stream") {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: checkKey(key), Body: data, ContentType: contentType }),
    );
  }

  async get(key: string) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") throw new FileMissingError(key);
      throw e;
    }
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }));
  }

  async deletePrefix(prefix: string) {
    const Prefix = checkKey(prefix) + "/";
    let ContinuationToken: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix, ContinuationToken }));
      const keys = (page.Contents || []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
}

let storage: FileStorage | null = null;

// R2 when R2_BUCKET is set, otherwise a local folder (STORAGE_DIR, default ./storage)
export function getStorage(): FileStorage {
  if (storage) return storage;
  const { R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (R2_BUCKET) {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      throw new Error("R2_BUCKET is set, so R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are needed too.");
    }
    storage = new R2Storage(R2_BUCKET, {
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    });
  } else {
    if (process.env.NODE_ENV === "production") {
      console.warn("R2_BUCKET is not set: files are stored on local disk, which is lost when the server is replaced.");
    }
    storage = new LocalDiskStorage(path.resolve(process.env.STORAGE_DIR || "storage"));
  }
  return storage;
}

// For tests
export function setStorage(s: FileStorage | null) {
  storage = s;
}
