# Asteris — README de contexto e handoff

> Documento para quem vai continuar este projeto (humano ou outra IA).
> Objetivo: entender **tudo** sem falar com quem construiu — o negócio, o sistema,
> a arquitetura, as decisões, o que foi descartado e porquê, o que falta, e onde parámos.
> Última atualização: **2026-09-11**.

---

## 0. TL;DR

- **Asteris** = estúdio de conteúdo comercial (foto + vídeo + marketing) em Portugal. Dono: **Brener** (pt-PT), sócio: **Gustavo** (vendas).
- Este repo é o **site + portal de clientes + painel de admin**, tudo estático + Cloudflare Pages Functions.
- **Live:** https://asteris.pt (e `www.asteris.pt`). Hospedado em **Cloudflare Pages**, deploy automático a cada `git push` em `main`.
- Repo GitHub: **`Asteris-Media/Asteris-Media-Website`** (público).
- Partes: `index.html` (landing) · `404.html` (portal do cliente, router por código) · `acesso.html` (hub de entrada) · `admin/` (SPA de gestão) · `functions/` (API + KV + R2 + Cloudinary).
- **Base de dados:** Cloudflare KV (`ASTERIS_KV`). **Armazenamento:** Cloudflare R2 (`asteris-media`, entregas) + Cloudinary (`bv9q81il`, portfólio/seleção).
- Onde parámos: R2 acabou de ser ligado; Cloudinary acabou de receber as chaves; a **biblioteca de media** no admin está construída e a ser afinada. Ver secção 12.

---

## 1. O negócio

**Asteris — Commercial Content Studio.** Não é "agência de social" nem "fotógrafo freelance": posiciona-se como estúdio que trabalha **posicionamento + estratégia + produção audiovisual** para marcas, produtos e profissionais.

- **Fase 1 (0–60 dias):** trabalhos avulsos para caixa rápida (imobiliária/AL, produto e-commerce, arquitetura).
- **Fase 2 (mês 3+):** retainers de conteúdo (restaurantes médio porte, clínicas de estética/dentárias, stands de automóveis multi-marca).
- **Fora:** casamentos como negócio principal, marcas grandes, startups tech, barbearias, stands de usados.
- Concorrente de referência: **Victor / VTR** (audiovisual + marketing solo, ~€3–3,5k/mês, cliente-âncora CN Auto). A Asteris ganha com produção premium (Sony, imagem cuidada) vs. o "parece telemóvel" dele.
- Lead quente registada: **Mudanças Everton** (mudancaseverton.pt) — o Gustavo conhece o dono.
- Vendas: **sempre presencial** (iPad + deck + mockup + provas). Perderam a "Black Diamond" por videochamada.

Material de estratégia/pricing/prospecção está em `Documents/Projetos/Asteris/` (fora deste repo): `00_ANALISE_CRITICA.md`, `01_RESUMO_PARA_REUNIAO.md`, `02_INTEL_REUNIAO_2026-09-08.md`, pasta `planeamento/`, e os DOCS navegáveis em `Documents/Projetos/Asteris/DOCS/` (playbook, motor de preços, etc. — HTML autónomo, tirados de artifacts do Claude a pedido do Brener).

---

## 2. Arquitetura

```
                          asteris.pt  (Cloudflare Pages: projeto "asteris-media-website")
                                │
       ┌────────────────────────┼─────────────────────────────┬───────────────────┐
       │                        │                             │                   │
  /  (index.html)         /acesso (acesso.html)        /<CÓDIGO>            /admin/ (SPA)
  landing                 hub: escolher tipo           404.html renderiza   login + gestão
                          + inserir código             a página do cliente
                                                        (lê /data/<CÓDIGO>.json)
                                │
                     ┌──────────┴───────────────────────────────────────┐
                     │  Cloudflare Pages Functions  (pasta functions/)   │
                     │                                                    │
                     │  functions/data/[[path]].js                        │
                     │    GET /data/<CÓDIGO>.json  → KV (page:<CÓDIGO>)   │
                     │                                fallback: ficheiro  │
                     │                                estático /data/*    │
                     │                                                    │
                     │  functions/api/[[path]].js  (tudo o resto)         │
                     │    auth (cookie assinado HMAC)                      │
                     │    /api/pages       CRUD de páginas em KV           │
                     │    /api/stats       painel de quotas                │
                     │    /api/media*      biblioteca (R2 + Cloudinary)    │
                     │    /api/upload      upload roteado (R2 | Cloudinary)│
                     │    /api/r2/<key>    servir ficheiro do R2 (PÚBLICO) │
                     └────────────────────────────────────────────────────┘
                                │                    │                 │
                          Cloudflare KV        Cloudflare R2        Cloudinary
                          (asteris-portal)     (asteris-media)      (bv9q81il)
                          binding ASTERIS_KV   binding ASTERIS_R2   3 env vars
                          páginas + índice     ENTREGAS ao cliente  PORTFÓLIO + SELEÇÃO
                          + mediatags          (downloads grátis)   (otimização auto)
```

**Regras `_routes.json`:** `{ "include": ["/api/*", "/data/*"] }` — só estas correm como Function; tudo o resto é estático (incluindo `/admin/` e o fallback `404.html` para rotas não encontradas como `/PRP6H1`).

