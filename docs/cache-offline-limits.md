# Cache, atualização e offline

## Clima

- Mesmos providers e DTO: OpenWeather primeiro, WeatherAPI como fallback.
- TTL de 10 minutos contado somente depois de resposta bem-sucedida.
- Coordenada só é confirmada junto da resposta. Falha não impede nova tentativa
  no mesmo lugar. Retentativa automática após 30 s; movimento pode antecipá-la.
- Debounce permanece 1 s e distância permanece 5 km enquanto o dado está fresco.
- Verificação de expiração a cada segundo em foreground, respeitando visibilidade,
  toque e requisição pendente. Retoma ao voltar ao foreground.
- Timeout por provider: 2,5 s, inclusive leitura do corpo; orçamento sequencial
  máximo nominal 5 s, mais scheduling/rede entre app e backend.
- App limita cada requisição a 8 s para não ficar preso a uma conexão indisponível.
- Sem persistência do clima; a última resposta da sessão continua disponível.

## MapLibre: descartável versus offline explícito

O cache ambiente permanece em **256 MiB compartilhados entre base e ENC**.
Esse limite não controla RAM e não é aplicado aos recursos referenciados pelos
packs offline nativos. Não chamamos `resetDatabase`, que apagaria ambos.

`apps/mobile/offline/offline-areas.ts` prepara a API interna, sem nova UI:

- `downloadOfflineArea`: bounds e zooms explícitos (0–16), snapshot do estilo,
  fontes remotas resolvidas para URLs de tiles versionadas e SOUNDG inline.
- O estilo local inclui uma layer SOUNDG para que o downloader nativo realmente
  inclua a ENC e a fonte dos números, não apenas o mapa-base.
- JSON do estilo em `Paths.document/offline-areas`, fora do diretório de cache.
- Dados pertencem a `OfflineManager.createPack`, persistidos na base nativa e
  protegidos da expulsão por cache ambiente. Remoção só via `removeOfflineArea`.
- `openOfflineArea` recusa packs incompletos e retorna o estilo-base congelado e
  a definição inline da ENC para os componentes existentes. Não consulta APIs.
- Versão da carta, fontes fixadas, data, bounds e zooms ficam associados ao pack.
- Atualização = baixar outro pack; a versão anterior não é apagada implicitamente.
- `listOfflineAreas` informa progresso, tamanho e estado nativos após reabertura.
- Limite de preparação: 5 packs; uma transferência ativa por vez; pausa ao
  ultrapassar o orçamento contabilizado de 512 MiB; mínimo 128 MiB livres para
  iniciar. 512 MiB é um **limiar de pausa**, não quota física: eventos assíncronos
  podem ultrapassá-lo, e recursos compartilhados podem ser contabilizados mais
  de uma vez. Não apagamos packs para cumprir esse orçamento.

Não foi adicionada seleção/download na interface, nem troca automática do mapa
online para um pack. A integração de produto deverá chamar esses métodos e usar
o retorno de `openOfflineArea`; não confundir a infraestrutura pronta com um
botão offline já disponível. A garantia vale para packs completos, bounds/zooms
baixados e armazenamento intacto, não desinstalação/limpeza de dados do sistema.

RAM de mapa-base/ENC continua gerenciada pelo MapLibre Native. Não foi imposto
um teto artificial de RAM através de uma API inexistente, nem alterado o SDK.

## ENC/Nginx

Os PBFs continuam pré-processados, mas seleção de versão e composição de shards
pertencem exclusivamente à API.

- O cliente acessa apenas `/tiles/soundg/{z}/{x}/{y}.pbf`.
- Tile existente: 200 e cache `max-age=30, must-revalidate`.
- Tile sem conteúdo: 204 sem corpo com a mesma política de cache.
- Coordenadas inválidas: 400. Rotas legadas contendo versão: 404 com `no-store`.
- O TileJSON continua `no-cache`, expõe a revisão do catálogo para detecção de
  atualização e nunca inclui IDs de versão na URL dos tiles.

## Vento: limites e ciclo de vida

| Recurso | Normal | Capacidade reduzida |
|---|---:|---:|
| Atlas RGBA, por campo | até 2048² / 16 MiB | até 1024² / 4 MiB |
| Textura do campo, por textura | até 16 MiB | até 4 MiB |
| Tiles decodificados LRU | 32 tiles / ~8 MiB | 32 tiles / ~8 MiB |
| Cache HTTP em disco | 32 MiB | 32 MiB |
| Cache HTTP RAM explícito iOS | 2 MiB | 2 MiB |
| Partículas, teto do core | 1.000 | 500 inicialmente |
| Partículas com density atual 0,75 | 750 | 375 inicialmente |
| Histórico | 75 posições por partícula | igual |

