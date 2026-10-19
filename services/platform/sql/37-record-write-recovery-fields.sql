BEGIN;
-- NULL marks older receipts whose current field authorization cannot be reconstructed.
ALTER TABLE record_write_operations ADD COLUMN IF NOT EXISTS request_fields text[];
COMMIT;
