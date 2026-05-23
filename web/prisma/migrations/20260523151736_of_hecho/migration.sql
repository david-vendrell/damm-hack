-- CreateTable
CREATE TABLE "OfHecho" (
    "of" TEXT NOT NULL PRIMARY KEY,
    "fechaFin" DATETIME NOT NULL,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "semanaIso" INTEGER NOT NULL,
    "linea" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "marca" TEXT,
    "familia" TEXT,
    "tipoEnvase" TEXT,
    "formato" TEXT,
    "canal" TEXT,
    "oee" REAL NOT NULL,
    "disp" REAL NOT NULL,
    "rend" REAL NOT NULL,
    "inef" REAL,
    "hl" REAL NOT NULL,
    "uds" REAL NOT NULL,
    "tieneCambio" BOOLEAN NOT NULL,
    "hTotales" REAL,
    "hMarcha" REAL,
    "hParo" REAL,
    "hBajaVelocidad" REAL,
    "hSaturacionSal" REAL,
    "hFaltaProducto" REAL,
    "hCip" REAL,
    "hEsterilizacion" REAL
);

-- CreateIndex
CREATE INDEX "OfHecho_anio_linea_idx" ON "OfHecho"("anio", "linea");

-- CreateIndex
CREATE INDEX "OfHecho_marca_idx" ON "OfHecho"("marca");

-- CreateIndex
CREATE INDEX "OfHecho_formato_idx" ON "OfHecho"("formato");

-- CreateIndex
CREATE INDEX "OfHecho_canal_idx" ON "OfHecho"("canal");

-- CreateIndex
CREATE INDEX "OfHecho_fechaFin_idx" ON "OfHecho"("fechaFin");