**Sem build.** HTML + CSS + JS puro. Zero framework, zero bundler, zero dependências npm em produção. Bibliotecas externas carregam de CDN quando precisas (só o JSZip, lazy, no portal e no admin).

---

## 3. Estrutura de ficheiros

| Caminho | O que é |
|---|---|
| `index.html` | **Landing.** Single-file (~50 KB). Hero (vídeo de fundo), secção de posicionamento, carrossel de clientes (17 vídeos), cards antes/depois com contadores, contacto (Formspree + WhatsApp), footer. Serif Cormorant Garamond + Montserrat, dark + dourado `#C9A166`. |
| `404.html` | **Portal do cliente** (~47 KB). É o *router*: o Pages serve-o para qualquer rota não encontrada, ele lê o código do URL e renderiza. 3 modos: **galeria** (entrega/portfólio), **triagem** (seleção), **proposta**. |
| `acesso.html` | Hub `asteris.pt/acesso` — 4 botões (Seleção/Entrega/Portfólio/Proposta) → campo de código → `location.href = "/" + código`. |
| `exemplos.html` | `asteris.pt/exemplos` — "código mestre": links diretos aos exemplos, para testar sem trocar de código. **Temporário, apagar quando não precisar.** |
| `admin/index.html` | **SPA do admin** (~1 ficheiro, ~1500 linhas). Login por password, painel de quotas, 4 colunas de links por categoria, biblioteca de media, editor de páginas (galeria/triagem/portfólio/proposta com secções flexíveis). |
| `functions/data/[[path]].js` | Serve `/data/<CÓDIGO>.json` do KV, com fallback para o ficheiro estático (para os exemplos). |
| `functions/api/[[path]].js` | Toda a API do admin + upload + biblioteca + servir R2. ~450 linhas. |
| `data/*.json` | Uma página de exemplo por ficheiro (códigos de teste). Em produção as páginas reais vivem no **KV**, não aqui. |
| `data/COMO-CRIAR.md` | Guia do formato JSON de uma página. |
| `_routes.json` | Diz ao Pages que rotas são Function. |
| `CNAME` | `asteris.pt` (legado do GitHub Pages; inofensivo no Cloudflare). |
| `.nojekyll` | Legado do GitHub Pages. |
| `vercel.json` | Legado — Vercel foi abandonado. Pode apagar-se. |
| `assets/hero/` | `multidrop-launch.mp4` (vídeo de fundo do hero, 1280×720, 2 MB) · `estatua.jpg` (imagem antiga da hero, agora só fallback). |
| `assets/clientes/` | 17 clips `.mp4` do carrossel (vertical 506×900, ~0.5–1 MB cada, ~13 MB total). Comprimidos localmente com ffmpeg. |
| `assets/cards/` | 8 imagens antes/depois dos 4 casos da landing (screenshots de feeds Instagram, transcodadas para JPG). |
| `assets/logos/` | `asteris.png` = logótipo real da Asteris (marca "A" abstrata, tan sobre transparente). SVGs `orfeu.svg` etc. são MOCKS de clientes, não usados. |

---

## 4. Landing (`index.html`)

- **Header:** logótipo real (`assets/logos/asteris.png`) + "ASTERIS" + "Conteúdo & Marketing" (dourado). Botão "ACESSO" no canto superior direito → `/acesso`.
- **Hero:** vídeo de fundo `assets/hero/multidrop-launch.mp4` (autoplay muted loop, dessaturado + escurecido, gradiente da esquerda). Título em 2 linhas + 3 parágrafos de posicionamento + botão WhatsApp "Solicitar análise" (com brilho a passar).
- **Secção 2 (`.sec-work`):** fundo claro (gradiente bege/cinza/branco — as screenshots brancas ficavam estranhas em preto). Bloco de texto de posicionamento (largura 1120px, pergunta em serif + parágrafos + frase-âncora a bold + fecho em dourado). Depois **4 cards antes/depois** de casos reais (StandMarte, Casa Fácil, Click Momentos, Sorriso Perfeito) com 3 notas 👎 (antes, cinza) e 👍 (depois, dourado com glow) por lado + métricas "antes → depois" com contador animado ao scroll. **No mobile os cards viram carrossel horizontal com scroll-snap.**
- **Carrossel de clientes (`.clientes`):** faixa infinita de painéis inclinados (`skewX -14deg`), cada um com vídeo de fundo + nome do cliente em serif (ou logótipo, se `CLIENTS[i][3]` tiver um caminho). Loop JS modular (não CSS marquee), 3 cópias, só toca os vídeos visíveis (IntersectionObserver). Pausa: rato por cima OU dedo pousado (mobile). Ao passar o rato: zoom lento do fundo (11s) + abertura lenta do tracking do nome (11s) = efeito parallax. Separadores dourados inclinados (`border-right`). **Clicar num painel abre a galeria do cliente** (overlay full-screen, grelha centrada, cabeçalho usa o próprio vídeo da galeria como fundo, player custom sem controlos nativos — só play/pause da Asteris).
  - Dados: array `CLIENTS` no `<script>` (`["Nome", "slug", "keyword-cloudinary", "logo-opcional"]`). Os 17 slugs mapeiam para `assets/clientes/<slug>.mp4`.
  - Para adicionar clientes: comprimir os masters localmente com ffmpeg (`crop=ih*9/16:ih,scale=506:900`, 25fps, 12s, `-an`, crf 30) → `assets/clientes/` → juntar linha ao `CLIENTS`.
