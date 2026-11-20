import { z } from "zod";

const usedSearchDefaults = {
  minimumDiscountPercent: 15,
  minimumComparables: 5,
  facebookLocation: "Itajaí, SC",
  facebookRadiusKm: 40,
};

const percentage = z.number().finite().min(0).max(100);
const costs = z.object({
  fixed: z.number().finite().nonnegative().max(999_999_999_999.99).nullable().default(null),
  feePercent: percentage.nullable().default(null),
}).strict();

export const usedSearchSettingsSchema = z.object({
  purpose: z.enum(["personal", "resale"]),
  minimumDiscountPercent: percentage.default(usedSearchDefaults.minimumDiscountPercent),
  minimumComparables: z.number().int().min(5).safe().default(usedSearchDefaults.minimumComparables),
  facebookLocation: z.string().trim().min(1).max(200).default(usedSearchDefaults.facebookLocation),
  facebookRadiusKm: z.number().int().positive().max(2_000).default(usedSearchDefaults.facebookRadiusKm),
  costs: costs.default({}),
}).strict();

export type UsedSearchSettings = z.infer<typeof usedSearchSettingsSchema>;

export const defaultUsedSearchSettings: UsedSearchSettings = usedSearchSettingsSchema.parse({ purpose: "personal" });

export function getUsedSearchSettings(value: unknown): UsedSearchSettings | null {
  const parsed = usedSearchSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
