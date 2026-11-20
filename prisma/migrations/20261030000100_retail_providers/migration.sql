ALTER TABLE "Search" DROP CONSTRAINT "Search_providers_check";
ALTER TABLE "Search" ADD CONSTRAINT "Search_providers_check"
  CHECK (cardinality("providers") > 0 AND "providers" <@ ARRAY['facebook', 'olx', 'mercadolivre', 'kabum', 'terabyte']::TEXT[]);
