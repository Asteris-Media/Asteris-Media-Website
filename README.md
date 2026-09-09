# Site Asteris

Landing page single‑file. `index.html` — sem build, sem dependências.

**Repo:** https://github.com/Asteris-Media/Asteris-Media-Website (org `Asteris-Media`, público, para GitHub Pages)
**Live:** `https://asteris-media.github.io/Asteris-Media-Website/` (depois de ativar o Pages) → futuramente `asteris.pt`
**Deploy:** `git push` para `main` republica sozinho.

Estrutura (a partir do modelo `../Versoes de site anteriores.../projeto_asteris_completo BEM FEITO/`):
tema dourado/dark, serif Cormorant + Montserrat.

---

## Secções (por ordem)

| Secção | O que é | Estado |
|---|---|---|
| **Hero** | Frase + botão WhatsApp / imagem | Frase final. Imagem é placeholder (Cloudinary demo) — **trocar** pela do cavalo ou outra (`<!-- TROCAR -->` no HTML). |
| **Carrossel de clientes** | Marquee infinita de painéis inclinados, cada um com **vídeo de fundo** + nome do cliente. Passa sozinho, pausa ao passar o rato. **Clicar num painel abre a página do cliente.** | Dados de exemplo em `PORTFOLIO` (vídeo `bg` + `items[]`). Trocar pelos teus. Nome do cliente é texto — quando tiveres logótipos, troca `<span class="c-name">` por `<img>`. |
| **Posicionamento + Resultados** | *Uma só secção.* O texto de posicionamento é o enunciado; abaixo, no mesmo bloco, os cartões antes/depois com métricas que contam ao aparecer. | **Template.** Editar `RESULTS` no `<script>`. Aviso "secção ilustrativa" visível. |
| **Página do cliente** (overlay) | Abre ao clicar num cliente. Galeria completa em **colagem sem separadores** (masonry, zero espaços). Clicar numa peça amplia (foto ou vídeo). "Voltar" ou o botão do telemóvel fecham. | Puxa `PORTFOLIO[i].items`. |
| **Contacto** | Form + botão WhatsApp | Form precisa de um ID Formspree. |
| **Footer** | Confidencialidade + copyright | Final. |

---

## Configurar (3 valores — bloco `CONFIG` no fim do `index.html`)

```js
const CONFIG = {
  cloudName:   "demo",          // cloud name da Cloudinary (Dashboard > Product Environment)
  whatsapp:    "351900000000",  // número WhatsApp, só dígitos, com indicativo
  formspreeId: ""               // ID do form Formspree; vazio = form desativado (só WhatsApp)
};
```

### 1. Cloudinary
- `cloudName` está no Dashboard da tua conta.
- Upload dos trabalhos para pastas tipo `asteris/portfolio/orfeu/`.
- Nos arrays `PORTFOLIO` e `RESULTS`, trocar os `IMG("couple", …)` / `VID("dog")` de exemplo pelos teus **public IDs** (ex.: `IMG("asteris/portfolio/orfeu/01", {ar:"3:4"})`).
- Helpers: `IMG(id, {w, ar, c, e})` e `VID(id, w)`. `f_auto,q_auto` já otimiza e comprime.
- `PORTFOLIO[i].bg` = o vídeo de fundo do painel do carrossel desse cliente.

### 2. WhatsApp
- Pôr o número real. Os dois botões "Solicitar análise" passam a abrir o WhatsApp.

### 3. Formspree (formulário)
- Conta grátis em formspree.io (50 envios/mês). Novo form → destino `ola@asteris.pt`.
- Copiar o ID (parte final de `https://formspree.io/f/XXXXXXXX`) para `formspreeId`.
- Alternativa: Netlify Forms (se publicares na Netlify — dispensa o Formspree).

---

## Publicar

### Vercel (recomendado — grátis, deploy a cada push)
1. Pôr esta pasta no GitHub (abaixo).
2. vercel.com → New Project → importar o repo → se o repo tiver mais coisas, **Root Directory: `SITE`** → Deploy.
3. Settings → Domains → `asteris.pt` (+ `www`). A Vercel dá os registos DNS.

### Alternativas: Netlify · Cloudflare Pages · GitHub Pages (todas grátis, estáticas).

---

## GitHub

```bash
cd "C:/Users/brene/Documents/Projetos/Asteris/SITE"
git init && git add . && git commit -m "site asteris v1"
git branch -M main
git remote add origin https://github.com/<user>/asteris.git
git push -u origin main
```
Repo **privado** serve. O Gustavo pode ser colaborador para editar os textos no GitHub web.

---

## Notas técnicas
- Tudo num ficheiro. Sem build, sem framework, sem tracker/cookies.
- Colagem da página do cliente = CSS `columns` com `column-gap:0` → masonry sem separadores, responsivo (2→5 colunas), zero JS de layout.
- Carrossel = CSS `@keyframes marquee` (translateX 0→-50%, lista duplicada). Pausa em `:hover`. `prefers-reduced-motion` → vira scroll manual.
- Vídeos da colagem só tocam quando visíveis (IntersectionObserver).
- Página do cliente usa `history.pushState` → o botão "voltar" do telemóvel fecha a galeria.
- Acessível: Esc fecha, foco visível, painéis do carrossel são focáveis e abrem com Enter.
- Se quiseres analytics: Plausible ou Umami (leves, sem banner).
