-- QR menu (QR-1): urun aciklamasi, alerjen/diyet etiketleri, ceviriler ve "tukendi";
-- kategori cevirileri; masa QR kodu. JSON alanlar TEXT (base.prisma kurali).
-- Yalniz sutun ekleme: tablo yeniden kurulmaz, mevcut veri ve indeksler aynen kalir.

ALTER TABLE "products" ADD COLUMN "description" TEXT;
ALTER TABLE "products" ADD COLUMN "allergens" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "products" ADD COLUMN "diet_tags" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "products" ADD COLUMN "translations" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "products" ADD COLUMN "is_available" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "categories" ADD COLUMN "translations" TEXT NOT NULL DEFAULT '{}';

-- Kodlar uygulama acilisinda uretilir (TablesService); rastgele base32 SQL'de uretilemez.
ALTER TABLE "tables" ADD COLUMN "public_code" TEXT;
CREATE UNIQUE INDEX "tables_public_code_key" ON "tables"("public_code");
