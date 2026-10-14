import { CanActivate, Injectable } from '@nestjs/common';

// KULLANIM DISI (deprecated): eskiden lisans dolunca GET disindaki TUM yazmalari durdururdu
// (acik masanin odemesi bile alinamazdi). Yeni politika (LICENSING.md §8) yalniz YENI adisyon
// acilisini kilitler: OrdersService.openOrder -> LicenseService.assertCanOpenOrder.
//
// Guard artik her istegi gecirir. APP_GUARD kaydi app.module.ts'den kaldirilinca (entegrasyon)
// bu dosya silinebilir. Hep acik uclarin listesi belge olarak license.paths.ts'de durur.

@Injectable()
export class LicenseGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
