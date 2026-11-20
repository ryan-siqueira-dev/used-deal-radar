// Candidate selectors are intentionally centralized. Run `npm run provider:test -- olx --inspect`
// after layout changes; no selector is treated as a private/stable OLX API contract.
export const OLX_SELECTORS = {
  resultLinks: [
    "a.olx-adcard__link",
    'a[data-ds-component="DS-AdCard"]',
    '[data-ds-component="DS-AdCard"] a[href]',
    'a[href*="/item/"]',
  ],
  emptyResults: /^(?:nenhum resultado encontrado|nenhum an[uú]ncio encontrado|n[aã]o encontramos (?:resultados|an[uú]ncios)(?: para (?:a )?sua busca)?|n[aã]o h[aá] an[uú]ncios para (?:a )?sua busca)[.!]?$/i,
  resultTitle: ["h2", "[aria-label*=Título]", "[data-ds-component=DS-Text]"],
  resultPrice: ["[data-ds-component=DS-Text]", "span"],
  resultLocation: ["[aria-label*=Localização]", "[data-ds-component=DS-Text]"],
  detailTitle: ["h1", "[data-ds-component=DS-Text][class*=title]"],
  detailPrice: ['[data-testid="ad-price"]', '[itemprop="price"]', '[class*="price"]'],
  detailUnavailable: /^(?:an[uú]ncio (?:indispon[ií]vel|removido|vendido|n[aã]o encontrado)|(?:este )?an[uú]ncio (?:n[aã]o est[aá] mais dispon[ií]vel|foi (?:removido|vendido)))[.!]?$/i,
  detailDescription: ['[data-ds-component="DS-AdDescription"]', "[class*=description]"],
  detailSeller: ['[data-ds-component="DS-SellerInfo"]', "[class*=seller]"],
  detailAttributes: ['[data-ds-component="DS-AdDetails"] li', '[data-ds-component="DS-AdDetails"] dt', "main li", "main dt"],
} as const;
