import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LISTING_PAGE_SIZE, listingCursor } from "../../src/dashboard/listing-pagination";
import {
  dateTime, purposeLabels, sourceName,
  type Comparison, type Definition, type Listing, type Notice, type Run, type Search, type Source,
} from "./model";
import { LegacyHistory, ListingResults, SourceHistory, type ResultView } from "./results";
import { SearchForm } from "./search-form";
import "./style.css";

const resultViews: { id: ResultView; label: string }[] = [
  { id: "opportunity", label: "Oportunidades" },
  { id: "candidate", label: "Candidatos" },
  { id: "history", label: "Histórico" },
];

const descriptions = {
  opportunity: "A mediana usa os preços anunciados de itens comparáveis.",
  candidate: "Anúncios que ainda precisam de confirmação ou ficaram abaixo dos critérios da pesquisa.",
  history: "Anúncios excluídos, pendentes e resultados de pesquisas anteriores.",
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "Confira os valores informados e salve novamente.",
      404: "A pesquisa não está mais disponível.",
      409: "Ative a pesquisa antes de executar.",
    };
    throw new Error(messages[response.status] ?? `Não foi possível concluir a operação (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

type DashboardFeed = { searchId: string; listings: Listing[]; runs: Run[] };

async function loadListings(searchId: string, options: RequestInit): Promise<Listing[]> {
  const listings = new Map<string, Listing>();
  const params = new URLSearchParams();
  if (searchId) params.set("searchId", searchId);
  while (true) {
    const query = params.toString();
    const page = await request<Listing[]>(query ? `/api/listings?${query}` : "/api/listings", options);
    for (const item of page) listings.set(item.id, item);
    const last = page.at(-1);
    if (!last || page.length < LISTING_PAGE_SIZE) return [...listings.values()];
    const after = listingCursor(last);
    if (params.get("after") === after) throw new Error("Não foi possível carregar todos os anúncios.");
    params.set("after", after);
  }
}

function useDashboardData(searchId: string, showHistory: boolean, refreshVersion: number) {
  const [searches, setSearches] = useState<Search[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [feed, setFeed] = useState<DashboardFeed | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const scope = searchId ? `?${new URLSearchParams({ searchId })}` : "";
    let nextRefresh: number;

    async function load() {
      const [searchResult, sourceResult, listingResult, runResult, comparisonResult, noticeResult] = await Promise.allSettled([
        request<Search[]>("/api/searches", options),
        request<Source[]>("/api/sources", options),
        loadListings(searchId, options),
        request<Run[]>(`/api/runs${scope}`, options),
        showHistory && !searchId ? request<Comparison[]>("/api/comparisons", options) : Promise.resolve([]),
        showHistory && !searchId ? request<Notice[]>("/api/notifications", options) : Promise.resolve([]),
      ]);
      if (controller.signal.aborted) return;

      if (searchResult.status === "fulfilled") setSearches(searchResult.value);
      if (sourceResult.status === "fulfilled") setSources(sourceResult.value);
      if (comparisonResult.status === "fulfilled") setComparisons(comparisonResult.value);
      if (noticeResult.status === "fulfilled") setNotices(noticeResult.value);
      setFeed((previous) => {
        const current = previous?.searchId === searchId ? previous : null;
        return {
          searchId,
          listings: listingResult.status === "fulfilled" ? listingResult.value : current?.listings ?? [],
          runs: runResult.status === "fulfilled" ? runResult.value : current?.runs ?? [],
        };
      });

      const offline = [searchResult, sourceResult, listingResult, runResult, comparisonResult, noticeResult]
        .some(({ status }) => status === "rejected");
      setLoadError(offline ? "Parte do painel está indisponível. Atualize para tentar novamente." : "");
      if (!offline) setRefreshedAt(new Date().toISOString());
      nextRefresh = window.setTimeout(() => void load(), 15_000);
    }

    void load();
    return () => {
      controller.abort();
      window.clearTimeout(nextRefresh);
    };
  }, [searchId, showHistory, refreshVersion]);

  return {
    searches, sources, comparisons, notices, refreshedAt, loadError,
    listings: feed?.searchId === searchId ? feed.listings : [],
    runs: feed?.searchId === searchId ? feed.runs : [],
    loading: feed?.searchId !== searchId,
  };
}

function SearchList({ searches, busy, onEdit, onRun, onToggle, onResults }: {
  searches: Search[];
  busy: boolean;
  onEdit: (search: Search) => void;
  onRun: (id: string) => void;
  onToggle: (search: Search) => void;
  onResults: (id: string) => void;
}) {
  return (
    <section className="search-section" aria-labelledby="search-heading">
      <h2 id="search-heading">Suas pesquisas</h2>
      {searches.length === 0 ? (
        <div className="empty">Crie uma pesquisa para começar a monitorar anúncios.</div>
      ) : (
        <div className="searches">
          {searches.map((search) => (
            <article className="search" key={search.id}>
              <div>
                <div className="search-title">
                  <h3>{search.name}</h3>
                  <span className={search.active ? "badge active" : "badge"}>{search.active ? "Ativa" : "Pausada"}</span>
                </div>
                <p>
                  {search.query} · {search.providers.map(sourceName).join(", ")}
                  {search.opportunitySettings ? ` · ${purposeLabels[search.opportunitySettings.purpose]}` : " · Pesquisa anterior"}
                </p>
                <small>
                  A cada {search.intervalMinutes} min
                  {search.lastRunAt ? <> · Última execução em <time dateTime={search.lastRunAt}>{dateTime(search.lastRunAt)}</time></> : null}
                </small>
              </div>
              <div className="actions">
                <button type="button" className="text" onClick={() => onResults(search.id)}>Ver anúncios</button>
                <button type="button" className="secondary" disabled={busy || !search.active} onClick={() => onRun(search.id)}>Executar agora</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => onEdit(search)}>Editar</button>
                <button type="button" className="text" disabled={busy} onClick={() => onToggle(search)}>{search.active ? "Pausar" : "Ativar"}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function App() {
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<ResultView>("opportunity");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [editor, setEditor] = useState<{ search: Search | null } | null>(null);
  const [actionError, setActionError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const showHistory = view === "history";
  const data = useDashboardData(filter, showHistory, refreshVersion);

  function refresh() {
    setRefreshVersion((version) => version + 1);
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setActionError("");
    setFeedback("");
    try {
      await fn();
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }

  function selectSearch(id: string) {
    const search = data.searches.find((entry) => entry.id === id);
    setFilter(id);
    if (search && !search.opportunitySettings) setView("history");
    else if (view === "history") setView("opportunity");
  }

  function openEditor(search: Search | null) {
    setActionError("");
    setEditor({ search });
  }

  function save(definition: Definition) {
    if (!editor) return;
    const searchId = editor.search?.id;
    void act(async () => {
      const search = await request<Search>(searchId ? `/api/searches/${encodeURIComponent(searchId)}` : "/api/searches", json(searchId ? "PATCH" : "POST", definition));
      if (!searchId) {
        setFilter(search.id);
        setView("opportunity");
      }
      setEditor(null);
      setFeedback("Pesquisa salva.");
    });
  }

  function run(id: string) {
    void act(async () => {
      await request(`/api/searches/${encodeURIComponent(id)}/run`, json("POST", {}));
      setFeedback("Execução solicitada. O painel atualiza o andamento automaticamente.");
    });
  }

  function toggle(search: Search) {
    void act(async () => {
      await request(`/api/searches/${encodeURIComponent(search.id)}`, json("PATCH", { active: !search.active }));
      setFeedback(search.active ? "Pesquisa pausada." : "Pesquisa ativada.");
    });
  }

  return (
    <div className="shell">
      <header>
        <div className="header-inner">
          <div className="brand"><span className="brand-mark" aria-hidden="true">◈</span><strong>Used Deal Radar</strong></div>
          <div className="actions">
            <button type="button" className="text" onClick={refresh}>Atualizar</button>
            <button type="button" onClick={() => openEditor(null)}>Nova pesquisa</button>
          </div>
        </div>
      </header>
      <main>
        <section className="intro">
          <h1>Oportunidades em usados</h1>
          <p>Para uso pessoal ou revenda, acompanhe a OLX, o Facebook Marketplace e o Mercado Livre.</p>
        </section>
        {data.loadError ? <p role="alert" className="error">{data.loadError}</p> : null}
        {!editor && actionError ? <p role="alert" className="error">{actionError}</p> : null}
        {feedback ? <p role="status" className="feedback">{feedback}</p> : null}
        <div className="columns">
          <section id="results" aria-labelledby="results-heading">
            <div className="feed-header">
              <h2 id="results-heading">Anúncios monitorados</h2>
              <label>
                Pesquisa
                <select value={filter} onChange={(event) => selectSearch(event.target.value)}>
                  <option value="">Todas as pesquisas</option>
                  {data.searches.map((search) => <option key={search.id} value={search.id}>{search.name}</option>)}
                </select>
              </label>
            </div>
            <div className="feed-toolbar" role="group" aria-label="Tipo de resultado">
              {resultViews.map(({ id, label }) => (
                <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
              ))}
            </div>
            <p className="feed-description">{descriptions[view]}</p>
            <ListingResults listings={data.listings} searchId={filter} view={view} loading={data.loading} />
            {showHistory && !filter ? <LegacyHistory comparisons={data.comparisons} notices={data.notices} /> : null}
          </section>
          <div>
            <SourceHistory
              runs={data.runs.slice(0, showHistory ? undefined : 5)}
              sources={showHistory ? data.sources : data.sources.filter(({ name }) => name === "olx" || name === "facebook" || name === "mercadolivre")}
              loading={data.loading}
            />
            {data.refreshedAt ? <p className="hint">Painel atualizado em <time dateTime={data.refreshedAt}>{dateTime(data.refreshedAt)}</time></p> : null}
          </div>
        </div>
        <SearchList
          searches={data.searches}
          busy={busy}
          onEdit={openEditor}
          onRun={run}
          onToggle={toggle}
          onResults={(id) => {
            selectSearch(id);
            document.getElementById("results")?.scrollIntoView();
          }}
        />
      </main>
      {editor ? (
        <SearchForm search={editor.search} sources={data.sources} busy={busy} error={actionError} onClose={() => {
          setEditor(null);
          setActionError("");
        }} onSave={save} />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
