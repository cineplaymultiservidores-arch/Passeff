RAVENA STORE — BACKEND + PAGAMENTO + ENTREGA
================================================

O projeto agora tem:
- Frontend em public/
- Backend Node.js/Express
- Mercado Pago Orders API para Pix
- Webhook do Mercado Pago com validação HMAC
- Controle de pedidos em data/orders.json
- Entrega automática pela API SocketSync
- Proteção contra dupla entrega por pedido
- Endpoint de consulta de status para o frontend

1) INSTALAR
-----------
Instale Node.js 18 ou superior.

Na pasta do projeto:
    npm install

2) CONFIGURAR
-------------
Copie .env.example para .env e preencha:

MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
SOCKETSYNC_API_KEY=
PUBLIC_BASE_URL=

A chave privada do Mercado Pago e a pbk_live da SocketSync ficam SOMENTE no servidor.
Nunca coloque essas chaves no index.html.

3) RODAR
--------
    npm start

O site abrirá na porta 3000.

4) MERCADO PAGO
---------------
Crie uma aplicação no Mercado Pago e use a credencial de backend.
Configure Webhooks para o tópico:
    Order (Mercado Pago)

URL:
    https://SEU-DOMINIO.com/webhooks/mercadopago

Copie o segredo gerado para MP_WEBHOOK_SECRET.

A documentação atual do Mercado Pago recomenda Orders API para Checkout Transparente e
Webhooks para receber atualizações de orders. O backend consulta GET /v1/orders/{id}
antes de entregar.

5) FLUXO
--------
Cliente informa ID + e-mail
 -> POST /api/orders
 -> backend cria Pix de R$ 10,00
 -> cliente paga
 -> Mercado Pago envia Webhook
 -> backend valida assinatura
 -> backend consulta a Order
 -> somente se status=processed
 -> POST /api/v1/pass na SocketSync
 -> pedido fica delivered
 -> frontend mostra "Passe enviado com sucesso"

6) IMPORTANTE SOBRE A SOCKETSYNC
---------------------------------
O endpoint usado é exatamente o informado pelo usuário:
POST /api/v1/pass
Authorization: Bearer pbk_live_...
Body: {"player_id":"..."}

Como o formato de resposta da SocketSync não foi fornecido, o backend considera HTTP 2xx
como aceitação da entrega e salva a resposta. Se a documentação da SocketSync tiver um
campo específico de sucesso, vale adaptar essa verificação.

7) PRODUÇÃO
-----------
Use hospedagem com HTTPS. O webhook do Mercado Pago precisa de uma URL HTTPS pública.
Também é recomendado trocar o armazenamento JSON por um banco de dados antes de uma loja
com volume maior de pedidos.
