import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { OrdersService } from './orders.service';
import {
  openOrderSchema,
  addItemSchema,
  updateItemSchema,
  itemNoteSchema,
  voidItemSchema,
  cancelOrderSchema,
  orderQuerySchema,
  applyDiscountSchema,
  moveTableSchema,
  mergeOrderSchema,
  splitOrderSchema,
  type OpenOrderDto,
  type AddItemDto,
  type UpdateItemDto,
  type ItemNoteDto,
  type VoidItemDto,
  type CancelOrderDto,
  type OrderQueryDto,
  type ApplyDiscountDto,
  type MoveTableDto,
  type MergeOrderDto,
  type SplitOrderDto,
} from './dto/orders.schemas';

/**
 * Adisyon ac / kalem ekle-duzenle: order.create / order.item.edit (Waiter'da var).
 * Void / iptal: order.cancel (Owner).
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @RequirePermissions(Permission.OrderCreate)
  open(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(openOrderSchema)) dto: OpenOrderDto,
  ) {
    return this.orders.openOrder(user, dto);
  }

  @Get()
  @RequirePermissions(Permission.OrderCreate)
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(orderQuerySchema)) query: OrderQueryDto,
  ) {
    return this.orders.listOrders(user, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.OrderCreate)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.getOrder(user, id);
  }

  @Post(':id/items')
  @RequirePermissions(Permission.OrderItemEdit)
  addItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addItemSchema)) dto: AddItemDto,
  ) {
    return this.orders.addItem(user, id, dto);
  }

  @Patch(':id/items/:itemId')
  @RequirePermissions(Permission.OrderItemEdit)
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(updateItemSchema)) dto: UpdateItemDto,
  ) {
    return this.orders.updateItem(user, id, itemId, dto);
  }

  @Delete(':id/items/:itemId')
  @RequirePermissions(Permission.OrderItemEdit)
  removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.orders.removeItem(user, id, itemId);
  }

  @Post(':id/items/:itemId/void')
  @RequirePermissions(Permission.OrderCancel)
  voidItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(voidItemSchema)) dto: VoidItemDto,
  ) {
    return this.orders.voidItem(user, id, itemId, dto);
  }

  // Garson notu ("az pişmiş"): mutfak fisinde kalemin altina basilir.
  @Put(':id/items/:itemId/note')
  @RequirePermissions(Permission.OrderItemEdit)
  setItemNote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(itemNoteSchema)) dto: ItemNoteDto,
  ) {
    return this.orders.setItemNote(user, id, itemId, dto);
  }

  // Yanlislikla acilan bos adisyonu kapatir (garson da); dolu adisyon icin /cancel (Owner).
  @Post(':id/discard')
  @RequirePermissions(Permission.OrderCreate)
  discard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.discardEmptyOrder(user, id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.OrderCancel)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelOrderSchema)) dto: CancelOrderDto,
  ) {
    return this.orders.cancelOrder(user, id, dto);
  }

  @Post(':id/hold')
  @RequirePermissions(Permission.OrderCreate)
  hold(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.holdOrder(user, id);
  }

  @Post(':id/resume')
  @RequirePermissions(Permission.OrderCreate)
  resume(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.resumeOrder(user, id);
  }

  @Post(':id/move-table')
  @RequirePermissions(Permission.OrderCreate)
  moveTable(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moveTableSchema)) dto: MoveTableDto,
  ) {
    return this.orders.moveTable(user, id, dto.tableId);
  }

  // Baska bir acik adisyonu (sourceOrderId) bu adisyona (:id) birlestirir.
  @Post(':id/merge')
  @RequirePermissions(Permission.OrderCreate)
  merge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(mergeOrderSchema)) dto: MergeOrderDto,
  ) {
    return this.orders.mergeOrders(user, id, dto.sourceOrderId);
  }

  // Bu adisyondan (:id) secili kalemleri yeni bir adisyona bolerek ayirir.
  @Post(':id/split')
  @RequirePermissions(Permission.OrderCreate)
  split(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(splitOrderSchema)) dto: SplitOrderDto,
  ) {
    return this.orders.splitOrder(user, id, dto);
  }

  // Bekleyen kalemleri mutfaga/bara ilet (hazirlik fisi + kalem kilidi).
  @Post(':id/send-kitchen')
  @RequirePermissions(Permission.OrderSendKitchen)
  sendKitchen(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.sendToKitchen(user, id);
  }

  // Adisyon-seviyesi indirim. Min. yetki: apply_limited; >%10 serviste apply_full istenir.
  @Post(':id/discounts')
  @RequirePermissions(Permission.DiscountApplyLimited)
  applyDiscount(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(applyDiscountSchema)) dto: ApplyDiscountDto,
  ) {
    return this.orders.applyDiscount(user, id, dto);
  }

  @Delete(':id/discounts/:discountId')
  @RequirePermissions(Permission.DiscountApplyLimited)
  removeDiscount(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('discountId') discountId: string,
  ) {
    return this.orders.removeDiscount(user, id, discountId);
  }
}
