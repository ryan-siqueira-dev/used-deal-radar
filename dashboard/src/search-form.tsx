import { useEffect, useRef, useState, type FormEvent } from "react";
import { purposeLabels, sourceName, sourceNames, type Definition, type Search, type Source, type UsedSearchSettings } from "./model";

const usedSources = ["olx", "facebook", "mercadolivre"];

const blank: Definition = {
  name: "",
  query: "",
  category: "generic",
  providers: usedSources,
  minPrice: null,
  maxPrice: null,
  minYear: null,
  maxYear: null,
  location: null,
  radiusKm: null,
  minimumScore: 70,
  intervalMinutes: 60,
  forbiddenWords: [],
  opportunitySettings: {
    purpose: "personal",
    minimumDiscountPercent: 15,
    minimumComparables: 5,
    facebookLocation: "Itajaí, SC",
    facebookRadiusKm: 40,
    costs: { fixed: null, feePercent: null },
  },
};

function optionalNumber(value: string): number | null {
  return value === "" ? null : Number(value);
}

export function SearchForm({ search, sources, busy, error, onClose, onSave }: {
  search: Search | null;
  sources: Source[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (definition: Definition) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Definition>(() => search ? {
    name: search.name,
    query: search.query,
    category: search.category,
    providers: search.providers,
    minPrice: search.minPrice === null ? null : Number(search.minPrice),
    maxPrice: search.maxPrice === null ? null : Number(search.maxPrice),
    minYear: search.minYear,
    maxYear: search.maxYear,
    location: search.location,
    radiusKm: search.radiusKm,
    minimumScore: search.minimumScore,
    intervalMinutes: search.intervalMinutes,
    forbiddenWords: search.forbiddenWords,
    opportunitySettings: search.opportunitySettings ?? null,
  } : blank);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const settings = form.opportunitySettings;
  const providers = settings ? usedSources : [...new Set([...Object.keys(sourceNames), ...form.providers])];

  function set<K extends keyof Definition>(key: K, value: Definition[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function setSettings(patch: Partial<UsedSearchSettings>) {
    setForm((previous) => previous.opportunitySettings
      ? { ...previous, opportunitySettings: { ...previous.opportunitySettings, ...patch } }
      : previous);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(form);
  }

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="form-title" onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
      <div className="heading">
        <h2 id="form-title">{search ? "Editar pesquisa" : "Nova pesquisa"}</h2>
        <button type="button" className="text" disabled={busy} onClick={onClose}>Fechar</button>
      </div>
      {error ? <p role="alert" className="error">{error}</p> : null}
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Nome
            <input required maxLength={120} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label>
            Termo de busca
            <input required maxLength={300} value={form.query} onChange={(e) => set("query", e.target.value)} />
          </label>
          <label>
            Categoria
            <select value={form.category} onChange={(e) => set("category", e.target.value)}>
              <option value="generic">Geral</option>
              <option value="electronics">Eletrônicos</option>
              <option value="gpu">Placas de vídeo</option>
              <option value="notebook">Notebooks</option>
              <option value="vehicle">Veículos</option>
            </select>
          </label>
          {settings ? (
            <label>
              Finalidade
              <select value={settings.purpose} onChange={(e) => setSettings({ purpose: e.target.value === "resale" ? "resale" : "personal" })}>
                <option value="personal">{purposeLabels.personal}</option>
                <option value="resale">{purposeLabels.resale}</option>
              </select>
            </label>
          ) : (
            <label>
              Pontuação mínima
              <input type="number" min="0" max="100" required value={Number.isNaN(form.minimumScore) ? "" : form.minimumScore} onChange={(e) => set("minimumScore", e.target.valueAsNumber)} />
            </label>
          )}
          <label>
            Preço mínimo (R$)
            <input type="number" min="0" step="0.01" value={form.minPrice ?? ""} onChange={(e) => set("minPrice", optionalNumber(e.target.value))} />
          </label>
          <label>
            Preço máximo (R$)
            <input type="number" min="0" step="0.01" value={form.maxPrice ?? ""} onChange={(e) => set("maxPrice", optionalNumber(e.target.value))} />
          </label>
          <label>
            Ano mínimo
            <input type="number" min="1900" max="2200" value={form.minYear ?? ""} onChange={(e) => set("minYear", optionalNumber(e.target.value))} />
          </label>
          <label>
            Ano máximo
            <input type="number" min="1900" max="2200" value={form.maxYear ?? ""} onChange={(e) => set("maxYear", optionalNumber(e.target.value))} />
          </label>
          <label>
            Intervalo (minutos)
            <input type="number" min="1" max="525600" required value={form.intervalMinutes || ""} onChange={(e) => set("intervalMinutes", Number(e.target.value))} />
          </label>
          {settings ? (
            <>
              <label>
                Desconto mínimo (%)
                <input type="number" min="0" max="100" step="0.01" required value={Number.isNaN(settings.minimumDiscountPercent) ? "" : settings.minimumDiscountPercent} onChange={(e) => setSettings({ minimumDiscountPercent: e.target.valueAsNumber })} />
              </label>
              <label>
                Mínimo de anúncios comparáveis
                <input type="number" min="5" required value={settings.minimumComparables || ""} onChange={(e) => setSettings({ minimumComparables: Number(e.target.value) })} />
              </label>
            </>
          ) : (
            <>
              <label>
                Localização
                <input value={form.location ?? ""} onChange={(e) => set("location", e.target.value || null)} />
              </label>
              <label>
                Raio (km)
                <input type="number" min="1" value={form.radiusKm ?? ""} onChange={(e) => set("radiusKm", optionalNumber(e.target.value))} />
              </label>
            </>
          )}
        </div>
        <label>
          Palavras proibidas (separadas por vírgula)
          <input defaultValue={form.forbiddenWords.join(", ")} onChange={(e) => set("forbiddenWords", e.target.value.split(",").map((word) => word.trim()).filter(Boolean))} />
        </label>
        <fieldset>
          <legend>Fontes</legend>
          <div className="source-options">
            {providers.map((provider) => {
              const source = sources.find(({ name }) => name === provider);
              return (
                <label className="check" key={provider}>
                  <input
                    type="checkbox"
                    checked={form.providers.includes(provider)}
                    onChange={(e) => set("providers", e.target.checked
                      ? [...form.providers, provider]
                      : form.providers.filter((name) => name !== provider))}
                  />
                  <span>
                    {sourceName(provider)}
                    {(provider === "olx" || provider === "mercadolivre") && settings ? " (Brasil)" : ""}
                    {source?.status === "disabled" ? " · desativada" : ""}
                    {source?.status === "unavailable" ? " · indisponível" : ""}
                  </span>
                </label>
              );
            })}
          </div>
          {settings ? (
            <div className="form-grid">
              <label>
                Localização no Facebook
                <input required maxLength={200} value={settings.facebookLocation} onChange={(e) => setSettings({ facebookLocation: e.target.value })} />
              </label>
              <label>
                Raio no Facebook (km)
                <input type="number" min="1" max="2000" required value={settings.facebookRadiusKm || ""} onChange={(e) => setSettings({ facebookRadiusKm: Number(e.target.value) })} />
              </label>
            </div>
          ) : null}
        </fieldset>
        {settings?.purpose === "resale" ? (
          <fieldset>
            <legend>Custos de revenda</legend>
            <p className="hint">Deixe em branco quando o valor for desconhecido. Use 0 para custos inexistentes.</p>
            <div className="form-grid">
              <label>
                Custos fixos totais (R$)
                <input type="number" min="0" step="0.01" value={settings.costs.fixed ?? ""} onChange={(e) => setSettings({ costs: { ...settings.costs, fixed: optionalNumber(e.target.value) } })} />
              </label>
              <label>
                Taxa sobre a venda (%)
                <input type="number" min="0" max="100" step="0.01" value={settings.costs.feePercent ?? ""} onChange={(e) => setSettings({ costs: { ...settings.costs, feePercent: optionalNumber(e.target.value) } })} />
              </label>
            </div>
          </fieldset>
        ) : null}
        <button disabled={busy || form.providers.length === 0} type="submit">Salvar pesquisa</button>
      </form>
    </dialog>
  );
}
