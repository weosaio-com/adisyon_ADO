import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import { newId, createDomainEvent, DomainEventName, type MenuTranslations } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import { DEFAULT_UNITS, DEFAULT_TAXES } from './catalog.defaults';
import { categoryView, compactTranslations, productView } from './catalog.views';
import { storeMenuImage } from './catalog.images';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateProductDto,
  UpdateProductDto,
  ProductQueryDto,
  CreateUnitDto,
  UpdateUnitDto,
  CreateTaxDto,
  UpdateTaxDto,
} from './dto/catalog.schemas';

/**
 * Katalog: Kategori / Urun / Birim / Vergi CRUD.
 * Ortak kurallar: her islem branchId ile izole, soft-delete (deletedAt),
 * her mutasyonda version++ + syncState='pending' (Faz 2 outbox) + audit kaydi.
 * Para/oran integer (kurus/binde) -> DTO seviyesinde zorlanir (float yok).
 * QR menu alanlari (aciklama, alerjen, diyet, ceviri) TEXT JSON saklanir; yanitlar
 * `catalog.views` ile cozulmus doner.
 */
@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  // Acilista: birim/vergi tablosu bos olan her sube icin varsayilanlari ekle.
  // Kok neden fix: urun formu birim+vergi zorunlu tutar; bunlar yoksa hicbir
  // urun eklenemez. Idempotent (count===0 kontrolu) -> her acilista guvenli.
  async onModuleInit(): Promise<void> {
    const branches = await this.prisma.branch.findMany({ select: { id: true } });
    for (const { id: branchId } of branches) {
      await this.ensureBranchDefaults(branchId);
    }
  }

  private async ensureBranchDefaults(branchId: string): Promise<void> {
    const [unitCount, taxCount] = await Promise.all([
      this.prisma.unit.count({ where: { branchId, deletedAt: null } }),
      this.prisma.tax.count({ where: { branchId, deletedAt: null } }),
    ]);
    if (unitCount === 0) {
      await this.prisma.unit.createMany({
        data: DEFAULT_UNITS.map((u) => ({
          id: newId(),
          branchId,
          name: u.name,
          abbreviation: u.abbreviation,
        })),
      });
      this.logger.log(`Varsayilan birimler eklendi (branch ${branchId})`);
    }
    if (taxCount === 0) {
      await this.prisma.tax.createMany({
        data: DEFAULT_TAXES.map((t) => ({
          id: newId(),
          branchId,
          name: t.name,
          ratePermille: t.ratePermille,
          isDefault: t.isDefault ?? false,
        })),
      });
      this.logger.log(`Varsayilan vergiler eklendi (branch ${branchId})`);
    }
  }

  // Mutasyonlarda yazilan ortak provenance alanlari.
  private provenance(user: AuthUser): { deviceId?: string } {
    return user.deviceId ? { deviceId: user.deviceId } : {};
  }

  // Urun domain event'i yayinlar (audit yaninda; yan etkiler icin -> EVENT_BUS.md).
  private async publishProductEvent(
    user: AuthUser,
    name: (typeof DomainEventName)[keyof typeof DomainEventName],
    product: { id: string; name: string; categoryId: string; salePrice: number },
  ): Promise<void> {
    await this.events.publish(
      createDomainEvent(
        name,
        {
          productId: product.id,
          name: product.name,
          categoryId: product.categoryId,
          salePrice: product.salePrice,
        },
        {
          branchId: user.branchId,
          actorId: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      ),
    );
  }

  // Kategori event'i: QR menu yayini kategori ad/ceviri/sira degisikligini buradan duyar.
  private async publishCategoryEvent(
    user: AuthUser,
    name: (typeof DomainEventName)[keyof typeof DomainEventName],
    category: { id: string; name: string },
  ): Promise<void> {
    await this.events.publish(
      createDomainEvent(
        name,
        { categoryId: category.id, name: category.name },
        {
          branchId: user.branchId,
          actorId: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      ),
    );
  }

  private translationsJson(translations: MenuTranslations): string {
    return JSON.stringify(compactTranslations(translations));
  }

  // ===========================================================================
  // Kategori
  // ===========================================================================
  async listCategories(user: AuthUser) {
    const rows = await this.prisma.category.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(categoryView);
  }

  async getCategory(user: AuthUser, id: string) {
    return categoryView(await this.categoryOrThrow(user.branchId, id));
  }

  async createCategory(user: AuthUser, dto: CreateCategoryDto) {
    if (dto.parentId) await this.categoryOrThrow(user.branchId, dto.parentId);

    const id = newId();
    const created = await this.prisma.category.create({
      data: {
        id,
        branchId: user.branchId,
        name: dto.name,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
        color: dto.color ?? null,
        isActive: dto.isActive ?? true,
        translationsJson: this.translationsJson(dto.translations ?? {}),
        ...this.provenance(user),
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'category.create',
      entityType: 'category',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    await this.publishCategoryEvent(user, DomainEventName.CategoryCreated, created);
    return categoryView(created);
  }

  async updateCategory(user: AuthUser, id: string, dto: UpdateCategoryDto) {
    const before = await this.categoryOrThrow(user.branchId, id);
    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new ConflictException({
          code: 'CATEGORY_PARENT_SELF',
          message: 'Kategori kendi ust kategorisi olamaz.',
        });
      }
      await this.categoryOrThrow(user.branchId, dto.parentId);
    }

    const after = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.translations !== undefined
          ? { translationsJson: this.translationsJson(dto.translations) }
          : {}),
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'category.update',
      entityType: 'category',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...this.provenance(user),
    });
    await this.publishCategoryEvent(user, DomainEventName.CategoryUpdated, after);
    return categoryView(after);
  }

  async deleteCategory(user: AuthUser, id: string) {
    const before = await this.categoryOrThrow(user.branchId, id);

    const [childCount, productCount] = await Promise.all([
      this.prisma.category.count({
        where: { branchId: user.branchId, parentId: id, deletedAt: null },
      }),
      this.prisma.product.count({
        where: { branchId: user.branchId, categoryId: id, deletedAt: null },
      }),
    ]);
    if (childCount > 0 || productCount > 0) {
      throw new ConflictException({
        code: 'CATEGORY_NOT_EMPTY',
        message: 'Alt kategori veya urun iceren kategori silinemez.',
      });
    }

    const after = await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'category.delete',
      entityType: 'category',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      ...this.provenance(user),
    });
    await this.publishCategoryEvent(user, DomainEventName.CategoryDeleted, before);
    return categoryView(after);
  }

  // ===========================================================================
  // Urun
  // ===========================================================================
  async listProducts(user: AuthUser, query: ProductQueryDto) {
    const rows = await this.prisma.product.findMany({
      where: {
        branchId: user.branchId,
        deletedAt: null,
        ...(query.favorite !== undefined ? { isFavorite: query.favorite } : {}),
        ...(query.active !== undefined ? { isActive: query.active } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.barcode ? { barcode: query.barcode } : {}),
        ...(query.search ? { name: { contains: query.search } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(productView);
  }

  async getProduct(user: AuthUser, id: string) {
    return productView(await this.productOrThrow(user.branchId, id));
  }

  async createProduct(user: AuthUser, dto: CreateProductDto) {
    await this.assertProductRefs(user.branchId, dto.categoryId, dto.unitId, dto.taxId, dto.brandId);

    const id = newId();
    const created = await this.prisma.product.create({
      data: {
        id,
        branchId: user.branchId,
        categoryId: dto.categoryId,
        unitId: dto.unitId,
        taxId: dto.taxId,
        brandId: dto.brandId ?? null,
        name: dto.name,
        barcode: dto.barcode ?? null,
        sku: dto.sku ?? null,
        purchasePrice: dto.purchasePrice ?? 0,
        salePrice: dto.salePrice,
        trackStock: dto.trackStock ?? false,
        minStock: dto.minStock ?? null,
        isActive: dto.isActive ?? true,
        isFavorite: dto.isFavorite ?? false,
        sortOrder: dto.sortOrder ?? 0,
        description: dto.description?.trim() || null,
        allergensJson: JSON.stringify(dto.allergens ?? []),
        dietTagsJson: JSON.stringify(dto.dietTags ?? []),
        translationsJson: this.translationsJson(dto.translations ?? {}),
        isAvailable: dto.isAvailable ?? true,
        ...this.provenance(user),
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'product.create',
      entityType: 'product',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    await this.publishProductEvent(user, DomainEventName.ProductCreated, created);
    return productView(created);
  }

  async updateProduct(user: AuthUser, id: string, dto: UpdateProductDto) {
    const before = await this.productOrThrow(user.branchId, id);
    await this.assertProductRefs(user.branchId, dto.categoryId, dto.unitId, dto.taxId, dto.brandId);

    const after = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.unitId !== undefined ? { unitId: dto.unitId } : {}),
        ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
        ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
        ...(dto.barcode !== undefined ? { barcode: dto.barcode } : {}),
        ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
        ...(dto.purchasePrice !== undefined ? { purchasePrice: dto.purchasePrice } : {}),
        ...(dto.salePrice !== undefined ? { salePrice: dto.salePrice } : {}),
        ...(dto.trackStock !== undefined ? { trackStock: dto.trackStock } : {}),
        ...(dto.minStock !== undefined ? { minStock: dto.minStock } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.isFavorite !== undefined ? { isFavorite: dto.isFavorite } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.allergens !== undefined ? { allergensJson: JSON.stringify(dto.allergens) } : {}),
        ...(dto.dietTags !== undefined ? { dietTagsJson: JSON.stringify(dto.dietTags) } : {}),
        ...(dto.translations !== undefined
          ? { translationsJson: this.translationsJson(dto.translations) }
          : {}),
        ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'product.update',
      entityType: 'product',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...this.provenance(user),
    });
    await this.publishProductEvent(user, DomainEventName.ProductUpdated, after);
    return productView(after);
  }

  /** "Tukendi" anahtari: urun listede kalir, siparis verilemez (orders: PRODUCT_UNAVAILABLE). */
  async setAvailability(user: AuthUser, id: string, isAvailable: boolean) {
    const before = await this.productOrThrow(user.branchId, id);
    if (before.isAvailable === isAvailable) return productView(before);
    const after = await this.prisma.product.update({
      where: { id },
      data: { isAvailable, version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'product.availability',
      entityType: 'product',
      entityId: id,
      userId: user.userId,
      oldValue: { isAvailable: before.isAvailable },
      newValue: { isAvailable },
      ...this.provenance(user),
    });
    await this.publishProductEvent(user, DomainEventName.ProductUpdated, after);
    return productView(after);
  }

  /** Gorsel yukle (govde: JPEG/PNG/WebP, en fazla 1 MB). Ayni icerik bir kez saklanir. */
  async setImage(user: AuthUser, id: string, body: Readable) {
    const before = await this.productOrThrow(user.branchId, id);
    const imagePath = await storeMenuImage(body);
    return this.updateImage(user, before, imagePath);
  }

  async clearImage(user: AuthUser, id: string) {
    const before = await this.productOrThrow(user.branchId, id);
    return this.updateImage(user, before, null);
  }

  private async updateImage(
    user: AuthUser,
    before: Awaited<ReturnType<CatalogService['productOrThrow']>>,
    imagePath: string | null,
  ) {
    if (before.imagePath === imagePath) return productView(before);
    const after = await this.prisma.product.update({
      where: { id: before.id },
      data: { imagePath, version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: imagePath ? 'product.image.set' : 'product.image.clear',
      entityType: 'product',
      entityId: before.id,
      userId: user.userId,
      oldValue: { imagePath: before.imagePath },
      newValue: { imagePath },
      ...this.provenance(user),
    });
    await this.publishProductEvent(user, DomainEventName.ProductUpdated, after);
    return productView(after);
  }

  async deleteProduct(user: AuthUser, id: string) {
    const before = await this.productOrThrow(user.branchId, id);
    const after = await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'product.delete',
      entityType: 'product',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      ...this.provenance(user),
    });
    await this.publishProductEvent(user, DomainEventName.ProductDeleted, before);
    return productView(after);
  }

  // ===========================================================================
  // Birim
  // ===========================================================================
  listUnits(user: AuthUser) {
    return this.prisma.unit.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  async getUnit(user: AuthUser, id: string) {
    return this.unitOrThrow(user.branchId, id);
  }

  async createUnit(user: AuthUser, dto: CreateUnitDto) {
    const id = newId();
    const created = await this.prisma.unit.create({
      data: {
        id,
        branchId: user.branchId,
        name: dto.name,
        abbreviation: dto.abbreviation ?? null,
        ...this.provenance(user),
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'unit.create',
      entityType: 'unit',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    return created;
  }

  async updateUnit(user: AuthUser, id: string, dto: UpdateUnitDto) {
    const before = await this.unitOrThrow(user.branchId, id);
    const after = await this.prisma.unit.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.abbreviation !== undefined ? { abbreviation: dto.abbreviation } : {}),
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'unit.update',
      entityType: 'unit',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...this.provenance(user),
    });
    return after;
  }

  async deleteUnit(user: AuthUser, id: string) {
    const before = await this.unitOrThrow(user.branchId, id);
    const inUse = await this.prisma.product.count({
      where: { branchId: user.branchId, unitId: id, deletedAt: null },
    });
    if (inUse > 0) {
      throw new ConflictException({
        code: 'UNIT_IN_USE',
        message: 'Urun tarafindan kullanilan birim silinemez.',
      });
    }
    const after = await this.softDelete('unit', id);
    await this.audit.record({
      branchId: user.branchId,
      action: 'unit.delete',
      entityType: 'unit',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      ...this.provenance(user),
    });
    return after;
  }

  // ===========================================================================
  // Vergi
  // ===========================================================================
  listTaxes(user: AuthUser) {
    return this.prisma.tax.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: { ratePermille: 'asc' },
    });
  }

  async getTax(user: AuthUser, id: string) {
    return this.taxOrThrow(user.branchId, id);
  }

  async createTax(user: AuthUser, dto: CreateTaxDto) {
    const id = newId();
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.tax.updateMany({
          where: { branchId: user.branchId, isDefault: true, deletedAt: null },
          data: { isDefault: false, version: { increment: 1 }, syncState: 'pending' },
        });
      }
      return tx.tax.create({
        data: {
          id,
          branchId: user.branchId,
          name: dto.name,
          ratePermille: dto.ratePermille,
          isDefault: dto.isDefault ?? false,
          ...this.provenance(user),
        },
      });
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'tax.create',
      entityType: 'tax',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    return created;
  }

  async updateTax(user: AuthUser, id: string, dto: UpdateTaxDto) {
    const before = await this.taxOrThrow(user.branchId, id);
    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.tax.updateMany({
          where: {
            branchId: user.branchId,
            isDefault: true,
            deletedAt: null,
            id: { not: id },
          },
          data: { isDefault: false, version: { increment: 1 }, syncState: 'pending' },
        });
      }
      return tx.tax.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.ratePermille !== undefined ? { ratePermille: dto.ratePermille } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          version: { increment: 1 },
          syncState: 'pending',
        },
      });
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'tax.update',
      entityType: 'tax',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...this.provenance(user),
    });
    return after;
  }

  async deleteTax(user: AuthUser, id: string) {
    const before = await this.taxOrThrow(user.branchId, id);
    const inUse = await this.prisma.product.count({
      where: { branchId: user.branchId, taxId: id, deletedAt: null },
    });
    if (inUse > 0) {
      throw new ConflictException({
        code: 'TAX_IN_USE',
        message: 'Urun tarafindan kullanilan vergi silinemez.',
      });
    }
    const after = await this.softDelete('tax', id);
    await this.audit.record({
      branchId: user.branchId,
      action: 'tax.delete',
      entityType: 'tax',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      ...this.provenance(user),
    });
    return after;
  }

  // ===========================================================================
  // Ortak yardimcilar
  // ===========================================================================
  private async categoryOrThrow(branchId: string, id: string) {
    const row = await this.prisma.category.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Kategori bulunamadi.' });
    }
    return row;
  }

  private async productOrThrow(branchId: string, id: string) {
    const row = await this.prisma.product.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Urun bulunamadi.' });
    }
    return row;
  }

  private async unitOrThrow(branchId: string, id: string) {
    const row = await this.prisma.unit.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: 'Birim bulunamadi.' });
    }
    return row;
  }

  private async taxOrThrow(branchId: string, id: string) {
    const row = await this.prisma.tax.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'TAX_NOT_FOUND', message: 'Vergi bulunamadi.' });
    }
    return row;
  }

  // Urun FK'lari (kategori/birim/vergi zorunlu, marka opsiyonel) ayni branch'te mi?
  private async assertProductRefs(
    branchId: string,
    categoryId?: string,
    unitId?: string,
    taxId?: string,
    brandId?: string | null,
  ): Promise<void> {
    if (categoryId !== undefined) await this.categoryOrThrow(branchId, categoryId);
    if (unitId !== undefined) await this.unitOrThrow(branchId, unitId);
    if (taxId !== undefined) await this.taxOrThrow(branchId, taxId);
    if (brandId) {
      const brand = await this.prisma.brand.findFirst({
        where: { id: brandId, branchId, deletedAt: null },
      });
      if (!brand) {
        throw new NotFoundException({ code: 'BRAND_NOT_FOUND', message: 'Marka bulunamadi.' });
      }
    }
  }

  // Ortak soft-delete: deletedAt + version++ + syncState. Kategori/urun kendi yanit
  // gorunumleriyle (catalog.views) silindigi icin burada yalniz birim/vergi var.
  private softDelete(model: 'unit' | 'tax', id: string) {
    const data = {
      deletedAt: new Date(),
      version: { increment: 1 },
      syncState: 'pending',
    };
    switch (model) {
      case 'unit':
        return this.prisma.unit.update({ where: { id }, data });
      case 'tax':
        return this.prisma.tax.update({ where: { id }, data });
    }
  }
}
