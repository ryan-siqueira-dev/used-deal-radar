# Painel de oportunidades em usados

O painel monitora pesquisas por termos em qualquer categoria, com finalidade de uso próprio ou revenda. Ele usa o agendador e o histórico de anúncios existentes.

## Pesquisas e avaliação

- A OLX usa busca nacional. O Facebook usa Itajaí, SC, com raio inicial de 40 km, ajustável na pesquisa.
- O intervalo inicial é de 60 minutos. O agendador precisa estar ativo para executar pesquisas em segundo plano.
- O desconto inicial exigido é de 15% sobre a mediana de pelo menos cinco anúncios comparáveis. Ambos os critérios são configuráveis, com mínimo de cinco comparáveis.
- A referência usa preços pedidos por usados equivalentes e recentes da OLX e do Facebook. A recência é controlada por `COMPARABLE_MAX_AGE_DAYS`, inicialmente 30 dias. O anúncio avaliado e duplicatas com evidências suficientes são excluídos da amostra.
- Anúncios com evidência de produto novo, recondicionado ou avariado são excluídos das oportunidades. Condição desconhecida, preço ausente ou amostra insuficiente deixam o anúncio como candidato.
- Indicação de envio ou retirada vem do anúncio. Quando falta informação, o painel pede confirmação. A seleção regional do Facebook é conferida no próprio site, enquanto a distância individual do anúncio permanece sem verificação geodésica.

Para revenda, preencha os custos fixos estimados em reais, incluindo frete e demais despesas, e o percentual de taxas sobre a venda. Um campo vazio significa custo desconhecido. Informe zero quando tiver confirmado a ausência daquele custo.

O lucro estimado é a mediana menos preço de compra, custos fixos e taxas sobre a venda. A margem divide esse lucro pelo custo total estimado. O sistema exige desconto suficiente e lucro positivo para destacar uma oportunidade de revenda. Os valores usam preços anunciados como referência.

O painel tem oportunidades, candidatos e histórico. Cada anúncio mantém uma avaliação por pesquisa, permitindo finalidades e custos diferentes. Quando critérios ou dados do anúncio mudam, a avaliação anterior passa ao histórico até ser recalculada. A listagem é paginada pela API, e o painel carrega as páginas automaticamente.

## Configuração local

### Controle manual pelo TUI

Use `npm run tui` no diretório do projeto. O menu mostra o estado atual do banco e do painel antes de qualquer ação. Escolha Iniciar para preparar a configuração, iniciar o PostgreSQL no Docker, gerar o cliente Prisma, aplicar as migrações e compilar o backend e o painel. A aplicação e os coletores rodam na sua máquina. A inicialização aguarda a confirmação de que o servidor local está pronto.

Abrir painel usa o navegador do sistema. Ver logs acompanha a saída dos serviços e permite voltar ao menu com Ctrl+C. Parar encerra os serviços preservando o banco e os arquivos de sessão. Sair ou fechar o terminal mantém os serviços em execução. Na próxima abertura, o TUI consulta o banco e o processo local novamente.

Esse modo combina `docker-compose.dashboard.yml` com `docker-compose.local.yml` para iniciar apenas o PostgreSQL, publicado em `127.0.0.1` na porta `POSTGRES_PORT` (5433 por padrão). O app será iniciado quando você escolher Iniciar no menu. O agendador monitora as pesquisas enquanto o app estiver ligado. O painel usa `DASHBOARD_PORT`, inicialmente 3000. O modo local utiliza o banco `deal_finder_dashboard` e a senha já configurada, preservando o volume e as pesquisas da instalação anterior.

Se `.env` estiver ausente, a primeira inicialização gera uma senha aleatória para o banco e um arquivo privado. Configurações existentes são preservadas. As sessões locais já salvas podem ser reutilizadas para habilitar suas respectivas fontes.

O navegador Chromium local é usado pelos coletores. Para a OLX, a execução local usa janela visível, conforme o ambiente que passou pela validação. Mantenha sua sessão gráfica disponível durante as buscas. Os logs da aplicação ficam em `.runtime/host.log`, e o controle do processo usa um socket privado em `.runtime/`. Fechar o TUI mantém esse processo ligado. Parar solicita o encerramento da aplicação antes de parar o banco.

Ao migrar da execução anterior, Iniciar encerra o container antigo do painel antes de abrir o servidor local. A configuração de reinício permanece manual.

