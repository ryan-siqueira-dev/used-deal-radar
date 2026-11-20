# TUI de execução local

## Comportamento

O usuário abre `npm run tui` para controlar a instalação local. O menu inicia sem subir serviços. Iniciar sobe PostgreSQL e aplicação com painel e agendador no Docker Compose. Fechar o terminal deixa os serviços em execução. Parar encerra os containers e preserva banco, pesquisas e sessões. Reabrir o TUI consulta o estado real dos containers.

## Abordagem proposta

Reaproveitar o Compose do dashboard com configuração local de reinício desativado e implementar o menu em TypeScript com as APIs de terminal do Node. Essa abordagem usa o ciclo de vida já existente para banco, migrações e aplicação. Uma alternativa com aplicação no host exigiria outro gerenciamento de processos e builds, por isso a proposta concentra os serviços no Docker.

## Menu

- Iniciar o app local e aguardar banco e painel disponíveis.
- Abrir o painel no navegador.
- Ver logs com retorno ao menu ao interromper a visualização.
- Parar o app local, preservando volumes e sessões.
- Sair do TUI, mantendo o estado dos serviços.

## Preparação e falhas

Na primeira execução, permitir criar a configuração local com senha aleatória, permissões privadas e os caminhos das sessões existentes. Preservar configurações já existentes. Informar Docker indisponível, porta ocupada, build ou migração com falha e oferecer nova tentativa pelo menu. Usar argumentos estruturados para subprocessos e encerrar apenas os serviços desse projeto.

O modo local não registra serviço de inicialização. Seus containers usam política de reinício desativada. O agendador funciona enquanto a aplicação estiver ligada manualmente.

## Verificação

Testar comandos e transições do menu, configuração inicial e preservação de arquivo existente, idempotência de iniciar/parar, falhas de subprocesso e separação entre sair e parar. Validar o Compose efetivo, compilar o projeto e executar um ciclo real de início, saída, reabertura e parada com banco descartável quando possível.
