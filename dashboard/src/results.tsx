import {
  dateTime, money, percent, purposeLabels, sourceName,
  type Analysis, type Comparison, type Listing, type Notice, type Run, type SearchLink, type Source, type SourceRun,
} from "./model";

export type ResultView = "opportunity" | "candidate" | "history";

const conditionLabels = {
  used: "Usado ou seminovo",
  unknown: "Condição a confirmar",
  new: "Novo",
  refurbished: "Recondicionado",
  damaged: "Com avaria",
};
const shippingLabels = {
  available: "Envio informado",
  pickup_only: "Somente retirada",
  unknown: "Envio a confirmar",
};
const resultLabels = {
  opportunity: "Oportunidade",
  candidate: "Candidato",
  excluded: "Excluído",
};

type Result = { listing: Listing; link: SearchLink | null; analysis?: Analysis };

export function ListingResults({ listings, searchId, view, loading }: {
  listings: Listing[];
  searchId: string;
  view: ResultView;
  loading: boolean;
}) {
  const results: Result[] = listings.flatMap<Result>((listing) => {
    if (listing.searches.length === 0 && searchId === "" && view === "history") {
      return [{ listing, link: null, analysis: listing.analyses[0] }];
    }
    return listing.searches.flatMap((link) => {
      if (searchId && link.searchId !== searchId) return [];
      const analysis = link.analyses[0];
      const classification = analysis?.current && link.search.purpose ? analysis.opportunity?.classification : undefined;
      const resultView = classification === "candidate" || classification === "opportunity" ? classification : "history";
      return view === resultView ? [{ listing, link, analysis }] : [];
    });
  });

  if (loading) return <div className="empty" role="status">Carregando anúncios…</div>;
  if (results.length === 0) {
    const messages = {
      opportunity: "Nenhum anúncio atingiu os critérios de oportunidade nesta seleção.",
      candidate: "Nenhum candidato nesta seleção.",
      history: "Nenhum anúncio arquivado ou com análise pendente nesta seleção.",
    };
    return <div className="empty">{messages[view]}</div>;
  }
  return (
    <div className="offers">
      {results.map((result) => (
        <ListingCard key={`${result.listing.id}:${result.link?.searchId ?? ""}`} {...result} />
      ))}
    </div>
  );
}

