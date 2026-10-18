/** Billed tests must opt into a model, never silently select a provider. */
export function integrationModel(explicit?: string, configured = process.env.PI_TEST_MODEL): string {
  const model = explicit?.trim() || configured?.trim();
  if (!model) throw new Error("Set PI_TEST_MODEL=provider/model before running billed integration tests.");
  return model;
}
