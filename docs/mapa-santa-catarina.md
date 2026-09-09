# Mapa de Santa Catarina no painel

O painel mostra os cliques por município de SC. Duas coisas sustentam isso: a **malha** (o desenho)
e a **fonte dos números**.

## A fonte: Google Ads, não o CRM

O mapa anterior (grid dos 27 estados) lia `leads.city` do CRM — campo digitado à mão na ficha do
lead. Em 09/09/2026 estava preenchido em **1 de 54 leads**. Um mapa alimentado por ele fica vazio
por construção, independente do desenho.

A fonte agora é `geographic_view` do Google Ads → tabela `geo_stats`. Vem preenchida sozinha, todo
dia, sem depender de ninguém digitar. A contrapartida honesta: mede **onde o clique pago aconteceu**,
não onde o cliente mora. Para um negócio local com raio de atendimento curto, as duas coisas quase
coincidem — mas não são a mesma.

> O campo `city`/`uf` do CRM continua existindo na ficha. Se um dia a equipe passar a preencher,
> vale cruzar as duas visões: divergência entre "de onde vem o clique" e "de onde é a obra" é
> informação, não erro.

## A malha: `dashboard/sc-map.json`

Arquivo estático, gerado uma vez, servido em cache. **Não é embutido no HTML** — 53 KB de path SVG
tornariam o `index.html` ilegível, e a malha nunca muda.

Formato: `{ w, h, mun: { "<cod IBGE>": { n: "<nome>", d: "<path SVG>", c: [cx,cy] } } }`

Como foi gerado:
1. Malha do IBGE — `https://servicodados.ibge.gov.br/api/v3/malhas/estados/42?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=intermediaria`
2. Nomes — `https://servicodados.ibge.gov.br/api/v1/localidades/estados/42/municipios` (casados por `codarea`)
3. Projeção equirretangular com correção de longitude pelo cosseno da latitude média. Para um estado
   deste tamanho a distorção é irrelevante e evita carregar uma biblioteca de projeção.
4. Simplificação Douglas-Peucker: **19.200 → 5.041 pontos** (viewBox 600×420, tolerância 1,3).
   Coordenadas arredondadas para inteiro.

Para regerar (outro estado, ou mais/menos detalhe), o script está no histórico desta conversa; o que
importa reter são os parâmetros: `W=600`, `TOL=1.3`, arredondamento inteiro → ~52 KB. Aumentar `TOL`
reduz o arquivo e come a silhueta; reduzir engorda rápido (`TOL=0.7` já dá 69 KB).

**Conferência de sanidade após regerar** — os centroides têm que bater com a geografia real
(x cresce para leste, y cresce para sul):

| Município | x | y | esperado |
|---|---|---|---|
| São Miguel do Oeste | 36 | 95 | extremo oeste |
| Chapecó | 130 | 145 | oeste |
| Lages | 383 | 255 | centro |
| Criciúma | 488 | 341 | sul |
| Joinville | 535 | 36 | extremo norte |
| Itajaí | 557 | 125 | litoral norte |
| Florianópolis | 584 | 201 | litoral centro |

## Casamento de nomes

O Google escreve sem acento (`Itajai`, `Balneario Camboriu`); o IBGE usa o nome oficial. O painel
normaliza os dois lados (remove acento, minúscula, tira não-alfanumérico) e casa. O que a
normalização não resolve vai no `CIDADE_ALIAS` do `dashboard/index.html` — hoje só
`picarras → balneariopicarras`, porque o Google tem os dois geo targets ("Picarras" e "Balneario
Picarras") para o mesmo município.

**Cidade que não casa não some.** Aparece listada abaixo do mapa, em "Fora do mapa". É assim que se
vê vazamento de segmentação: em 09/09 apareceram Belo Horizonte, São Paulo, Teresópolis e Foz do
Iguaçu — R$ 8,67 e 3 cliques em julho, o espalhamento normal de "presença ou interesse" do Google.
Se essa linha crescer, é sinal de conferir a segmentação geográfica das campanhas.

## Agregação por nome, não por id

`geo_stats` guarda `city_id` (o geo target do Google) porque é a chave única por dia. Mas o Google
tem **mais de um geo target para o mesmo município** — um da cidade e outro da região dentro dela
(`Itajai` = 1001708 e 9197194). O `/api/report` agrupa por `city_name` justamente por isso: no mapa
os dois têm que virar o mesmo polígono, senão o município pisca com metade do número.