function ListingCard({ listing, link, analysis }: Result) {
  const opportunity = analysis?.opportunity;
  const currency = listing.currency ?? "BRL";
  const isStale = analysis?.current === false;
  const historicalPrice = isStale && opportunity;
  const shownPrice = historicalPrice ? opportunity.listingSnapshot?.price ?? null : listing.price;
  const shownCurrency = historicalPrice ? opportunity.listingSnapshot?.currency ?? "BRL" : currency;
  const shownLocation = historicalPrice ? opportunity.listingSnapshot?.location : listing.location;
  const badge = isStale ? "Análise anterior"
    : opportunity ? resultLabels[opportunity.classification]
    : analysis ? `${analysis.score} pontos` : "Análise pendente";

  return (
    <article className="offer">
      <div className="offer-top">
        <span>{sourceName(listing.source)}</span>
        <span className={`badge ${isStale ? "" : opportunity?.classification ?? ""}`}>{badge}</span>
      </div>
      <h3><a href={listing.url} target="_blank" rel="noreferrer">{listing.title}</a></h3>
      <p>{shownLocation ?? "Localização não informada"}</p>
      {link ? <p className="offer-search">{link.search.name}{link.search.purpose ? ` · ${purposeLabels[link.search.purpose]}` : ""}</p> : null}
      <dl className="offer-metrics">
        <div>
          <dt>{historicalPrice ? "Preço na análise" : "Preço anunciado"}</dt>
          <dd className="offer-price">{shownPrice === null ? "Sem preço" : money(shownPrice, shownCurrency)}</dd>
        </div>
        {opportunity ? (
          <div>
            <dt>Mediana dos comparáveis</dt>
            <dd>{opportunity.referencePrice === null ? "Indisponível" : money(opportunity.referencePrice)}</dd>
            <small>Amostra de {opportunity.sampleSize} {opportunity.sampleSize === 1 ? "anúncio" : "anúncios"}</small>
          </div>
        ) : null}
      </dl>
      {opportunity ? (
        <>
          <dl className="offer-stats">
            {opportunity.discountPercent !== null ? (
              <div><dt>Desconto</dt><dd className={opportunity.discountPercent >= 0 ? "favorable" : ""}>{percent(opportunity.discountPercent)}</dd></div>
            ) : null}
            {opportunity.estimatedProfit !== null ? (
              <div><dt>Lucro estimado</dt><dd className={opportunity.estimatedProfit > 0 ? "favorable" : ""}>{money(opportunity.estimatedProfit)}</dd></div>
            ) : null}
            {opportunity.estimatedMarginPercent !== null ? (
              <div><dt>Margem estimada</dt><dd>{percent(opportunity.estimatedMarginPercent)}</dd></div>
            ) : null}
          </dl>
          <p className="offer-condition">{conditionLabels[opportunity.condition]} · {shippingLabels[opportunity.shipping]}</p>
          <p>{opportunity.reason}</p>
          {opportunity.warnings.length > 0 ? (
            <ul className="offer-warnings">
              {[...new Set(opportunity.warnings)].map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}
      <div className="offer-footer">
        <small>Visto em <time dateTime={link?.lastMatchedAt ?? listing.lastSeenAt}>{dateTime(link?.lastMatchedAt ?? listing.lastSeenAt)}</time></small>
        {analysis ? <small>Analisado em <time dateTime={analysis.createdAt}>{dateTime(analysis.createdAt)}</time></small> : null}
      </div>
      {(!opportunity && analysis) || listing.priceHistory.length > 0 ? (
        <details>
          <summary>{opportunity ? "Histórico de preços" : "Análise e histórico"}</summary>
          {!opportunity && analysis ? (
            <>
              <p>{analysis.reason}</p>
              {analysis.risks.map((risk) => <p key={risk}>{risk}</p>)}
            </>
          ) : null}
          {listing.priceHistory.map(({ observedAt, price }, index) => (
            <p key={`${observedAt}:${index}`}><time dateTime={observedAt}>{dateTime(observedAt)}</time> · {money(price, currency)}</p>
          ))}
        </details>
      ) : null}
    </article>
  );
}

const runStatuses: Record<Run["status"], string> = {
  running: "Em andamento",
  success: "Concluída",
  partial: "Parcial",
  failed: "Falhou",
  interrupted: "Interrompida",
};

const sourceRunStatuses: Record<SourceRun["status"], string> = {
  running: "Em coleta",
  success: "Coleta concluída",
  empty: "Sem resultados",
  failed: "Falha na coleta",
  disabled: "Desativada",
};

function RunDetails({ run }: { run: Run }) {
  return (
    <div className="run-details">
      <p>
        {run.finishedAt ? <>Fim em <time dateTime={run.finishedAt}>{dateTime(run.finishedAt)}</time> · </> : null}
        {run.discovered} localizados, {run.analyzed} analisados
      </p>
      {Object.entries(run.providers).map(([name, source]) => {
        const region = source.scope.location ?? (name === "olx" ? "Brasil" : null);
        const scope = region && source.scope.radiusKm !== null ? `${region}, ${source.scope.radiusKm} km` : region;
        const failedDetails = source.detailFailures > 0
          ? `${source.detailFailures} ${source.detailFailures === 1 ? "falha" : "falhas"} ao abrir anúncios`
          : null;
        const status = source.status === "success" && failedDetails ? "Coleta parcial"
          : source.status === "running" && run.status === "interrupted" ? "Coleta interrompida"
          : sourceRunStatuses[source.status];
        return (
          <div className="run-source" key={name}>
            <div><strong>{sourceName(name)}</strong><span>{status}</span></div>
            <small>
              {[scope, scope && !source.scope.verified ? "abrangência a confirmar" : null, `${source.count} anúncios`, failedDetails]
                .filter(Boolean).join(" · ")}
            </small>
            {source.error ? <code>{source.error}</code> : null}
          </div>
        );
      })}
    </div>
  );
}

const providerStatuses: Record<string, string> = {
  disabled: "Desativada",
  unavailable: "Indisponível",
  blocked: "Bloqueada",
  error: "Erro na coleta",
  working: "Busca e detalhes verificados",
};

export function SourceHistory({ runs, sources, loading }: { runs: Run[]; sources: Source[]; loading: boolean }) {
  return (
    <aside className="monitoring">
      <section aria-labelledby="run-heading">
        <h2 id="run-heading">Execuções recentes</h2>
        {loading ? <div className="empty">Carregando execuções…</div>
          : runs.length === 0 ? <div className="empty">Nenhuma execução registrada nesta seleção.</div>
          : <div className="run-list">
            {runs.map((run, index) => (
              <details className="run" key={run.id} open={index === 0}>
                <summary>
                  <span className="run-title">{run.search.name}</span>
                  <span className={`badge ${run.status}`}>{runStatuses[run.status]}</span>
                  <small><time dateTime={run.startedAt}>{dateTime(run.startedAt)}</time></small>
                </summary>
                <RunDetails run={run} />
              </details>
            ))}
          </div>}
      </section>
      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading">Fontes</h2>
        <div className="source-list">
          {sources.map((source) => (
            <div key={source.name}>
              <span>{sourceName(source.name)}</span>
              <span className="source-state">
                {providerStatuses[source.status] ?? "Validação pendente"}
                {source.error ? ` (${source.error})` : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

export function LegacyHistory({ comparisons, notices }: { comparisons: Comparison[]; notices: Notice[] }) {
  return (
    <>
      {comparisons.length > 0 ? (
        <section className="legacy-section" aria-labelledby="comparisons-heading">
          <h2 id="comparisons-heading">Comparações anteriores</h2>
          <div className="searches">
            {comparisons.map((comparison) => (
              <article className="search" key={`${comparison.leftId}-${comparison.rightId}`}>
                <div>
                  <p>{comparison.confidence === "confirmed" ? "Identidade e condição compatíveis" : "Possível correspondência"}</p>
                  <small>{comparison.reason}</small>
                  <div className="compare-pair">
                    {[comparison.left, comparison.right].map((offer) => (
                      <div key={offer.url}>
                        <a href={offer.url} target="_blank" rel="noreferrer">{offer.title}</a>
                        <small>{sourceName(offer.source)} · {offer.price === null ? "Sem preço" : money(offer.price, comparison.currency)}</small>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {notices.length > 0 ? (
        <section className="legacy-section" aria-labelledby="notices-heading">
          <h2 id="notices-heading">Entregas anteriores de alertas</h2>
          <ul className="notice-list">
            {notices.map((notice) => (
              <li key={notice.id}>
                <strong>{notice.listing.title}</strong>
                <p>{notice.status === "failed" ? `Falhou (${notice.lastError ?? "erro de envio"})` : notice.status}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
