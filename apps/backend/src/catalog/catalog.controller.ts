import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { MENU_IMAGE_TYPES, Permission, type MenuImageExt } from '@ado/shared';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { CatalogService } from './catalog.service';
import { menuImagePath } from './catalog.images';
import {
  createCategorySchema,
  updateCategorySchema,
  createProductSchema,
  updateProductSchema,
  productQuerySchema,
  productAvailabilitySchema,
  createUnitSchema,
  updateUnitSchema,
  createTaxSchema,
  updateTaxSchema,
  type CreateCategoryDto,
  type UpdateCategoryDto,
  type CreateProductDto,
  type UpdateProductDto,
  type ProductQueryDto,
  type ProductAvailabilityDto,
  type CreateUnitDto,
  type UpdateUnitDto,
  type CreateTaxDto,
  type UpdateTaxDto,
} from './dto/catalog.schemas';

/**
 * Okuma uclari: yalniz kimlik dogrulamasi (Waiter siparis icin katalogu okur).
 * Yazma uclari (POST/PATCH/DELETE): product.manage (Owner).
 * Urun gorselleri herkese acik okunur (catalog/images): QR menu ve <img> etiketi token tasimaz.
 */

@Controller('categories')
export class CategoriesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.catalog.listCategories(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.getCategory(user, id);
  }

  @Post()
  @RequirePermissions(Permission.ProductManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createCategorySchema)) dto: CreateCategoryDto,
  ) {
    return this.catalog.createCategory(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ProductManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) dto: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.ProductManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.deleteCategory(user, id);
  }
}

@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(productQuerySchema)) query: ProductQueryDto,
  ) {
    return this.catalog.listProducts(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.getProduct(user, id);
  }

  @Post()
  @RequirePermissions(Permission.ProductManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createProductSchema)) dto: CreateProductDto,
  ) {
    return this.catalog.createProduct(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ProductManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) dto: UpdateProductDto,
  ) {
    return this.catalog.updateProduct(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.ProductManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.deleteProduct(user, id);
  }

  // "Tukendi" anahtari (QR menude rozet; siparise eklenemez).
  @Patch(':id/availability')
  @RequirePermissions(Permission.ProductManage)
  setAvailability(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(productAvailabilitySchema)) dto: ProductAvailabilityDto,
  ) {
    return this.catalog.setAvailability(user, id, dto.isAvailable);
  }

  // Gorsel (govde: application/octet-stream; JPEG/PNG/WebP, en fazla 1 MB).
  @Post(':id/image')
  @RequirePermissions(Permission.ProductManage)
  setImage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return this.catalog.setImage(user, id, req);
  }

  @Delete(':id/image')
  @RequirePermissions(Permission.ProductManage)
  clearImage(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.clearImage(user, id);
  }
}

@Controller('catalog/images')
export class CatalogImagesController {
  // Dosya adi icerik ozetidir: dosya hic degismez, suresiz onbelleklenebilir.
  @Public()
  @Get(':file')
  image(@Param('file') file: string, @Res() res: Response) {
    const path = menuImagePath(file);
    if (!path) {
      throw new NotFoundException({ code: 'IMAGE_NOT_FOUND', message: 'Görsel bulunamadı.' });
    }
    const ext = file.slice(file.lastIndexOf('.') + 1) as MenuImageExt;
    res.sendFile(path, {
      headers: {
        'Content-Type': MENU_IMAGE_TYPES[ext],
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }
}

@Controller('units')
export class UnitsController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.catalog.listUnits(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.getUnit(user, id);
  }

  @Post()
  @RequirePermissions(Permission.ProductManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createUnitSchema)) dto: CreateUnitDto,
  ) {
    return this.catalog.createUnit(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ProductManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUnitSchema)) dto: UpdateUnitDto,
  ) {
    return this.catalog.updateUnit(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.ProductManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.deleteUnit(user, id);
  }
}

@Controller('taxes')
export class TaxesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.catalog.listTaxes(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.getTax(user, id);
  }

  @Post()
  @RequirePermissions(Permission.ProductManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTaxSchema)) dto: CreateTaxDto,
  ) {
    return this.catalog.createTax(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ProductManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaxSchema)) dto: UpdateTaxDto,
  ) {
    return this.catalog.updateTax(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.ProductManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.deleteTax(user, id);
  }
}
