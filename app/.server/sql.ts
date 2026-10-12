// Batched INSERT ... ON CONFLICT for the sync, which writes thousands of rows at a time.
// One statement per batch instead of one per row: a 5,000-variant store syncs in seconds, not minutes.
import { Prisma } from "@prisma/client";

// "timestamp" = Prisma DateTime (timestamp(3), UTC, no zone): pass sqlTime(date)
export type SqlType = "text" | "int" | "bool" | "numeric" | "date" | "timestamp";

export interface Column {
  name: string;
  type: SqlType;
}

interface Executor {
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`Bad SQL identifier: ${s}`);
  return `"${s}"`;
};

// Postgres allows 65,535 parameters per statement; stay well under it
const MAX_PARAMS = 30_000;

export async function upsertRows(
  db: Executor,
  table: string,
  columns: Column[],
  rows: unknown[][],
  opts: { key: string[]; update: string[] },
): Promise<number> {
  if (!rows.length) return 0;
  const cols = Prisma.raw(columns.map((c) => ident(c.name)).join(", "));
  const conflict = Prisma.raw(opts.key.map(ident).join(", "));
  const action = opts.update.length
    ? Prisma.raw(`UPDATE SET ${opts.update.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ")}`)
    : Prisma.raw("NOTHING");
  const per = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  let n = 0;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    // Every value carries an explicit cast, so Postgres never guesses a type (dates stay plain days)
    const values = Prisma.join(
      chunk.map((r) => Prisma.sql`(${Prisma.join(r.map((v, j) => Prisma.sql`${v}::${Prisma.raw(columns[j].type)}`))})`),
    );
    n += await db.$executeRaw(
      Prisma.sql`INSERT INTO ${Prisma.raw(ident(table))} (${cols}) VALUES ${values} ON CONFLICT (${conflict}) DO ${action}`,
    );
  }
  return n;
}

// A Date as Prisma stores it: UTC wall time without a zone
export const sqlTime = (d: Date) => d.toISOString().replace("Z", "");
