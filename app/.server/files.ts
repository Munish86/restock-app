// Supplier sheets merchants upload for import. The bytes go to file storage, a StoredFile row keeps the
// original name. A file name is only ever shown; it never becomes a storage path.
import prisma from "../db.server";
import { MAX_SHEET_BYTES, type SheetSource } from "./core/sheet";
import { fileKey, FileMissingError, getStorage } from "./storage";

const SHEET_EXT = /\.(xlsx|xlsm|xls|csv|txt)$/i;
const MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  txt: "text/plain",
};

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// "C:\\files\\suppliers.xlsx" -> "suppliers.xlsx" (kept for display only)
export function cleanName(raw: string): string {
  const name = String(raw ?? "")
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .pop() ?? "";
  return name.length > 200 ? name.slice(-200) : name;
}

export function checkUpload(rawName: string, size: number): { name: string; mime: string } {
  const name = cleanName(rawName);
  if (!name) throw new UploadError("The file has no name.");
  if (!SHEET_EXT.test(name)) throw new UploadError(`"${name}" is not an Excel or CSV file.`);
  if (!Number.isFinite(size) || size <= 0) throw new UploadError(`"${name}" is empty.`);
  if (size > MAX_SHEET_BYTES) {
    throw new UploadError(`"${name}" is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_SHEET_BYTES / 1024 / 1024} MB.`, 413);
  }
  return { name, mime: MIME[name.split(".").pop()!.toLowerCase()] || "application/octet-stream" };
}

// A new sheet replaces the previous one: only one is kept per store
export async function saveSheet(shop: string, rawName: string, data: Buffer) {
  const { name, mime } = checkUpload(rawName, data.length);
  const old = await prisma.storedFile.findMany({ where: { shop, kind: "sheet" }, select: { id: true, storageKey: true } });
  const row = await prisma.storedFile.create({ data: { shop, kind: "sheet", name, size: data.length, mime, storageKey: "" } });
  const key = fileKey(shop, row.id);
  try {
    await getStorage().put(key, data, mime);
  } catch (e) {
    await prisma.storedFile.delete({ where: { id: row.id } });
    throw e;
  }
  const file = await prisma.storedFile.update({ where: { id: row.id }, data: { storageKey: key } });
  for (const o of old) {
    if (o.storageKey) await getStorage().delete(o.storageKey).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: o.id } });
  }
  return { id: file.id, name: file.name, size: file.size, createdAt: file.createdAt };
}

export async function currentSheet(shop: string) {
  return prisma.storedFile.findFirst({
    where: { shop, kind: "sheet" },
    select: { id: true, name: true, size: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function sheetSourceFor(shop: string, src: { source: "file" | "google"; fileId?: string; url?: string }): Promise<SheetSource> {
  if (src.source === "google") {
    if (!src.url) throw new Error("Paste the Google Sheet link first.");
    return { kind: "google", url: src.url };
  }
  const file = src.fileId
    ? await prisma.storedFile.findFirst({ where: { shop, id: src.fileId, kind: "sheet" } })
    : await prisma.storedFile.findFirst({ where: { shop, kind: "sheet" }, orderBy: { createdAt: "desc" } });
  if (!file?.storageKey) throw new Error("Upload the sheet again: the uploaded file was not found (files are kept for 7 days).");
  try {
    return { kind: "file", name: file.name, data: await getStorage().get(file.storageKey) };
  } catch (e) {
    if (e instanceof FileMissingError) throw new Error("Upload the sheet again: the uploaded file has expired.");
    throw e;
  }
}
