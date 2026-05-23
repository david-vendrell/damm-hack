-- CreateTable
CREATE TABLE "SavedChart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nombre" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualEn" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SavedChart_creadoEn_idx" ON "SavedChart"("creadoEn");
