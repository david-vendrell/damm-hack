-- CreateTable
CREATE TABLE "Sku" (
    "codigo" TEXT NOT NULL PRIMARY KEY,
    "nombre" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "formato" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "SkuLineaBaseline" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "skuCodigo" TEXT NOT NULL,
    "linea" INTEGER NOT NULL,
    "oeeMediana" REAL NOT NULL,
    "oeeAlcanzable" REAL NOT NULL,
    "rateHlH" REAL NOT NULL,
    "nRuns" INTEGER NOT NULL,
    CONSTRAINT "SkuLineaBaseline_skuCodigo_fkey" FOREIGN KEY ("skuCodigo") REFERENCES "Sku" ("codigo") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChangeoverTime" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "linea" INTEGER NOT NULL,
    "estadoOrigen" TEXT NOT NULL,
    "estadoDestino" TEXT NOT NULL,
    "minutos" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "CambioIneficiente" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "of" TEXT NOT NULL,
    "linea" INTEGER NOT NULL,
    "fecha" TEXT NOT NULL,
    "skuAnterior" TEXT NOT NULL,
    "skuActual" TEXT NOT NULL,
    "tipoCambio" TEXT NOT NULL,
    "oeeReal" REAL NOT NULL,
    "oeeAlcanzable" REAL NOT NULL,
    "ptsPerdidos" REAL NOT NULL,
    "motivo" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "OeeObservacion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "skuCodigo" TEXT NOT NULL,
    "linea" INTEGER NOT NULL,
    "oee" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "Mantenimiento" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "linea" INTEGER NOT NULL,
    "dia" TEXT NOT NULL,
    "motivo" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nombre" TEXT NOT NULL,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PlanItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "planId" TEXT NOT NULL,
    "linea" INTEGER NOT NULL,
    "secuencia" INTEGER NOT NULL,
    "dia" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "hlPlan" REAL NOT NULL,
    CONSTRAINT "PlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuLineaBaseline_skuCodigo_linea_key" ON "SkuLineaBaseline"("skuCodigo", "linea");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeoverTime_linea_estadoOrigen_estadoDestino_key" ON "ChangeoverTime"("linea", "estadoOrigen", "estadoDestino");