- **Contacto:** form Formspree (id `maeylznr` → `asteris.media@hotmail.com`) + botão WhatsApp. Frase "Toda marca tem algo a dizer…" entre o título e o botão.
- **Footer:** logótipo + "Asteris" + © + ✦. Padronizado em todas as sub-páginas.

Casos antes/depois: as métricas e as notas são **credíveis mas ilustrativas** (não são clientes reais da Asteris). Escritas a partir da análise das 8 screenshots.

---

## 5. Portal do cliente (`404.html`)

`asteris.pt/<CÓDIGO>` → o `404.html` lê `/data/<CÓDIGO>.json` (via a Function `functions/data/`, que tenta KV `page:<CÓDIGO>` e cai no ficheiro estático). O campo `type` decide o que renderiza:

| `type` | Renderiza | Notas |
|---|---|---|
| `galeria` | Grelha de entrega (tiles 4:5 uniformes, botão Selecionar/Remover por baixo). Se `selecao !== false`, o cliente marca peças e há barra inferior "Selecionar tudo / Descarregar". `anon: true` esconde o nome do cliente. | Download: 1 peça = direto; várias = `.zip` via JSZip (resiliente — peça que falha é ignorada). |
| `triagem` | Seleção de material. Cliente marca as peças que quer → "Enviar" → lista vai por Formspree (`d.formspree`) ou mailto. Cabeçalho = colagem das próprias fotos com layer escura. **Sem mínimo obrigatório** (livre). | "Ver selecionadas" escurece as não escolhidas (não esconde). |
| `portfolio` | Igual a `galeria` mas sem seleção. Sempre com `anon: true` na prática. | |
| `proposta` | Página-modelo que parece feita à medida. Estrutura FLEXÍVEL: `d.proposta.secoes[]`, cada uma `{tipo: "texto"|"galeria"|"cards", ...}`. Converte formato antigo via `legacyToSecoes()`. Cards = planos (título, ícone de ~55 SVG, preço, linhas, cor `--acc`, destaque). Galeria = colagem ou coverflow. "Válida por X" = chip no topo. | Fecho = mensagem de agradecimento/parceria (não "Falar connosco"). |

- Player de vídeo (lightbox e galeria): **sem controlos nativos** — sem som/barra/tempo/fullscreen/PiP/menu 3-pontos. Só um botão redondo play↔pause da Asteris ao centro. Menu do botão direito e arrastar bloqueados. Aviso "Conteúdo protegido".
- Rodapé em todas as sub-páginas (marca Asteris + ano + ✦, **sem nome de cliente**). Barra de ações = `position:sticky` (fica acima do rodapé, não fixa a tapar).
- Segurança = **códigos longos aleatórios** (obscuridade). Não há login do cliente.
- Formato JSON: ver `data/COMO-CRIAR.md` e os exemplos.

**Códigos de teste** (servidos dos ficheiros estáticos `data/`):

| Código | Tipo | Cliente |
|---|---|---|
| `SEL8M2` | triagem | Brendha & Pedro |
| `ENT4K7` | galeria (entrega) | Mudanças Everton |
| `PTF9C3` | galeria anónima (portfólio) | — |
| `PRP6H1` | proposta (formato legado) | Restaurante Fasano |
| `PROPX2` | proposta (formato novo `secoes[]`) | Restaurante Fasano |
| `DEMO7K` `TRIAGEM3` `PROPOSTA9` `PF2K9X` | variantes antigas | — |

`asteris.pt/PRP6H1?icons=1` abre a galeria dos ~55 ícones de planos.

---

## 6. Admin (`admin/index.html`)

`asteris.pt/admin` — SPA de gestão. **Não tem build.** Toda a lógica num `<script>`.

### Login (multi-utilizador)
Password → `POST /api/login` → cookie assinado `as_sess` (HMAC-SHA256 com `SESSION_SECRET`, payload inclui `u: <nome>`, validade 14 dias). Campo com olho para ver a password. O nome do utilizador aparece no topo do admin.

- **`ADMIN_PW`** (Text) = password partilhada; o utilizador chama-se **"Admin"**. Atual: `Administrador.10`.
- **`ADMIN_USERS`** (Secret, opcional) = várias contas nomeadas, formato **`Nome:senha,Nome:senha`** (nome:senha, separados por vírgula). Ex.: `Brener:xxxxx,Gustavo:yyyyy`. O nome é o que aparece no **registo de atividade**.
- A password identifica o utilizador (não há campo de "utilizador"). Trocar/adicionar = editar a variável no Cloudflare Pages + **redeploy**.

### Registo de atividade (Logs)
Cada ação de escrita fica registada em KV (`activitylog`, array, últimas 400). Ver no **rodapé do admin → "Logs"** (data/hora · quem · ação). Regista: entrar/sair, guardar/apagar página, apagar ficheiro(s)/pasta da biblioteca, tag de pasta, upload de pasta. Rotas: `GET /api/log` (ler) · `POST /api/log {action,detail}` (o admin usa para registar o upload de pasta).

