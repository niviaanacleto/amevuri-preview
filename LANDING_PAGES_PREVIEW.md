# AMEVURI — landing pages de aromas em pré visualização

Esta versão parte do pacote completo v5.5.0 e incorpora a atualização de miniaturas e trocas enviada no mesmo atendimento.

## Área de revisão

Abra `/preview-aromas` para acessar as nove páginas novas. Todas estão com `noindex,nofollow,noarchive`, não foram adicionadas ao sitemap e não aparecem na coleção pública. Isso permite revisar a integração antes da publicação.

## Rotas preparadas

- `/baunilha-lavanda`
- `/bambu-chines-jacinto`
- `/sakura-musk`
- `/figo-folhas`
- `/rosa-bulgara-acafrao`
- `/artemisia-cedro`
- `/cereja-ambar`
- `/salvia-sandalo`
- `/gengibre-patchouli`

Cumaru & Sândalo permanece em `/cumaru-sandalo` como referência estrutural.

## Decisão de integração

As novas páginas não criam SKUs, preços ou disponibilidade que não existam no catálogo atual. A landing de Sakura oferece um atalho para a página de produto já existente. Os demais aromas usam CTA de curadoria por WhatsApp até que seus produtos sejam oficialmente cadastrados.

## Para publicar após aprovação

1. Trocar `noindex,nofollow,noarchive` por `index,follow,max-image-preview:large`.
2. Adicionar canonical e metadados Open Graph definitivos.
3. Inserir os aromas aprovados em `colecao.html` e em `sitemap.xml`.
4. Se houver venda direta, criar os SKUs em `src/lib/catalog.js` e no catálogo correspondente de `public/commerce.js`, com pesos, preços, estoque e dimensões validados.
5. Substituir os recortes conceituais por fotografias finais do produto quando disponíveis.
