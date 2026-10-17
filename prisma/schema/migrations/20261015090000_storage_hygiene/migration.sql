-- Akilli saklama: yedegin bulut klasoru kopyasinin yolu ve veri parmak izi (degisiklik yoksa
-- gunluk otomatik yedek atlanir). Rapor tarih araliklari icin indeksler. Yalniz ADD COLUMN ve
-- CREATE INDEX: mevcut kayitlar korunur, tablo yeniden kurulmaz.

-- AlterTable
ALTER TABLE "backups" ADD COLUMN "cloud_copy_path" TEXT;
ALTER TABLE "backups" ADD COLUMN "fingerprint" TEXT;

-- CreateIndex
CREATE INDEX "debt_transactions_occurred_at_idx" ON "debt_transactions"("occurred_at");

-- CreateIndex
CREATE INDEX "expenses_branch_id_spent_at_idx" ON "expenses"("branch_id", "spent_at");

-- CreateIndex
CREATE INDEX "incomes_branch_id_received_at_idx" ON "incomes"("branch_id", "received_at");

-- CreateIndex
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- CreateIndex
CREATE INDEX "receipts_printed_at_idx" ON "receipts"("printed_at");