### Painel (aba "Links")
- **"Estado & quotas"** no topo: 4 cartões —
  - **R2 · Entregas** — barra `X GB / 10 GB` (ou "não ligado")
  - **Cloudinary · Portfólio + Seleção** — `créditos usados / 25` (lê o uso real via `api.cloudinary.com/.../usage`)
  - **Links ativos** — total + barra segmentada por tipo
  - **A expirar** — nº + lista de quais/quando
  - Faixa de sistema por baixo: base de dados, API, R2, Cloudinary, nº de registos KV, hora.
- **4 colunas** por categoria: Proposta · Portfólio · Entrega de trabalho · Seleção de material. Cabeçalho de cada coluna = **barra dourada sticky** com nome centrado + contador.
- **Cards de link** (vidro escuro): código (mono dourado) · nome · título · chip de prazo. Botão **⋮** → menu do site: Abrir link · **Copiar link** (copia `asteris.pt/CÓDIGO`) · Editar · Estender +30/+90 dias · Definir data · Tornar permanente · **Excluir** (com confirmação em modal do site — nunca `confirm()` do browser).

### Aba "Biblioteca"
- **2 sub-abas**: `R2 · Entregas` e `Cloudinary · Portfólio + Seleção`.
- **Drop zone** no topo: arrastar ficheiros / escolher pasta / escolher ficheiros → modal pergunta nome da pasta + tipo (Entrega/Seleção/Portfólio) → sobe tudo para a nuvem certa (Entrega → R2, resto → Cloudinary). Pasta na nuvem = `<tipo>/<slug>`.
- **Cards de pasta**: capa (1ª foto), nome, contagem/tamanho, badge de **tag**, botão ⋮ (Abrir pasta · **Definir tag** · Copiar link de download · Usar numa página nova · Apagar pasta).
- **Duplo clique** no card abre o **visualizador de pasta** (modal): cabeçalho com título + separador, grelha de miniaturas, **seleção por clicar-e-arrastar** ou clicar tile a tile, **Selecionar tudo / Limpar / Ver só selecionadas / Excluir N / Descarregar N (.zip)**. Cada ficheiro tem **↓ download individual** e **🗑 apagar** ao passar o rato.
- **Tags de pasta** guardadas em KV (`mediatags` = `{ "<pasta>": "entrega"|"selecao"|"portfolio"|"outro" }`). `PUT /api/media/tag`. Se não houver tag explícita, deriva do nome da pasta.
- **"Copiar link de download"** → `asteris.pt/api/media/view?f=<pasta>&c=<nuvem>` — página pública (obscura) que mostra a pasta com miniaturas + download individual + "Descarregar tudo (.zip)". Se abrir vazia, mostra um diagnóstico do porquê.

### "Nova página" (modal, botão "+ Nova página")
Pop-up com X: escolher tipo (4 cartões) · Cliente · Título · Prazo (Permanente ou data, com sugestão automática: 15 dias proposta, 30 dias resto) · Anónima (portfólio/entrega) · **"+ Usar pasta da biblioteca"** (preenche os `itens` a partir da pasta) · Código gerado ("gerar outro"). → cria via `PUT /api/pages/:code` → abre o editor de conteúdo.

### Editor de conteúdo (`editView` / `buildEditor`)
- **Base:** código, tipo, cliente, título, expira, anónima, intro.
- **Galeria/triagem/portfólio:** lista de imagens (`imageList` widget) — colar links (textarea, ignora linhas em branco) + arrastar ficheiros → `/api/upload`.
- **Proposta:** editor de **secções flexíveis** — "Adicionar secção" → texto / galeria (colagem|carrossel) / cards (grelha|carrossel). Cada card de plano edita título, ordem, nº, cores, ícone (`<select>` de ~55), destaque, flag "Recomendado".
- Savebar fixa em baixo: pré-visualizar · apagar (modal) · Guardar → `PUT /api/pages/:code`.

---

## 7. API (`functions/api/[[path]].js`)

Todas as rotas sob `/api/`. Autenticação por cookie `as_sess` **exceto** onde marcado PÚBLICO.

| Rota | Método | O que faz |
|---|---|---|
| `/api/login` | POST | `{pw}` → verifica `ADMIN_PW` → set-cookie `as_sess` |
| `/api/logout` | POST | limpa o cookie |
| `/api/me` | GET | `{ok: <autenticado>}` |
| `/api/r2/<key>` | GET | **PÚBLICO** — serve o ficheiro do R2. `?dl=nome` força download. CORS `*`. Está *antes* do gate de auth (o cliente descarrega sem login; segurança = key longa aleatória). |
| `/api/media/view` | GET | **PÚBLICO** — HTML da pasta (miniaturas + zip). `?f=<pasta>&c=r2\|cloudinary`. |
| `/api/stats` | GET | painel: contagem de páginas por tipo, expirados, a expirar ≤14d, uso R2 (bytes/objetos), uso Cloudinary (créditos via `/usage`). |
| `/api/pages` | GET | índice (array de `{code,type,cliente,titulo,expira,anon,atualizado}`) |
| `/api/pages/:code` | GET / PUT / DELETE | CRUD. PUT grava `page:<CODE>` no KV + faz upsert no `index`. |
| `/api/media` | GET | biblioteca: pastas + ficheiros das 2 nuvens, com `tag` por pasta. R2 agrupa por prefixo; Cloudinary por `asset_folder`/`folder` via `resources/image` + `resources/video`. |
| `/api/media/tag` | PUT | `{folder, tag}` → grava no KV `mediatags` |
| `/api/media/files` | DELETE | `{cloud, keys:[...]}` (R2) ou `{cloud, publicIds:[{publicId,resourceType}]}` (Cloudinary) |
| `/api/media/r2-folder/<path>` | DELETE | apaga uma pasta inteira do R2 |
| `/api/upload` | POST | multipart `file` + `folder` + `dest` (`"r2"`\|`"cloudinary"`\|vazio=auto). Roteia. **Limite de body ~100 MB** (limitação do Workers) — masters grandes não passam aqui. |

