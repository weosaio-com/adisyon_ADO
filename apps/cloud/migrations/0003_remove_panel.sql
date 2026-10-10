-- Isletme paneli kaldirildi: QR menu yalniz Adisyon programindan, lisansla yonetilir
-- (0002_license_activation.sql). Panel oturumlari, eslestirme kodlari ve panel kullanicilari silinir.
-- Lisanssiz (satici ya da panelle acilmis) isletmeler subeleri, menuleri ve masalariyla birlikte
-- kalkar (ON DELETE CASCADE). Uygulamadan once D1 Time Travel yer imi alin (README).

DROP TABLE sessions;
DROP TABLE pairing_codes;
DROP TABLE users;

DELETE FROM tenants WHERE license_id IS NULL;

-- Menuyu her zaman POS yayinlar: "kaynak" ayrimi kalmadi.
ALTER TABLE branches DROP COLUMN source;
