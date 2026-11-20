import type { Locator, Page } from "playwright";
import { FACEBOOK_SELECTORS } from "./selectors.js";

const states: Readonly<Record<string, string>> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará",
  DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso",
  MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina",
  SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const accented: Readonly<Record<string, string>> = {
  a: "[aáàâãä]", e: "[eéèêë]", i: "[iíìîï]", o: "[oóòôõö]", u: "[uúùûü]", c: "[cç]",
};

function placePattern(value: string): string {
  return Array.from(value.normalize("NFD").replace(/\p{M}/gu, ""), (character) =>
    accented[character.toLowerCase()] ?? escapeRegExp(character)).join("");
}

function locationPattern(location: string): string {
  const requested = location.split(",").map((part) => part.trim()).filter(Boolean);
  const country = /^(brasil|brazil)$/i;
  if (requested.length > 1 && country.test(requested.at(-1) ?? "")) requested.pop();
  const requestedState = requested.length === 2 ? requested[1] : undefined;
  const matchingState = Object.entries(states).find(([abbreviation, name]) =>
    [abbreviation, name].some((value) => value.localeCompare(requestedState ?? "", "pt-BR", { sensitivity: "base" }) === 0));
  const labels = requested.map(placePattern);
  if (matchingState) labels[1] = `(?:${matchingState.map(placePattern).join("|")})`;
  return `${labels.join("\\s*,\\s*")}(?:\\s*,\\s*(?:Brasil|Brazil))?`;
}

function radiusPattern(radiusKm: number): string {
  return `${radiusKm}\\s*(?:km|quil[oô]metros?|kilometers?)`;
}

function knownMunicipality(location: string): string | undefined {
  // The live picker shows "Itajaí / Cidade" without a state. The national
  // IBGE municipality table lists this exact municipality only in SC.
  // https://www.ibge.gov.br/explica/codigos-dos-municipios.php
  return new RegExp(`^${locationPattern("Itajaí, SC")}$`, "i").test(location) ? placePattern("Itajaí") : undefined;
}

function locationQuery(location: string): string {
  const [city, region] = location.split(",").map((part) => part.trim());
  const state = region ? states[region.toUpperCase()] ?? region : undefined;
  return [city, state].filter(Boolean).join(" ").normalize("NFD").replace(/\p{M}/gu, "");
}

function locationControl(page: Page, names: RegExp): Locator {
  return page.getByRole("button", { name: names })
    .or(page.locator(FACEBOOK_SELECTORS.locationLink).filter({ hasText: names }))
    .filter({ visible: true }).first();
}

function scopeControl(page: Page, location: string): Locator {
  const city = placePattern(location.split(",")[0]?.trim() ?? location);
  const names = new RegExp(`(?:${FACEBOOK_SELECTORS.locationControl.source})|^(?:${city}|${locationPattern(location)})$`, "i");
  return locationControl(page, names);
}

function locationDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ visible: true }).first();
}

function placeInput(dialog: Locator): Locator {
  return dialog.locator(FACEBOOK_SELECTORS.locationInput).first();
}

function radiusControl(dialog: Locator): Locator {
  return dialog.getByRole("combobox", { name: FACEBOOK_SELECTORS.radiusControl })
    .or(dialog.getByRole("button", { name: FACEBOOK_SELECTORS.radiusControl })).filter({ visible: true }).first();
}

function popupOptions(page: Page, dialog: Locator, name: RegExp): Locator {
  // In the live picker the popup is outside the dialog and repeats the option
  // role on nested elements. Treat the outer row as one suggestion.
  const portal = page.getByRole("listbox").filter({ visible: true })
    .locator('[role="option"]:not([role="option"] [role="option"])')
    .and(page.getByRole("option", { name }));
  return dialog.getByRole("option", { name }).or(portal).filter({ visible: true });
}

export async function selectFacebookLocation(page: Page, location: string, radiusKm: number): Promise<void> {
  await scopeControl(page, location).click();
  const dialog = locationDialog(page);
  const input = placeInput(dialog);
  await input.fill("");
  await input.pressSequentially(locationQuery(location));
  const completePlace = new RegExp(`^${locationPattern(location)}$`, "i");
  const city = knownMunicipality(location);
  const name = city ? new RegExp(`(?:${completePlace.source})|^${city}\\s*(?:cidade|city)$`, "i") : completePlace;
  const semanticOptions = popupOptions(page, dialog, name);
  const label = dialog.getByText(completePlace).filter({ visible: true });
  await semanticOptions.or(label).first().waitFor({ state: "visible" });
  // A single place may be exposed as both an option and a nested text label.
  // Let Playwright's strict role selector reject ambiguous place suggestions.
  await (await semanticOptions.count() > 0 ? semanticOptions : label).click();
  await selectRadius(page, dialog, radiusKm);
  await dialog.getByRole("button", { name: FACEBOOK_SELECTORS.applyLocation }).click();
  await dialog.waitFor({ state: "hidden" });
  await verifyFacebookLocation(page, location, radiusKm);
}

async function selectRadius(page: Page, dialog: Locator, radiusKm: number): Promise<void> {
  const label = new RegExp(`^${radiusPattern(radiusKm)}$`, "i");
  const native = dialog.locator("select:visible").first();
  if (await native.isVisible()) {
    const option = (await native.locator("option").allTextContents()).find((text) => label.test(text.trim()));
    if (!option) throw new Error("Facebook does not offer the requested radius");
    await native.selectOption({ label: option.trim() });
    return;
  }
  await radiusControl(dialog).click();
  const option = popupOptions(page, dialog, label);
  const text = dialog.getByText(label).filter({ visible: true });
  await option.or(text).first().waitFor({ state: "visible" });
  await (await option.count() > 0 ? option : text).click();
}

export async function verifyFacebookLocation(page: Page, location: string, radiusKm: number): Promise<void> {
  const completePlace = locationPattern(location);
  const city = knownMunicipality(location);
  const place = city ? `(?:${completePlace}|${city})` : completePlace;
  const radius = radiusPattern(radiusKm);
  const match = new RegExp(`^${FACEBOOK_SELECTORS.scopeLocationPrefix}${place}\\s*${FACEBOOK_SELECTORS.scopeDistancePrefix}${radius}(?:\\s+away)?$`, "i");
  const control = scopeControl(page, location);
  await control.waitFor({ state: "visible" });
  if (await locationControl(page, match).isVisible()) return;

  // Some browsers display just the city on the chip. Reopen the saved filter
  // to read the selected city/state and radius without typing or applying again.
  await control.click();
  const dialog = locationDialog(page);
  const cityInput = placeInput(dialog);
  const selectedPlace = await cityInput.inputValue();
  const native = dialog.locator("select:visible").first();
  const selectedRadius = await (await native.isVisible()
    ? native.locator("option:checked").innerText()
    : radiusControl(dialog).innerText());
  const radiusLabel = new RegExp(`^(?:(?:raio|radius|dist[aâ]ncia|distance)\\s*:?\\s*)?${radius}$`, "i");
  if (!new RegExp(`^${place}$`, "i").test(selectedPlace.trim()) || !radiusLabel.test(selectedRadius.trim())) {
    throw new Error("Facebook's saved location or radius differs from the request");
  }
  const close = dialog.getByRole("button", { name: FACEBOOK_SELECTORS.closeLocation }).first();
  if (await close.isVisible()) await close.click();
  else await cityInput.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}