`functions/data/[[path]].js`: `GET /data/<CODE>.json` → `env.ASTERIS_KV.get("page:"+CODE)` → se não existe, `env.ASSETS.fetch(request)` (ficheiro estático).

Cripto: Web Crypto. `makeToken`/`checkToken` = `b64url(payload).b64url(HMAC-SHA256)`. Cloudinary assina uploads com SHA-1 hex.

---

## 8. Armazenamento — a decisão

**Duas nuvens, cada uma com um papel:**

| | **Cloudflare R2** | **Cloudinary** |
|---|---|---|
| Papel | **Entregas ao cliente** | **Portfólio + Seleção + Proposta** |
| Porquê | downloads **grátis e ilimitados** (o cliente descarrega pacotes de vários GB sem custo); ficheiros grandes; privado; auto-delete por regra de ciclo de vida | otimiza foto/vídeo automaticamente (miniaturas, versões web, poster); 25 GB grátis; **sem cartão** |
| O que dói na outra | Cloudinary: plano grátis é **um saco de ~25 créditos/mês** partilhado entre storage + transformações + **largura de banda**; downloads de entregas grandes furam o plano num instante. Limite ~100 MB por vídeo. | R2: não otimiza nada; pede cartão no ficheiro (já foi posto). |

- `/api/upload` recebe `dest` e o admin decide: `type === "galeria"` não-anon → `"r2"`; resto → `"cloudinary"`.
- **Auto-delete:** R2 = regra de ciclo de vida (POR CONFIGURAR no dashboard). Cloudinary = URL com `expires_at` + um cron de limpeza (POR FAZER). Nenhum dos dois está montado ainda.
- **Storj** foi avaliado e **descartado** (trial 30 dias + mínimo $5/mês depois — não é grátis permanente). Backblaze B2 mencionado como alternativa sem cartão mas sem integração nativa com Pages.

### 8.1 FFmpegLab (storage extra) — avaliado, integrado, **PAUSADO** (2026-09-11)

O R2 grátis é só 10GB e o Brener achou pouco. Fomos atrás de alternativas grátis >25GB
(ver histórico de conversa) — quase tudo era trial de 30 dias, pedia cartão, ou tinha
menos espaço. A única que bateu a barra foi **FFmpegLab** (`ffmpeglab.com`), um "IDE de
engenharia de media" open source, com um plano Starter **grátis pra sempre: 50GB, "Full
S3-compatible API", zero custo de egress, sem cartão**.

**Foi construída uma integração completa (SigV4 assinado à mão, sem SDK — o runtime das
Pages Functions não tem npm) e depois teve de ser posta em pausa porque a promessa "Full
S3-compatible API" não se confirmou na prática.** Fica tudo registado aqui para quem
retomar (humano ou IA) não repetir o mesmo caminho.

**O que foi testado, em ordem:**

1. Conta grátis criada no `sia.storage` (nome parecido, **serviço diferente** — rede de
   armazenamento descentralizada Sia) foi avaliada primeiro e **descartada**: dá 50GB mas
   é um cofre pessoal por-app (o SDK encripta no dispositivo do próprio utilizador), sem
   chave de API de servidor — não serve para um backend guardar/servir ficheiros de
   clientes. O caminho real de API deles (**S3d**, do SiaFoundation) exige correr
   infraestrutura própria ligada à rede Sia, não é a conta grátis de 50GB.
2. **FFmpegLab**: a conta grátis **não dá um par de chaves S3 fixo para configurar à
   mão** — dá uma **API key única** (Settings → API Keys → Create new API key). A partir
   dela, `GET https://api.ffmpeglab.com/files/s3config` (header `Authorization: Bearer
   <key>`) devolve credenciais S3 **temporárias** (estilo STS, com `sessionToken`):
   ```json
   { "bucketId":"prod", "region":"stub", "endpoint":"...", "userId":"<uuid>",
     "credentials": { "accessKeyId":"...", "secretAccessKey":"...", "sessionToken":"..." } }
   ```
3. Implementada assinatura AWS SigV4 completa (header-auth e presigned-URL por query
   string), validada estrutura por estrutura contra a documentação oficial da AWS
   (`docs.aws.amazon.com/IAM/.../create-signed-request.html`) — a matemática está
   correta. Implementado também envio **direto do navegador para o bucket** (URL
   pré-assinada, para não bater no limite de tamanho de pedido das Pages Functions em
   ficheiros grandes).
