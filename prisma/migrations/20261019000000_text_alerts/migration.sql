-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "msgCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "msgMonth" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "MessageLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageLog_shop_createdAt_idx" ON "MessageLog"("shop", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

