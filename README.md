# Maris

Monorepo do aplicativo móvel Maris e de sua API administrativa.

## Estrutura

```text
apps/
  mobile/  React Native + Expo + MapLibre
  api/     NestJS + TypeScript
data/      arquivos ENC locais (ignorado pelo Git)
```

## Requisitos

- Node.js 20 ou superior
- pnpm 9
- Xcode para executar o app no iOS
- PostgreSQL
- GDAL/OGR e `unzip` para processar ENC localmente

## Instalação

```bash
pnpm install
```

## Mobile

```bash
pnpm dev:mobile
pnpm ios
```

O código do aplicativo está em `apps/mobile`. A fonte vetorial continua sendo
descoberta pelo TileJSON; o app não conhece versões nem caminhos de storage.

## API

A API segue a organização modular do NestJS: `AppModule`, módulos de
configuração e banco, e ingestões separadas em controller, DTOs e services.

Copie as variáveis de ambiente e inicie a API:

```bash
cp apps/api/.env.example apps/api/.env
set -a
source apps/api/.env
set +a
pnpm dev:api
```

### Receber um conjunto ENC

`POST /ingestions/enc` recebe um único campo multipart chamado `file`. A
ingestão roda apenas na API local (`ENC_PROCESSING_ENABLED=true`); a instância
da Railway rejeita uploads porque opera com o processamento desativado.

```bash
response=$(curl --fail-with-body --silent --show-error \
  -F 'file=@artifacts/FL_ENCs.zip;type=application/zip' \
  http://localhost:3001/ingestions/enc)
echo "$response" | jq .
```

Execute o comando na raiz do repositório. A resposta contém o `id` usado para
acompanhar o processamento:

```bash
ingestion_id=$(echo "$response" | jq -r .id)
curl --fail-with-body \
  "http://localhost:3001/ingestions/$ingestion_id"
```

A API transmite o upload diretamente para disco, calcula SHA-256, valida a
estrutura ZIP, bloqueia caminhos inseguros e arquivos criptografados, confere
os limites de expansão e identifica as células S-57 `.000` e seus updates.
O ZIP fica temporariamente em `.storage/ingestions/<id>` no Mac. Ele não é
enviado ao bucket e é apagado quando o job termina ou esgota suas tentativas.
Os metadados são persistidos no PostgreSQL.

O schema é controlado por entities e migrations do TypeORM. A API executa
somente migrations pendentes, registradas na tabela `migrations`; ela não usa
`synchronize` nem recria o schema no startup. Para inspecionar ou executar pelo
CLI:

```bash
pnpm --filter @maris/api migration:show
pnpm --filter @maris/api migration:run
pnpm --filter @maris/api migration:revert
```

Para consultar o estado e a rastreabilidade da ingestão:

```bash
curl --fail-with-body \
  http://localhost:3001/ingestions/<id>
```

Depois da resposta `received`, a própria API local inicia a ingestão diretamente,
sem BullMQ e sem fila no Redis. Apenas uma ingestão ENC roda por vez; um segundo
upload recebe `503` enquanto a primeira estiver em processamento. Jobs locais
interrompidos são retomados a partir do estado persistido no PostgreSQL quando a
API reinicia.
O executor roda dentro da API com uma ingestão por vez. Dentro dela,
`ENC_CELL_CONCURRENCY` (padrão `2`) limita a fila local de células: extração e
leitura de metadados das próximas células acontecem enquanto um único escritor
incorpora a anterior ao GeoPackage. O limite evita escritas SQLite concorrentes
e aplica backpressure sem usar Redis. O PostgreSQL guarda o estado necessário
para retomar uma ingestão interrompida quando a API local é iniciada novamente;
Redis não participa do processamento ENC.
Os estados persistidos são `received`, `validating`, `processing`, `ready`,
`failed` e `published`. O trabalho pesado roda em processos GDAL/gerador
separados do processo HTTP. Ingestões interrompidas são retomadas na próxima
inicialização da API.

Extrações e intermediários são apagados em `finally`; tiles incompletos também são
removidos pelo processo pai caso o gerador falhe. Antes de retomar o processamento,
a API limpa temporários órfãos. ZIPs originais não são retidos; versões publicadas
são preservadas no bucket.
`ENC_SHARD_CELL_COUNT` (padrão `100`) limita também o estado cartográfico: a API
mantém somente um lote de células e suas coberturas em memória. Ao completar o
lote, GDAL lê o GeoPackage como `GeoJSONSeq`, o filtro escolhe cada sondagem pela
cobertura ENC e outro processo GDAL gera MVT com backpressure. O MBTiles é
convertido sequencialmente para um PMTiles imutável, enviado ao bucket e apagado
localmente antes do lote seguinte. Portanto, RAM e disco temporário são
limitados pelo tamanho do lote, não pelo tamanho total do ZIP.

