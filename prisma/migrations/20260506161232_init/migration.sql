-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CHEF', 'COURIER');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DYNAMIC', 'FIXED');

-- CreateEnum
CREATE TYPE "DeliveryHorizon" AS ENUM ('NEXT_DAY', 'SAME_DAY');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('DAILY', 'WEEKDAYS', 'WEEKENDS', 'CUSTOM_DAYS', 'ONE_TIME', 'INTERVAL');

-- CreateEnum
CREATE TYPE "PackagingType" AS ENUM ('INDIVIDUAL', 'BULK');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('MANUAL', 'MESSENGER', 'FIXED_AUTO', 'RECURRING_AUTO');

-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('IN_HOUSE', 'EXTERNAL_COURIER');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('ASSIGNED', 'PICKED_UP', 'EN_ROUTE', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "DishCategory" AS ENUM ('SOUP', 'MAIN', 'GARNISH', 'SALAD', 'DESSERT', 'DRINK', 'BREAD_WHITE', 'BREAD_DARK', 'PORRIDGE', 'EGGS', 'PANCAKE', 'OTHER');

-- CreateEnum
CREATE TYPE "IngredientUnit" AS ENUM ('KG', 'L', 'PCS');

-- CreateEnum
CREATE TYPE "DishUnit" AS ENUM ('PORTION', 'LITER', 'KG', 'PIECE');

-- CreateEnum
CREATE TYPE "MenuStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "pinHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactMessenger" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientLocation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "deliveryWindowFrom" TEXT,
    "deliveryWindowTo" TEXT,
    "packaging" "PackagingType" NOT NULL DEFAULT 'INDIVIDUAL',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMealConfig" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT,
    "mealType" "MealType" NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "deliveryHorizon" "DeliveryHorizon" NOT NULL DEFAULT 'NEXT_DAY',
    "scheduleType" "ScheduleType" NOT NULL,
    "scheduleData" JSONB,
    "fixedPortions" INTEGER,
    "pricePerPortion" DECIMAL(10,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMealConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "IngredientUnit" NOT NULL,
    "pricePerUnit" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientPriceHistory" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT,

    CONSTRAINT "IngredientPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dish" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "DishCategory" NOT NULL,
    "unit" "DishUnit" NOT NULL DEFAULT 'PORTION',
    "portionSize" INTEGER,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishIngredient" (
    "id" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "bruttoGrams" DECIMAL(10,2) NOT NULL,
    "nettoGrams" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "DishIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealSet" (
    "id" TEXT NOT NULL,
    "mealType" "MealType" NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealSetItem" (
    "id" TEXT NOT NULL,
    "mealSetId" TEXT NOT NULL,
    "dishCategory" "DishCategory" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "MealSetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuCycle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "status" "MenuStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuDay" (
    "id" TEXT NOT NULL,
    "menuCycleId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "mealType" "MealType" NOT NULL,
    "mealSetId" TEXT,

    CONSTRAINT "MenuDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuDayDish" (
    "id" TEXT NOT NULL,
    "menuDayId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "slotCategory" "DishCategory" NOT NULL,

    CONSTRAINT "MenuDayDish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "mealType" "MealType" NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "portions" INTEGER NOT NULL,
    "pricePerPortion" DECIMAL(10,2) NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "packaging" "PackagingType" NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "OrderSource" NOT NULL,
    "originalMessage" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "DeliveryType" NOT NULL,
    "courierName" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'ASSIGNED',
    "notes" TEXT,
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userRole" "UserRole",
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_pinHash_key" ON "User"("pinHash");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");

-- CreateIndex
CREATE INDEX "Client_name_idx" ON "Client"("name");

-- CreateIndex
CREATE INDEX "ClientLocation_clientId_isActive_idx" ON "ClientLocation"("clientId", "isActive");

-- CreateIndex
CREATE INDEX "ClientMealConfig_clientId_isActive_idx" ON "ClientMealConfig"("clientId", "isActive");

-- CreateIndex
CREATE INDEX "ClientMealConfig_locationId_idx" ON "ClientMealConfig"("locationId");

-- CreateIndex
CREATE INDEX "ClientMealConfig_mealType_orderType_idx" ON "ClientMealConfig"("mealType", "orderType");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient"("name");

-- CreateIndex
CREATE INDEX "Ingredient_isActive_idx" ON "Ingredient"("isActive");

-- CreateIndex
CREATE INDEX "IngredientPriceHistory_ingredientId_validFrom_idx" ON "IngredientPriceHistory"("ingredientId", "validFrom");

-- CreateIndex
CREATE INDEX "Dish_category_isActive_idx" ON "Dish"("category", "isActive");

-- CreateIndex
CREATE INDEX "DishIngredient_dishId_idx" ON "DishIngredient"("dishId");

-- CreateIndex
CREATE UNIQUE INDEX "DishIngredient_dishId_ingredientId_key" ON "DishIngredient"("dishId", "ingredientId");

-- CreateIndex
CREATE INDEX "MealSet_mealType_isActive_idx" ON "MealSet"("mealType", "isActive");

-- CreateIndex
CREATE INDEX "MealSetItem_mealSetId_idx" ON "MealSetItem"("mealSetId");

-- CreateIndex
CREATE INDEX "MenuCycle_validFrom_validTo_idx" ON "MenuCycle"("validFrom", "validTo");

-- CreateIndex
CREATE INDEX "MenuCycle_status_idx" ON "MenuCycle"("status");

-- CreateIndex
CREATE INDEX "MenuDay_menuCycleId_idx" ON "MenuDay"("menuCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuDay_menuCycleId_dayOfWeek_mealType_key" ON "MenuDay"("menuCycleId", "dayOfWeek", "mealType");

-- CreateIndex
CREATE INDEX "MenuDayDish_menuDayId_idx" ON "MenuDayDish"("menuDayId");

-- CreateIndex
CREATE INDEX "MenuDayDish_dishId_idx" ON "MenuDayDish"("dishId");

-- CreateIndex
CREATE INDEX "Order_deliveryDate_status_idx" ON "Order"("deliveryDate", "status");

-- CreateIndex
CREATE INDEX "Order_clientId_deliveryDate_idx" ON "Order"("clientId", "deliveryDate");

-- CreateIndex
CREATE INDEX "Order_locationId_deliveryDate_idx" ON "Order"("locationId", "deliveryDate");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_orderId_key" ON "Delivery"("orderId");

-- CreateIndex
CREATE INDEX "Delivery_status_idx" ON "Delivery"("status");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_idx" ON "ActivityLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "ClientLocation" ADD CONSTRAINT "ClientLocation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMealConfig" ADD CONSTRAINT "ClientMealConfig_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMealConfig" ADD CONSTRAINT "ClientMealConfig_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientPriceHistory" ADD CONSTRAINT "IngredientPriceHistory_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishIngredient" ADD CONSTRAINT "DishIngredient_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "Dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishIngredient" ADD CONSTRAINT "DishIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealSetItem" ADD CONSTRAINT "MealSetItem_mealSetId_fkey" FOREIGN KEY ("mealSetId") REFERENCES "MealSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCycle" ADD CONSTRAINT "MenuCycle_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuDay" ADD CONSTRAINT "MenuDay_menuCycleId_fkey" FOREIGN KEY ("menuCycleId") REFERENCES "MenuCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuDay" ADD CONSTRAINT "MenuDay_mealSetId_fkey" FOREIGN KEY ("mealSetId") REFERENCES "MealSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuDayDish" ADD CONSTRAINT "MenuDayDish_menuDayId_fkey" FOREIGN KEY ("menuDayId") REFERENCES "MenuDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuDayDish" ADD CONSTRAINT "MenuDayDish_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "Dish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ClientLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