4. **Testado ao vivo com a chave real do Brener e falhou:** `ListObjectsV2` devolve
   `403 AccessDenied`, e **`PutObject` também devolve `403 AccessDenied`** — mesmo depois
   de prefixar a chave com o `userId` (hipótese de bucket partilhado multi-inquilino
   isolado por prefixo, testada e não resolveu; o erro veio explicitamente no recurso
   `prod/<userId>/...`). Ou seja: **as credenciais "S3-compatíveis" que a conta devolve
   não autorizam escrever nem listar diretamente no bucket**, apesar do marketing.
5. Investigada a Swagger UI pública deles (`https://api.ffmpeglab.com/api`) para achar o
   caminho real. A API que **de facto funciona** (a mesma que a própria interface deles
   usa) é outra, autenticada com a mesma `Bearer <API key>`, **sem SigV4**:
   - `POST /files/upload` — multipart/form-data, campo `file` — devolve `{ "link": "<url>" }`
   - `GET /files/list` — devolve `FileObject[]` = `{ Key, LastModified, ETag, Size }`
   - `GET /files/file/{id}` — um ficheiro específico
   - **Não existe nenhuma rota de apagar ficheiro na API deles.** Procurado à exaustão na
     Swagger, não está lá.

**Por que ficou em pausa em vez de reescrito na hora:** a API real resolve upload/lista,
mas (a) não tem delete, o que mata a funcionalidade de "apagar pasta"/"apagar sozinho
depois de X dias" que o Brener pediu; (b) não tem conceito de pasta, é uma lista plana
por conta; (c) o envio ainda teria de passar por um servidor — nosso (Function, mesmo
limite de tamanho de pedido que motivou tudo isto) ou deles diretamente do navegador (o
que expõe a `FFMPEGLAB_API_KEY` no código do lado do cliente, aceitável talvez para uma
equipa de 2 pessoas mas é uma troca que o Brener tem de decidir, não uma IA sozinha). O
Brener pediu para pausar e decidir depois.

**Estado do código (tudo ficou no repo, desligado, não apagado):**
- `functions/api/[[path]].js`: toda a maquinaria SigV4 (`s3Sign`, `s3PresignUrl`,
  `s3Query`, `s3Put`, `s3Get`, `s3Delete`, `s3List`, `s3Conf`, `s3FullKey`,
  `s3StripPrefix`) mais as rotas `/api/upload-url`, `/api/ffmpeglab/<key>` (GET pública,
  serve ficheiro), `/api/ffmpeglab-check` (GET pública, diagnóstico — ver abaixo), o ramo
  `ffmpeglab` em `/api/media` (listar), `/api/media/ffmpeglab-folder` (apagar pasta),
  `/api/limpezas*` (agendar/varrer apagar automático — cobre R2 e FFmpegLab). **Nada
  disto foi apagado**, mas como o `s3List`/`s3Put` batem sempre em 403 contra a API
  atual, estas rotas não devem ser chamadas até haver uma reescrita.
- `admin/index.html`: `var FFMPEGLAB_ATIVO = false;` — a **chave mestra da pausa**. Com
  isto a `false`: `destForEntrega()` devolve sempre `"r2"` (nunca escolhe FFmpegLab), o
  separador "FFmpegLab · Entregas grandes" não aparece na Biblioteca, e o card
  correspondente não aparece no Painel. Mudar para `true` volta a ligar tudo — mas **não
  vale a pena até a integração ser reescrita para usar `/files/upload` + `/files/list`
  em vez de SigV4/S3 direto.**
- **Diagnóstico já pronto para a próxima tentativa:** `GET /api/ffmpeglab-check`
  (pública, sem login, não expõe segredos) testa: se a `FFMPEGLAB_API_KEY` está definida,
  se o `s3config` responde, e faz um `list`+`put`+`get`+`delete` de teste reais contra o
  bucket, devolvendo o motivo exato de cada falha. Correr isto primeiro em qualquer
  retoma, antes de mexer em código.
- Variável **`FFMPEGLAB_API_KEY`** já está posta no Cloudflare Pages (Secret) — pode
  ficar lá, não faz mal nenhum enquanto `FFMPEGLAB_ATIVO` for `false` (só é lida quando
  as rotas acima são chamadas).

**Se algum dia se retomar isto, o caminho certo é:**
1. Reescrever `s3Put`/`s3List`/`s3Get`/`s3Delete` para chamar `POST /files/upload` e
   `GET /files/list` com `Authorization: Bearer FFMPEGLAB_API_KEY` (sem SigV4 nenhum —
   apagar essa complexidade toda).
2. Aceitar que não há delete via API — ou perguntar ao suporte deles se existe uma rota
   não documentada, ou manter os ficheiros lá permanentemente (50GB dá para durar) e
   gerir manualmente pela app/dashboard deles quando precisar limpar.
3. Decidir com o Brener se vale expor a `FFMPEGLAB_API_KEY` ao browser para envio direto
   sem limite de tamanho, ou se convive com o limite de tamanho de pedido das Pages
   Functions (routing pelo nosso `/api/upload` como o Cloudinary já faz hoje).
4. Voltar `FFMPEGLAB_ATIVO = true` só depois disso funcionar de ponta a ponta.

---

## 9. Contas, serviços, IDs

