-- Yedek boyutu BigInt: 2 GB ustu veritabaninin yedegi Int'e sigmiyordu. Ayrica yedek dosya
-- bicimi (1: eski, 2: sikistirilmis akis). backups tablosunda yabanci anahtar yok; tablo
-- yeniden kurulur, mevcut kayitlar format=1 olarak kopyalanir.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branch_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "format" INTEGER NOT NULL DEFAULT 1,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "checksum" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "device_id" TEXT,
    "sync_state" TEXT NOT NULL DEFAULT 'pending'
);
INSERT INTO "new_backups" ("branch_id", "checksum", "created_at", "created_by", "deleted_at", "device_id", "encrypted", "id", "path", "size_bytes", "sync_state", "type", "updated_at", "version") SELECT "branch_id", "checksum", "created_at", "created_by", "deleted_at", "device_id", "encrypted", "id", "path", "size_bytes", "sync_state", "type", "updated_at", "version" FROM "backups";
DROP TABLE "backups";
ALTER TABLE "new_backups" RENAME TO "backups";
CREATE INDEX "backups_branch_id_idx" ON "backups"("branch_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

