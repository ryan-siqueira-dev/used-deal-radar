function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(record).filter((item) => item !== undefined);
}

function documentRecords(script: string): Record<string, unknown>[] {
  try {
    return records(JSON.parse(script)).flatMap((root) => [root, ...records(root["@graph"])]);
  } catch { return []; }
}

export function getStructuredListing(scripts: readonly string[] = []) {
  const product = scripts.flatMap(documentRecords).find((value) => {
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    return types.includes("Product") || types.includes("Vehicle");
  });
  const [offer] = records(product?.["offers"]);
  const itemCondition = offer?.["itemCondition"] ?? product?.["itemCondition"];
  const condition = typeof itemCondition === "string" ? itemCondition : record(itemCondition)?.["@id"];
  const canShip = records(offer?.["shippingDetails"]).some((shipping) =>
    shipping["doesNotShip"] === false || (shipping["doesNotShip"] == null && shipping["shippingDestination"] != null));
  return {
    product,
    offer,
    attributes: {
      ...(typeof condition === "string" ? { itemCondition: condition } : {}),
      ...(canShip ? { shipping: "available" } : {}),
    },
  };
}

export function addShippingEvidence(attributes: Record<string, unknown>, lines: readonly string[]): void {
  for (const line of lines) {
    if (/^(?:somente retirada|retirada (?:somente|apenas)(?: no local)?|apenas retirada|n[aã]o (?:fa[cç]o|fazemos) envios?|pickup only)$/i.test(line)) {
      attributes["shipping"] = "pickup_only";
      return;
    }
    if (/^(?:(?:envio|entrega) dispon[ií]vel|entrega (?:f[aá]cil|via olx)|shipping available)$/i.test(line)) attributes["shipping"] = "available";
  }
}
