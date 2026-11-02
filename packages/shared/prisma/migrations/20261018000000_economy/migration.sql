ALTER TABLE "PlayerProfile" ADD COLUMN "race" TEXT NOT NULL DEFAULT 'Mortal';
CREATE TABLE "BalanceTransaction" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BalanceTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BalanceTransaction_operationId_key" ON "BalanceTransaction"("operationId");
CREATE INDEX "BalanceTransaction_userId_createdAt_idx" ON "BalanceTransaction"("userId", "createdAt");
CREATE TABLE "Race" (
  "id" TEXT NOT NULL,
  "price" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL DEFAULT '',
  "available" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "Race_pkey" PRIMARY KEY ("id")
);
INSERT INTO "Race" ("id", "price", "description") VALUES
('Mortal',0,'Обычный смертный. Начальная раса.'),
('Witch',100,'Владеет тайной магией.'),
('Werewolf',100,'Сильный и быстрый оборотень.'),
('Vampire',150,'Бессмертный ночной охотник.'),
('Ghost',200,'Таинственный призрак.');
CREATE TABLE "ShopItem" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "price" INTEGER NOT NULL,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "limit" INTEGER,
  "effect" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "ShopItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Purchase" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "amount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Purchase_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ShopItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Purchase_operationId_key" ON "Purchase"("operationId");
CREATE INDEX "Purchase_userId_itemId_idx" ON "Purchase"("userId", "itemId");
CREATE TABLE "PendingOperation" (
  "operationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PendingOperation_pkey" PRIMARY KEY ("operationId")
);
