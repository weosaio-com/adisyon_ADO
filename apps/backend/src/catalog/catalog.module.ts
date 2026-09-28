import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import {
  CatalogImagesController,
  CategoriesController,
  ProductsController,
  UnitsController,
  TaxesController,
} from './catalog.controller';

/** Katalog modulu: Kategori / Urun / Birim / Vergi. PrismaModule + AuditModule @Global. */
@Module({
  controllers: [
    CategoriesController,
    ProductsController,
    UnitsController,
    TaxesController,
    CatalogImagesController,
  ],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
