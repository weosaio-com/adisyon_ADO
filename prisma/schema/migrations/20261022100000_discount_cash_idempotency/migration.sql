-- Tekrar korumasi (SAT-6): cevrimici indirim ve elle kasa hareketi (para giris/cikisi) istegi
-- zaman asimi ya da cift dokunusla ikinci kez gelirse ayni anahtarla ikinci kayit acilmaz.
-- Yalniz ADD COLUMN + benzersiz indeks: mevcut kayitlar korunur (eski satirlarda NULL).

-- AlterTable
ALTER TABLE "order_discounts" ADD COLUMN "client_op_id" TEXT;

-- AlterTable
ALTER TABLE "cash_transactions" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "order_discounts_client_op_id_key" ON "order_discounts"("client_op_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_transactions_idempotency_key_key" ON "cash_transactions"("idempotency_key");
