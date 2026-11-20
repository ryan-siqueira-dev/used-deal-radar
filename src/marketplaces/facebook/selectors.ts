// Facebook changes its generated markup frequently. Keep semantic fallbacks here and
// validate them with `npm run provider:test -- facebook --inspect` using a local session.
const scopeDistancePrefix = "[,·•–-]\\s*(?:a\\s+|at[eé]\\s+|within\\s+|(?:(?:em um|no) )?raio de\\s+)?";

export const FACEBOOK_SELECTORS = {
  resultLinks: ['a[href*="/marketplace/item/"]'],
  searchMain: 'main, [role="main"]',
  fallbackLabels: 'h1, h2, h3, h4, h5, h6, [role="heading"], [aria-label], span',
  fallbackResults: /^(?:results? from (?:farther|further) away|results? outside your (?:search|area)|suggested listings|resultados? (?:fora da sua (?:pesquisa|[aá]rea)|mais distantes|de locais mais distantes)|sugest[oõ]es de an[uú]ncios)[.!:]?$/i,
  emptyResults: /^(?:nenhum resultado encontrado|nenhum an[uú]ncio encontrado|n[aã]o encontramos resultados|no results found)[.!]?$/i,
  scopeDistancePrefix,
  scopeLocationPrefix: "(?:(?:localiza[cç][aã]o|location)\\s*:\\s*)?",
  locationControl: new RegExp(`^(?:localiza[cç][aã]o|(?:alterar|editar) localiza[cç][aã]o|change location|location|.+${scopeDistancePrefix}\\d+\\s*(?:km|quil[oô]metros?|kilometers?)(?:\\s+away)?)$`, "i"),
  locationLink: 'a[href="#"], [role="link"]:not([href])',
  locationInput: 'input[role="combobox"]:visible, input[aria-autocomplete="list"]:visible, input[placeholder*="localiza" i]:visible, input[placeholder*="location" i]:visible, input[type=text]:visible',
  radiusControl: /^(?:raio|radius|dist[aâ]ncia|distance)(?:\s*:.*)?$|^\d+\s*(?:km|quil[oô]metros?|kilometers?)$/i,
  applyLocation: /^(?:aplicar|apply|salvar|save)$/i,
  closeLocation: /^(?:fechar|close|cancelar|cancel)$/i,
  detailTitle: ["h1", 'meta[property="og:title"]'],
  detailMain: ["main", '[role="main"]'],
  detailUnavailable: /^(?:este an[uú]ncio n[aã]o est[aá] mais dispon[ií]vel|este an[uú]ncio foi (?:removido|vendido)|este conte[uú]do n[aã]o est[aá] dispon[ií]vel (?:no momento|agora)|this listing (?:isn.t|is no longer) available|this content isn.t available (?:at the moment|right now))[.!]?$/i,
  loginMarkers: ['input[name="email"]', 'form[action*="login"]'],
} as const;
