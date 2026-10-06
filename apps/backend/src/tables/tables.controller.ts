import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { TablesService } from './tables.service';
import {
  createHallSchema,
  updateHallSchema,
  createTableSchema,
  updateTableSchema,
  tableQuerySchema,
  type CreateHallDto,
  type UpdateHallDto,
  type CreateTableDto,
  type UpdateTableDto,
  type TableQueryDto,
} from './dto/tables.schemas';

/**
 * Okuma: `table.view` (Waiter'da var — kat planini gorur).
 * Yazma (salon/masa yonetimi): `table.manage` (Owner).
 */

@Controller('halls')
export class HallsController {
  constructor(private readonly tables: TablesService) {}

  @Get()
  @RequirePermissions(Permission.TableView)
  list(@CurrentUser() user: AuthUser) {
    return this.tables.listHalls(user);
  }

  @Get(':id')
  @RequirePermissions(Permission.TableView)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tables.getHall(user, id);
  }

  @Post()
  @RequirePermissions(Permission.TableManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createHallSchema)) dto: CreateHallDto,
  ) {
    return this.tables.createHall(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.TableManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateHallSchema)) dto: UpdateHallDto,
  ) {
    return this.tables.updateHall(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.TableManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tables.deleteHall(user, id);
  }
}

@Controller('tables')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get()
  @RequirePermissions(Permission.TableView)
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(tableQuerySchema)) query: TableQueryDto,
  ) {
    return this.tables.listTables(user, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.TableView)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tables.getTable(user, id);
  }

  @Post()
  @RequirePermissions(Permission.TableManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTableSchema)) dto: CreateTableDto,
  ) {
    return this.tables.createTable(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.TableManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTableSchema)) dto: UpdateTableDto,
  ) {
    return this.tables.updateTable(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.TableManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tables.deleteTable(user, id);
  }

  // QR menu kodunu yenile (eski QR gecersiz olur).
  @Post(':id/public-code')
  @RequirePermissions(Permission.TableManage)
  rotatePublicCode(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tables.rotatePublicCode(user, id);
  }
}