## Pipeline e tiles vetoriais

O fluxo cartográfico publica cada lote assim que ele termina:

```text
S-57 .000 + updates .001/.002
  -> GDAL/OGR (UPDATES=APPLY)
  -> lote limitado de células em GeoPackage
  -> GeoJSONSeq por streaming
  -> MVT/PBF em um PMTiles imutável por lote
  -> bucket + metadados/revisão no PostgreSQL
  -> composição dos lotes por leitura de ranges na API
  -> TileJSON do NestJS
  -> MapLibre Native
```

Não existe `FeatureCollection` intermediário. Cada lote publicado incrementa a
revisão global (`catalog-1`, `catalog-2`, ...), tornando a cobertura disponível
no app sem esperar o ZIP inteiro. Revisões antigas continuam imutáveis. Novas
ingestões acrescentam shards às anteriores; EUA, Brasil e outras regiões
coexistem. Quando shards se sobrepõem, a API compõe o tile e mantém somente a
célula de edição/update mais recente e de maior detalhe naquele ponto.

O storage de cartas, local ou no Railway Bucket, tem esta estrutura lógica:

```text
.storage/chart-data/
  soundg/
    versions/
      soundg-{ingestion-uuid}-00000/
        manifest.json
        tiles.pmtiles
      soundg-{ingestion-uuid}-00001/
        manifest.json
        tiles.pmtiles
```

O PostgreSQL é a fonte de verdade para os shards e revisões publicados. Publicar
um shard incrementa a revisão em uma transação, sem desativar regiões de
ingestões anteriores. Os arquivos anteriores ficam intactos para clientes
offline e para resolver URLs de revisões antigas. No modo S3, o Nginx encaminha
os tiles à API, que lê somente os ranges necessários dos PMTiles no bucket privado. O cache
compartilhado de índices e manifests é limitado a 64 entradas. Não há cache do
arquivo completo nem reconstrução de GeoJSON em runtime.

O NestJS consulta a revisão mais recente e os bounds dos shards para responder:

```text
GET /tiles/soundg.json
```

O TileJSON aponta para a URL estável `/tiles/soundg/{z}/{x}/{y}.pbf`. O app
envia somente as coordenadas do tile; a API resolve a revisão mais recente,
seleciona os shards e compõe a resposta. O campo `version` do TileJSON continua
indicando `catalog-{revision}` para que fontes e áreas offline detectem uma
atualização. URLs explícitas `/tiles/soundg/catalog-{revision}/{z}/{x}/{y}.pbf`
continuam disponíveis como snapshots imutáveis para downloads em andamento.
Tiles ausentes retornam 204; versões inexistentes continuam retornando erro
não cacheável. `CHART_ASSET_BASE_URL` vale apenas para versões legadas em PBFs
soltos; PMTiles usa a API atual. A interface `ChartStorage` isola o acesso local
e via bucket sem expor credenciais ao app.

O gerador usa um spool binário sequencial, um temporário interno do empacotador
e o arquivo final, não um arquivo por tile. A compactação gzip é sem perdas;
zoom e conteúdo MVT são preservados. A pasta é publicada por rename somente
após finalizar o arquivo e seu checksum SHA-256. Temporários são removidos
no término/falha e recuperados após reinício.
O índice de geração é percorrido em profundidade: cada ramo é liberado depois
da escrita, evitando acumular todos os tiles em RAM. O serving decodifica e
compõe apenas os PBFs dos shards que intersectam o tile solicitado.

Validação no Railway em 18/09/2026, com `FL_ENCs.zip`: 700 células,
320.363 sondagens e 323.060 tiles em um PMTiles de 92.403.866 bytes
(88,1 MiB). Pico medido do volume durante a geração: 969.515.008 bytes
(inclui dados preexistentes), sem esgotar inodes. Publicação confirmada com
700 células, 736 coberturas e 11.116 registros de levantamento no PostgreSQL;
temporários vazios após conclusão. As gravações ORM são divididas em lotes
de 500 por entidade, dentro da mesma transação, para respeitar o limite de
parâmetros do PostgreSQL. HTTP real: tile novo/antigo 200, vazio 204 e versão
inexistente 404 sem cache. O app mantém as mesmas URLs PBF; não recebe nem
baixa o arquivo PMTiles inteiro.

### Carta no centro do mapa

`GET /charts/at-point?lat=25.7&lon=-80.15` retorna uma única carta e seus
metadados usando o catálogo mais recente. O app envia somente latitude e
longitude; a API escolhe a revisão. O parâmetro opcional `version=catalog-N`
permanece disponível para diagnóstico e snapshots explícitos.
O centro é consultado no MapLibre ao abrir/mover o painel Chart information,
com debounce de 200 ms e cancelamento de respostas obsoletas.

