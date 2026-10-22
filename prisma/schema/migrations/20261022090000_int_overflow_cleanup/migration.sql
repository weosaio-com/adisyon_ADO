-- 32-bit tasma temizligi (SAT-13). Prisma Int alanlari 32-bit; SQLite daha buyuk degeri
-- yazar ama Prisma okurken "does not fit in an INT column" ile patlar ve o tabloyu okuyan
-- her liste (urunler, kasa, raporlar) kalici olarak 500 verir. Artik girisler zod ile
-- sinirli (tutar <= 10.000.000 TL); bu goc onceki surumden kalan bozuk satirlari bir kez
-- okunur hale getirir. Bu degerler hicbir zaman okunamadigi icin kurtarilacak bilgi yok:
-- fiyat 0 + urun satisa kapali (sahibi duzeltir), kasa hareketi 0 + aciklamada eski deger.
-- Sema degismez; yalniz UPDATE. Tarihler Prisma bicimiyle (epoch milisaniye) yazilir.

-- Urun: hatali fiyatli urun satisa kapatilir, fiyat 0 (yanlislikla 0 TL'ye satilmasin).
UPDATE "products"
SET "is_active" = 0,
    "sale_price" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "sale_price" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "products"
SET "purchase_price" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "purchase_price" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "products"
SET "min_stock" = NULL,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "min_stock" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "products"
SET "sort_order" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "sort_order" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "categories"
SET "sort_order" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "sort_order" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "taxes"
SET "rate_permille" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "rate_permille" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "halls"
SET "sort_order" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "sort_order" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "tables"
SET "seats" = 4,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "seats" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "tables"
SET "pos_x" = NULL,
    "pos_y" = NULL,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "pos_x" NOT BETWEEN -2147483648 AND 2147483647
   OR "pos_y" NOT BETWEEN -2147483648 AND 2147483647;

-- Kasa hareketi: tutar 0, girilen deger aciklamada kalir (iz kaybolmaz).
UPDATE "cash_transactions"
SET "note" = 'Geçersiz tutar temizlendi (girilen: ' || "amount" || ' kuruş)'
             || COALESCE(' - ' || "note", ''),
    "amount" = 0,
    "version" = "version" + 1,
    "sync_state" = 'pending',
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "amount" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "cash_sessions"
SET "opening_float" = 0,
    "version" = "version" + 1,
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "opening_float" NOT BETWEEN -2147483648 AND 2147483647;

UPDATE "cash_sessions"
SET "counted_amount" = NULL,
    "expected_amount" = NULL,
    "difference" = NULL,
    "version" = "version" + 1,
    "updated_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "counted_amount" NOT BETWEEN -2147483648 AND 2147483647
   OR "expected_amount" NOT BETWEEN -2147483648 AND 2147483647
   OR "difference" NOT BETWEEN -2147483648 AND 2147483647;