| Serviço | Detalhe | Conta |
|---|---|---|
| **Cloudflare** | account id `b27fb167f3e577f004a13534a9bd56b8` · subdomínio `asteris-media.workers.dev` | `asteris.media@hotmail.com` |
| Cloudflare Pages | projeto **`asteris-media-website`**, ligado ao repo (GitHub App só nesse repo), build vazio, output `/`, deploy automático em `main` | idem |
| Cloudflare KV | namespace **`asteris-portal`** id `6f397663e1aa45bb88a2093644970248` · binding **`ASTERIS_KV`** | idem |
| Cloudflare R2 | bucket **`asteris-media`** (Europa Ocidental, privado, público OFF) · binding **`ASTERIS_R2`** | idem |
| GitHub | repo **`Asteris-Media/Asteris-Media-Website`** (org `Asteris-Media` sob conta pessoal `RogerzillaTheArchitect`), público, branch `main` | `rogermartins9696@gmail.com` |
| Domínio | **`asteris.pt`** — registado na **Amen.pt** (cliente "Asteris Media" AM11121-AMPT). Nameservers mudados para **`galilea.ns.cloudflare.com` + `nick.ns.cloudflare.com`**. Zona Cloudflare "Active". DNSSEC desativado na mudança. | login Amen: `asteris.media@hotmail.com` |
| Cloudinary | cloud name **`bv9q81il`** | `asteris.media@hotmail.com` (confirmar) |
| Formspree | form "Site Asteris" id **`maeylznr`** → entrega em `asteris.media@hotmail.com` | idem |
| WhatsApp | **`351933829767`** — número **pessoal do Brener**, provisório até haver o da empresa | — |

**Variáveis no Cloudflare Pages** (Settings → Variables and secrets):
- `ADMIN_PW` = `Administrador.10` (Text) — password partilhada do `/admin` (utilizador "Admin")
- `ADMIN_USERS` (Secret, opcional) = `Brener:senha1,Gustavo:senha2` — contas nomeadas para o registo de atividade
- `SESSION_SECRET` = string aleatória longa (Text) — assina a sessão
- `CLOUDINARY_CLOUD` = `bv9q81il` (Text)
- `CLOUDINARY_KEY` / `CLOUDINARY_SECRET` (Secret) — API keys da Cloudinary
- (opcional) `R2_PUBLIC_BASE` — se um dia o R2 tiver domínio público, o upload devolve URLs desse domínio em vez de `/api/r2/`
- `FFMPEGLAB_API_KEY` (Secret, já posta) — **integração em pausa**, ver secção 8.1. Fica sem efeito enquanto `FFMPEGLAB_ATIVO = false` em `admin/index.html`.

**Bindings no Cloudflare Pages** (Settings → Bindings): `ASTERIS_KV` (KV) · `ASTERIS_R2` (R2 bucket `asteris-media`).

> ⚠️ Alterar variáveis/bindings **só vale depois de um novo deploy** (`git push` ou "Retry deployment").

---

## 10. Domínio e DNS

- `asteris.pt` + `www.asteris.pt` adicionados como Custom Domains no Pages. SSL apex emitido. `www` cert pode ainda estar a provisionar.
- **34 registos NS lixo** na zona Cloudflare (`_dmarc`, `_domainkey`, `spf`, `mail`, `email`, `aws`, `dev`, `test`… → `verification1/2.plaindns.net`), importados pelo Quick Scan. **Não afetam o site**, mas fazem sombra aos registos de email — limpar **antes** de configurar email @asteris.pt. O bulk-delete foi bloqueado pelo classificador de segurança; fazer com confirmação ou 1 a 1.
- Amen: área DNS em `controlpanel.amen.pt/domains/dns.html` → abre `wlcp.amen.pt`; pede código OTP (email/WhatsApp) a cada acesso.
- **GitHub Pages** (`asteris-media.github.io/Asteris-Media-Website`) ainda existe como backup, mas o canónico é o Cloudflare Pages.

---

## 11. Decisões tomadas (não reabrir sem o Brener pedir)

1. **Hospedagem: Cloudflare Pages** (era GitHub Pages). Migrado porque precisávamos de Functions + KV + R2 para o portal Fase 2.
2. **Vercel abandonado** — pedia número de telemóvel.
3. **Estrutura do site:** hero → carrossel de clientes (marquee que abre galeria ao clicar) → **secção única** posicionamento+resultados → contacto → footer. O Brener foi enfático: **não transformar o carrossel em grid, não separar posicionamento de resultados** ("VAGABUNDO VOCE MEXEU NOS SLIDERS").
4. **Portal = obscuridade por código**, sem login de cliente. Códigos longos aleatórios.
5. **Base de dados = Cloudflare KV**, não ficheiros (Fase 2). Os exemplos ficam como ficheiros estáticos com fallback.
6. **Admin com password própria** (sessão HMAC self-contained), sem Cloudflare Access.
7. **Storage: R2 para entregas, Cloudinary para portfólio/seleção.** (ver secção 8). Storj descartado. FFmpegLab (50GB grátis) integrado e depois **pausado** — API não permite o que o marketing promete, ver 8.1.
8. **Compressão de vídeo = local com ffmpeg**, por agora. Cloudinary/Stream ficam como alternativa futura para transcoding automático (Stream é pago, ~5€/mês).
9. **Cards antes/depois:** notas de "antes" em cinza morto + 👎, "depois" em dourado forte com glow + 👏. Fotos clicáveis (lightbox). No mobile viram carrossel.
10. **DOCS navegáveis fora dos artifacts do Claude** — o Brener não quer depender do Claude; estão em `Documents/Projetos/Asteris/DOCS/` como HTML autónomo.
11. **Rodapé padronizado** em todas as páginas (marca Asteris, nunca nome de cliente nas sub-páginas).
12. **Confirmações no admin = modais do site**, nunca `confirm()`/`prompt()`/`alert()` do browser.
13. Divisão sócios: Modelo B (pote comum → margem → 55% horas / 35% função / 10% reinveste); Brener (Pessoa A) com mínimo €1.800/mês até o Gustavo fechar vendas consistentes.
14. Pricing: metodologia própria (custo-hora €31 → tempo real → custos → 30% imposto → margem mín. 55%).

