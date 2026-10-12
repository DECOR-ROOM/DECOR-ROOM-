# Decor Room - Landing Page

## Estrutura
```
index.html      → Página principal
images/         → Todas as imagens (formato WebP, otimizadas)
_headers        → Regras de cache para Cloudflare Pages
```

## Como publicar com Cloudflare Pages

1. Crie um repositório no GitHub e suba todos os arquivos desta pasta
   (mantendo a pasta `images/` e o arquivo `_headers` na raiz, junto com `index.html`).

2. No painel da Cloudflare:
   - Vá em **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
   - Selecione o repositório
   - Build command: deixe em branco
   - Build output directory: `/` (raiz)
   - Deploy

3. Após o deploy, vá em **Custom domains** no projeto da Cloudflare Pages
   e adicione `decorroombr.com.br` (e `www.decorroombr.com.br` se quiser).
   A Cloudflare vai te dar instruções de DNS (CNAME) — se o domínio já estiver
   na Cloudflare, ela mesma cria os registros automaticamente.

## Otimizações já aplicadas
- Todas as imagens foram extraídas do HTML (antes em base64, ~14MB) e convertidas
  para WebP (qualidade 80%), reduzindo o peso total para ~6MB.
- `loading="lazy"` em todas as imagens fora da primeira tela (above the fold).
- A primeira imagem do banner principal usa `fetchpriority="high"` para
  carregar o quanto antes (melhora LCP).
- Cache de 1 ano para imagens via `_headers` (Cloudflare Pages).

## Dica extra de performance
Na Cloudflare, ative em **Speed**:
- Auto Minify (HTML, CSS, JS)
- Brotli compression (já vem ativo por padrão)
- Rocket Loader (teste, opcional)

Essas configurações combinadas com a estrutura acima devem te colocar
próximo de 95-98 no PageSpeed/Lighthouse.
