# Portal Asteris — como criar uma página

Cada página do portal é **um ficheiro JSON** nesta pasta (`/data/`).
O nome do ficheiro é o código de acesso.

    data/H46DJ.json   ->   asteris.pt/H46DJ

Duas formas de o cliente entrar:
- link directo: `asteris.pt/H46DJ`
- página de acesso: `asteris.pt/acesso` -> escolhe Seleção / Entrega / Portfólio -> insere o código

## Página anónima (portfólio ou entrega discreta)

Põe `"anon": true` no JSON: esconde o nome do cliente e o rótulo do tipo, fica só a marca Asteris.
Para portfólio privado, deixa também sem `cliente` e sem `expira`. Ver exemplo `PF2K9X.json`.

Regras do código:
- 4 a ~10 caracteres, letras e números (podes usar `-` ou `_`)
- **usa códigos longos e aleatórios** para entregas privadas (ex.: `k7m2p9xq`). É a única fecho da porta: quem não tem o link não encontra a página.
- não uses palavras óbvias (`entrega`, `fotos`, nome do cliente sozinho)

Depois de criar/editar o ficheiro: `git add`, `git commit`, `git push`. Fica no ar em ~1 min.

Se a data em `"expira"` já passou, a página mostra "link expirou" sozinha.

---

## 1. Galeria de entrega  ·  `"type": "galeria"`

```json
{
  "type": "galeria",
  "cliente": "Nome do Cliente",
  "titulo": "Entrega — vídeo + fotos",
  "intro": "Texto curto para o cliente.",
  "capa": "/assets/clientes/xxx.mp4",        // imagem OU vídeo de fundo do cabeçalho (opcional)
  "expira": "2026-10-15",                     // opcional. AAAA-MM-DD
  "downloadTudo": "https://.../pacote.zip",   // opcional. link do .zip
  "itens": [
    { "tipo": "video", "nome": "final",   "src": "https://.../video.mp4", "download": "https://.../video.mp4" },
    { "tipo": "foto",  "nome": "foto-01", "src": "https://.../grande.jpg", "thumb": "https://.../pequena.jpg" }
  ]
}
```

- `src` = ficheiro em tamanho bom (mostra no lightbox)
- `thumb` = versão pequena para a grelha (opcional; se não puseres usa o `src`)
- `download` = link para o cliente descarregar o original (opcional; sem ele não aparece botão)

## 2. Galeria privada de portfólio

Igual à galeria, `"type": "galeria"`, mas **sem `expira`** e sem `download`.
Serve para mostrar trabalho que não queres público no site. Partilhas o link só a quem interessa.

## 3. Triagem / seleção do cliente  ·  `"type": "triagem"`

```json
{
  "type": "triagem",
  "cliente": "Nome",
  "titulo": "Escolha das fotos",
  "intro": "Explica o que tem de fazer.",
  "capa": "/assets/...",
  "expira": "2026-09-30",
  "minimo": 10,                       // opcional. nº mínimo de peças
  "instrucoes": "Toca no círculo de cada foto.",
  "formspree": "xxxxxxx",             // ID Formspree p/ receberes a lista por email. vazio = abre o email do cliente
  "itens": [ ... igual à galeria ... ]
}
```

O cliente marca as que quer e carrega em **Guardar seleção**.
- Com `formspree` preenchido: a lista chega ao email ligado a esse form.
- Sem: abre o cliente de email dele já com a lista escrita.

> Fase 2 (depois, com Cloudflare Functions): a seleção grava-se sozinha e o site remove as não escolhidas. Por agora recebes a lista e tratas manualmente.

## 4. Proposta  ·  `"type": "proposta"`

Página que parece feita à medida do cliente mas é sempre o mesmo molde.
Ver exemplo completo em `PROPOSTA9.json`. Campos dentro de `"proposta"`:

| campo | o que é |
|---|---|
| `ondeEstao` | parágrafo — diagnóstico |
| `oQueVimos` | lista de pontos |
| `ondePodemChegar` | parágrafo — visão |
| `conceitos` | cartões `{titulo, desc, img}` |
| `moodboard` | lista de URLs de imagem |
| `planos` | `{nome, preco, inclui:[...], destaque:true}` |
| `validade` | ex.: `"15 dias"` |
| `cta` | frase final acima do botão de WhatsApp |

O botão de WhatsApp usa o número em `CONTACT_WA` no topo do `404.html`.

---

## Imagens e vídeos — onde alojar

Mete os ficheiros web no Cloudinary (conta `bv9q81il`) ou no armazenamento que ficar decidido,
e cola aqui os URLs. Ficheiros pequenos de exemplo podem apontar para `/assets/...` do próprio site.