---

## 12. O que ficou de fora / não feito / onde parámos

**Feito e a funcionar:**
- Landing completa, portal (3 modos), acesso, admin (login + painel + 4 colunas + editor de secções flexíveis), API + KV, R2 ligado (bucket + binding), Cloudinary (chaves acabadas de pôr), biblioteca de media (2 nuvens, upload de pasta, tags, visualizador com seleção/zip/apagar).

**Por fazer / a afinar:**
- [ ] **Auto-delete das entregas:** regra de ciclo de vida no R2 (apagar prefixo `entregas/` após N dias — mas o prazo varia por página; talvez melhor um cron que lê o índice KV). Cloudinary: `expires_at` nos URLs + cron de limpeza. **Nada montado.**
- [ ] **Cron de expiração** (Cloudflare Cron Triggers) — marcar/apagar páginas expiradas automaticamente.
- [ ] **Email `@asteris.pt`** (Zoho ou similar) — precisa dos **34 registos NS lixo limpos primeiro**, depois MX/SPF/DKIM.
- [ ] **`www.asteris.pt`** — confirmar que o cert provisionou.
- [ ] **Limpar os 34 NS lixo** na zona Cloudflare.
- [ ] Os **2 modos de seleção** que o Brener gostou e não foram construídos: (a) duas colunas (todas | preview central | selecionadas), (b) carrossel tipo Tinder ✓/✗. O modo atual (grelha + botão) pode servir.
- [ ] **Function para status 200** nas rotas do portal (agora `404.html` devolve status 404 embora renderize bem).
- [ ] **Compressor de imagens no browser** dentro do admin (canvas resize + reencode antes do upload) — decidido, não feito.
- [ ] Ficheiros grandes (masters >100 MB) não passam pelo `/api/upload` — usar clips comprimidos ou a S3 API do R2 direto.
- [ ] Logótipos reais dos clientes no carrossel (agora é texto).
- [ ] Dados reais nos cards antes/depois (agora ilustrativos).
- [ ] `exemplos.html` e os códigos de teste em `data/` — apagar quando o Brener não precisar.
- [ ] `vercel.json`, `CNAME`, `.nojekyll` — legado, podem sair.
- [ ] Bug reportado a investigar: "copiar link da pasta abre vazia mas tem conteúdo" — o `/api/media/view` já mostra diagnóstico; provável mismatch entre o nome da pasta no `/api/media` e o prefixo real (R2) ou o `asset_folder` (Cloudinary dynamic folders).

**Onde parámos exatamente (2026-09-09):**
Acabou de se ligar o R2 (bucket `asteris-media` + binding `ASTERIS_R2`, redeploy feito), o Brener acabou de meter as 3 variáveis do Cloudinary no Pages, e está a testar a **biblioteca de media** — a afinar o visualizador de pasta (seleção, zip, apagar individual/em massa, download individual, tags por pasta). Últimos commits: ver `git log`.

---

## 13. Como trabalhar no repo

```bash
cd "C:/Users/brene/Documents/Projetos/Asteris/SITE"
# editar os ficheiros
git add -A && git commit -m "..."
git push            # deploy automático para asteris.pt (Cloudflare Pages)
```

- **Não há servidor de dev** que replique as Functions localmente sem `wrangler`. Para testar a landing/portal isolados: abrir o `.html` no browser (as chamadas à API falham, mas o layout renderiza). Para testar a fundo: `npx wrangler pages dev .` (não configurado, mas funcionaria).
- O deploy demora ~1–2 min. Verificar com `curl -s https://asteris.pt/...` ou no dashboard.
- ffmpeg para comprimir vídeo: `npm i ffmpeg-static` traz o binário (não há ffmpeg no PATH da máquina do Brener).
- O Brener autorizou **commits/push diretos em `main`** para este repo (contraria a regra geral de branch+PR — vale só aqui).

---

## 14. Relação com o Sellecta

O **Sellecta** (`Documents/Projetos/Projeto Sellecta/`) é um produto SaaS derivado deste sistema: entrega + seleção + portfólio no site do próprio fotógrafo, sobre a nuvem dele, com apagamento automático. A Asteris é o "cliente zero". Muito do que está construído aqui (portal por código, editor de secções, biblioteca, roteamento de storage, zip download) é candidato a entrar no Sellecta. Ver o `IDEIA.md` e o `demo/` de lá.

---

## 15. Registo de escrita / tom (para textos do site)

- Português de Portugal.
- Sóbrio, sem hype, sem "revolucionário". "Commercial Content Studio" — posicionamento, não venda de likes.
- Números dos casos são ilustrativos mas plausíveis; nunca inventar clientes reais.
