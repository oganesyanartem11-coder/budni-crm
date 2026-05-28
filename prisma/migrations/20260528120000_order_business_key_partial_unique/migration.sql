-- Частичный уникальный индекс на бизнес-ключ заказа.
-- Не учитывает CANCELLED: один и тот же слот можно отменить и пересоздать.
-- Prisma schema не поддерживает WHERE-предикаты в @@unique, поэтому raw SQL.
CREATE UNIQUE INDEX "order_business_key" ON "Order" ("clientId", "locationId", "mealType", "deliveryDate") WHERE status <> 'CANCELLED';