`ChartSelection` é compartilhado pela geração dos tiles e pelo endpoint:
primeiro escolhe edição/atualização mais recente da mesma célula; entre células
que cobrem o ponto, prefere a menor escala de compilação (maior detalhe).
Empates usam data e nome da célula. Considera os polígonos reais `M_COVR`,
exclusões CATCOV=2 e buracos, não apenas bounds. Não há amostragem por zoom.
O gerador mantém cada SOUNDG somente onde sua célula é a selecionada.

O manifest registra `selectionPolicy: detailed-coverage-v1`. Versões legadas
continuam acessíveis por URL, mas o endpoint retorna 409 para elas porque
seus tiles misturam cartas; uma área offline antiga precisa ser atualizada
para exibir metadados de uma carta única. Fora de cobertura retorna 404;
coordenadas inválidas retornam 400. O painel não inventa dados ausentes.
Metadados do painel ainda exigem conexão; os tiles offline permanecem
independentes. A consulta carrega somente metadados/coberturas do snapshot
publicado, nunca o GeoJSON de sondagens nem o PMTiles inteiro.

Validado no Railway com `FL_ENCs.zip`, versão
`soundg-6cfac4ad-91bf-4e4d-8516-e1a9e009f59a`: 223.778 sondagens selecionadas,
306.717 tiles e PMTiles de 76.164.834 bytes. Em `25.7,-80.15`, o endpoint
retornou `US5MIABC`, edição 2, atualização 0, escala 1:22.000. O tile
`14/4544/6981` passou de 13 SOUNDG de `US4FL2AI` + 32 de `US5MIABC` para
somente os mesmos 32 de `US5MIABC`. Tile antigo e novo responderam 200;
consulta fora da cobertura 404, coordenada inválida 400 e versão legada 409.
Uma falha inicial de empacotamento Docker preservou a versão ativa; após
correção, a fila publicou a versão e limpou os temporários.

### Deploy automático da API

O serviço `api` do projeto Railway `maris`, ambiente `production`, acompanha
`andre-fig/maris`, branch `main`, via integração GitHub. Os watch paths estão
configurados diretamente no serviço: `/apps/api/**`, `/ops/**`, `/Dockerfile`,
`/.dockerignore`, `/railway.json`, `/package.json`, `/pnpm-lock.yaml`,
`/pnpm-workspace.yaml` e `/apps/mobile/package.json` (copiado pelo Dockerfile).
Mudanças somente no código/telas mobile ou no TODO não disparam deploy da API.
Os filtros não dependem do `railway.json`: a API atual do Railway rejeita
novas configurações desse arquivo legado em favor de Infrastructure as Code.

Para gerar/testar PMTiles localmente:

```bash
python3 -m venv .venv-pmtiles
.venv-pmtiles/bin/pip install pmtiles==3.8.1
export PMTILES_PYTHON="$PWD/.venv-pmtiles/bin/python"
```

O Docker já instala essa dependência. `PMTILES_PYTHON` seleciona o Python do
empacotador; por padrão usa `python3`.

O comando abaixo permanece disponível como ferramenta de diagnóstico para
gerar um artefato sem publicá-lo. O fluxo normal não depende dele:

```bash
pnpm --filter @maris/api build:tiles -- \
  --input /caminho/soundg.json \
  --storage-dir ../../.storage/chart-data \
  --version miami-soundg-v3
```

No mobile, a `VectorSource` do MapLibre administra seleção `z/x/y`, requisições
concorrentes, cancelamento, deduplicação e cache ambiente. A mesma fonte poderá
ser usada futuramente por pacotes offline e prefetch de rotas.

### Persistência e rastreabilidade

As tabelas `chart_datasets`, `chart_ingestions` e `chart_versions` registram o
dataset, nome e SHA-256 do ZIP de origem, células e updates, edição lida do DSID,
estado, bounds, chaves do manifesto e PMTiles, timestamps, erro e versão ativa.
O ZIP não é retido. Metadados e publicação ficam no PostgreSQL; `manifest.json`
e `tiles.pmtiles` ficam no Railway Bucket.

### Partes provisórias

- o processamento roda localmente e depende do Mac permanecer ativo até o fim;
- o executor ENC roda diretamente na API local, enquanto PostgreSQL e bucket
  são de produção;
- a API da Railway é somente leitora das ENCs publicadas no bucket;
- a política de retenção ainda não foi implementada; por isso nenhuma versão
  antiga é removida automaticamente.

## Verificação

```bash
pnpm typecheck
pnpm test
pnpm build
```