Tetos calculados com 1.000 partículas: estado ~1,2 MiB; linhas ~3,4 MiB;
mesh CPU ~10,2 MiB. Buffers de trails GPU: **máximo 3 slots Metal**, ~30,5 MiB
somados; **1 buffer OpenGL**, ~10,2 MiB. Reuso protegido por conclusão do
command buffer/fence, sem espera bloqueante e sem alocar um buffer por frame.
Se todos estiverem ocupados, pula o passe das partículas naquele frame.

Esses são limites por recurso, **não uma promessa de RSS total**. Campo ativo,
staging e referências de frames em andamento podem coexistir temporariamente;
o driver também possui allocations próprias. Atlas não é um cache ilimitado de
viewports: troca o campo/textura e libera o anterior; sair completamente de sua
cobertura descarta estado, trails e recursos associados. Context loss e remoção
da layer liberam/resetam os recursos nativos correspondentes.

Perfil reduzido: iOS com até 3 GiB de RAM ou Low Power Mode na criação; Android
low-RAM, até 3 GiB físicos ou heap class até 128 MiB. Inicia com metade da
densidade, teto de atlas 1024 e um nível de tiles abaixo (máximo z5).

Qualidade medida em janelas de 2 s: abaixo de 35 callbacks/s reduz densidade em
25%, até piso de 20%; abaixo de 70% de qualidade também reduz resolução. Só
recupera 10 pontos percentuais após cinco janelas acima de 55 callbacks/s. O
perfil fraco nunca ultrapassa 50%. Isso mede cadência do renderer, não GPU time.
Espessura, paleta, opacidade, movimento e aparência nominal foram preservados.

Background remove a layer, interrompe o clock e cancela requests; voltar recria
recursos sob demanda. iOS também responde a memory warning liberando o estado.
Inatividade temporária do iOS (Central de Controle para ligar/desligar a rede)
não remove o campo; somente background real executa a limpeza.

Atualização/reconexão: o campo visível permanece enquanto a próxima versão é
baixada. Uma atualização parcial não substitui um campo existente. Conteúdo
idêntico não recria textura. Na troca, Metal/OpenGL interpolam os vetores entre
as duas texturas por 400 ms; partículas usam a mesma interpolação sem reiniciar
os rastros. Ao terminar, campo/textura anterior são liberados. Há no máximo um
campo/textura anterior adicional por renderer durante a transição (até 16 MiB
de RGBA CPU + 16 MiB de textura, ou 4 + 4 MiB no perfil reduzido).

## Vento offline/desatualizado

`SnapshotStore` grava atomicamente até **quatro campos completos recentes** em
uma fila rotativa, cada um com catálogo, plan z/x/y, RGBA, timestamp, versão de
formato e checksum. Arquivos em Application Support no iOS (excluídos de backup)
/ noBackupFilesDir no Android. O catálogo MET válido mais recente também é
persistido separadamente para reconstruir URLs e tentar somente o cache HTTP
quando `available.json` estiver indisponível.

- Limite: 4 × ~16 MiB de campo + 64 KiB de catálogo por snapshot, ou
  aproximadamente 64 MiB de dados de vento persistentes, além de headers e
  arquivos temporários de gravação.
- Durante gravação atômica pode existir também `.tmp` do mesmo tamanho.
- Campo parcial, truncado, checksum inválido ou cobertura incompatível é rejeitado.
- Até quatro planos completos ficam disponíveis offline; não é download global.
- Ao ligar o vento naquela cobertura, restaura antes da tentativa de rede.
- `onDataStatus` expõe `{stale, savedAt}`. Restauração/fallback/falha é marcada
  stale; campo novo completo limpa stale. A UI exibe `Vento desatualizado`.
- Se a nova viewport não corresponder ao plan salvo, não inventa dados.
- Catálogo permanece atualizado aproximadamente a cada 60 s, HTTP timeout 5 s.

## Verificação

`pnpm test`, `pnpm typecheck`; testes C++ `WindCore.test.cpp` e
`WindResources.test.cpp` (incluem adaptação, recuperação, limites, restauração,
checksum/corrupção e preservação do último snapshot diante de resultado parcial).
O teste de hook usa relógio controlado e o hook real com AppState substituído.

Nginx real em container, opcional na suíte padrão:

```
TEST_NGINX_DOCKER=1 pnpm --filter @maris/api exec tsx --test test/nginx-tiles.test.ts
```

Builders nativos devem ser executados após alterações C++/Objective-C++/JNI.
Testes unitários não substituem medir FPS/RSS em aparelhos de baixo desempenho
nem validar um pack completo em modo avião; não reportar esses resultados sem
executá-los.
