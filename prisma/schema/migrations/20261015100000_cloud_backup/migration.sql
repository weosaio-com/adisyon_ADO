-- Bulut yedegi: yerel yedeklerin buluta yuklenme durumu (yedek basina bir satir; multipart
-- devam bilgisi dahil). Yalniz yeni tablo: mevcut tablolara ve veriye dokunulmaz.
-- CreateTable
CREATE TABLE "cloud_backup_uploads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branch_id" TEXT NOT NULL,
    "backup_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cloud_id" TEXT,
    "size_bytes" BIGINT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "uploaded_at" DATETIME,
    "upload_id" TEXT,
    "part_size" INTEGER,
    "parts_done" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "device_id" TEXT,
    "sync_state" TEXT NOT NULL DEFAULT 'pending'
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_backup_uploads_backup_id_key" ON "cloud_backup_uploads"("backup_id");

-- CreateIndex
CREATE INDEX "cloud_backup_uploads_branch_id_status_idx" ON "cloud_backup_uploads"("branch_id", "status");