### Execução direta pelo Compose

Prepare `.env` a partir de `.env.example`, configure `POSTGRES_PASSWORD` e a `DATABASE_URL` conforme o README e crie os diretórios privados `data` e `.runtime`.

Para usar as fontes, configure `OLX_ENABLED=true` e/ou `FACEBOOK_ENABLED=true`, obtenha as sessões pelos comandos `npm run olx:login` e `npm run facebook:login` e mantenha os arquivos nos caminhos configurados. Os coletores continuam opt-in e dependem do acesso disponível no ambiente de execução.

Com `SCHEDULER_ENABLED=true`, execute o painel e o banco pelo Compose próprio.

```bash
docker compose -f docker-compose.dashboard.yml up --build -d
```

Acesse [o painel local](http://localhost:3000). Esse Compose usa um banco e volume próprios. O entrypoint aplica as migrações antes de iniciar a aplicação. Os arquivos de sessão são montados de `data/`.

Para executar no host fora do TUI, configure `DATABASE_URL` com o banco `deal_finder_dashboard`, a senha existente e a porta local do PostgreSQL. Depois de instalar as dependências, rode os comandos abaixo. O TUI monta essa conexão automaticamente sem alterar o arquivo de configuração existente.

```bash
npm run prisma:generate
npm run prisma:migrate
npm run build
npm run dashboard:build
npm run dashboard:start
```

Para desligar os containers mantendo os dados, use `docker compose -f docker-compose.dashboard.yml down`.

## Execuções e compatibilidade

O painel mostra execuções em andamento, concluídas, parciais, interrompidas e com falha. Por fonte, registra o escopo aplicado, quantidade encontrada, erros e falhas de obtenção de detalhes. Alterar ou pausar uma pesquisa revoga sua execução vigente. Após interrupção, o agendador recupera os registros cujo lease expirou. Uma fonte com falha permite que a outra continue.

O novo fluxo de usados entrega resultados apenas no painel e usa regras determinísticas para classificar oportunidades. A LLM opcional continua disponível para a extração suplementar existente. Pesquisas legadas mantêm seu comportamento e histórico, incluindo a integração antiga de Telegram quando configurada. Fontes anteriores continuam disponíveis no código e no histórico. Ao editar uma pesquisa legada no painel, é possível convertê-la para o modo de usados.

As migrações adicionam configurações e avaliações de oportunidades, vínculo com a avaliação vigente e histórico de execuções. Faça backup antes de atualizar uma instalação existente.

## Validação

Os testes usam fixtures sintéticas para condição, defeitos, preços, moeda, escopo regional, páginas vazias e indisponíveis, comparáveis, margens, concorrência e histórico. A interface foi verificada em Chromium, inclusive em tela móvel e com resultados distribuídos em várias páginas. As migrações foram verificadas em PostgreSQL limpo e com registros legados sintéticos.

Em 20/11/2026, uma busca real por sofá retornou três anúncios na OLX nacional e três no Facebook, com Itajaí e raio de 40 km confirmados na interface. Os detalhes de um anúncio de cada fonte foram lidos, incluindo preço, moeda, localização e imagens. As sessões foram salvas localmente. A verificação cobriu busca e detalhes nos coletores. A execução agendada em uma instalação configurada permanece uma etapa operacional. Mudanças de layout, expiração de sessão e bloqueios são apresentados como falhas. O Facebook desta conta oferece 40 km entre as opções de raio, usado como novo padrão.

O serviço é local, sem autenticação. A porta do Compose é publicada em `127.0.0.1`. Os termos e as condições de uso dos providers permanecem documentados no README e em `docs/PROVIDERS.md`.

### Mercado Livre: componentes usados

O formulário de novas pesquisas inclui Mercado Livre. Para pesquisas existentes, edite e marque a fonte. A busca é nacional e aplica o filtro Usado; detalhes e condição são coletados no navegador local.

Antes da primeira coleta, execute `npm run mercadolivre:web-login`, conclua a verificação no Chromium e confirme no terminal. Configure `MERCADOLIVRE_ENABLED=true` e `MERCADOLIVRE_MODE=web` no `.env`. Se necessário, configure `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` para o login. Reinicie pelo TUI após configurar. Sessões ficam em `data/` e não devem ser compartilhadas.
