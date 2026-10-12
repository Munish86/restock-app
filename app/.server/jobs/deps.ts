// The real database, storage and Shopify wiring for processJob
import { shopifyFor } from "../clients";
import { runImport } from "../imports";
import { getStorage } from "../storage";
import { syncShop } from "../sync";
import type { ProcessDeps } from "./process";
import type { JobQueue } from "./queue";
import { prismaJobRepo } from "./service";

export function productionDeps(opts: { queue?: JobQueue; shuttingDown?: () => boolean } = {}): ProcessDeps {
  return {
    repo: prismaJobRepo(opts.queue),
    storage: getStorage(),
    handlers: {
      sync: (ctx) => syncShop(ctx, shopifyFor(ctx.job.shop), { full: ctx.job.options?.full === true }),
      "import-plan": (ctx) => runImport(ctx, false),
      import: (ctx) => runImport(ctx, true),
    },
    shuttingDown: opts.shuttingDown,
  };
}
