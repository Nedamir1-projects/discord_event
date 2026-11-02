ALTER TABLE "MatrixNight" ADD COLUMN "snapshotId" TEXT;
CREATE UNIQUE INDEX "MatrixNight_snapshotId_key" ON "MatrixNight"("snapshotId");
