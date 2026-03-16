# Baileys API — Documentação

REST API para envio de mensagens via WhatsApp Web (Baileys).

**Base URL:** `https://wpp.webcontabeis.com.br`
**Autenticação:** Header `X-Api-Key` em todas as requisições (exceto `/health`)

---

## Autenticação

Todas as rotas (exceto `/health`) exigem o header:

```
X-Api-Key: SUA_CHAVE_AQUI
```

Se a chave estiver incorreta ou ausente:
```json
HTTP 401
{ "error": "Unauthorized: X-Api-Key inválida ou ausente" }
```

---

## Status da Conexão

### GET /health
Verificação pública de disponibilidade da API. Não exige autenticação.

**Resposta:**
```json
{ "ok": true, "status": "connected" }
```

---

### GET /status
Retorna o estado atual da conexão com o WhatsApp.

**Resposta:**
```json
{
  "status": "connected",
  "qrAvailable": false,
  "phone": "5511999999999@s.whatsapp.net",
  "name": "Nome do usuário"
}
```

**Valores de `status`:**

| Valor | Descrição |
|-------|-----------|
| `disconnected` | Não conectado |
| `qr_pending` | Aguardando escaneamento do QR |
| `reconnecting` | Reconectando automaticamente |
| `connected` | Conectado e pronto |
| `logged_out` | Sessão encerrada (requer novo QR) |

---

### GET /qr
Retorna o QR code como imagem PNG para autenticação no WhatsApp.

> Disponível apenas quando `status = qr_pending`. Após escanear, a sessão persiste automaticamente.

**Resposta:** `image/png`

---

### GET /qr.json
Retorna o QR code em base64 (útil para exibir em interfaces web).

**Resposta:**
```json
{ "qr": "data:image/png;base64,iVBORw0KGgo..." }
```

---

### POST /logout
Encerra a sessão atual e limpa as credenciais salvas. Uma nova autenticação via QR será necessária.

**Resposta:**
```json
{ "success": true, "message": "Sessão encerrada e auth limpa" }
```

---

## Mensagens Diretas (1:1)

> Requer `status = connected` em todas as rotas abaixo.

### POST /check
Verifica se um número possui WhatsApp ativo.

**Body:**
```json
{ "phone": "5511999999999" }
```

**Resposta:**
```json
{
  "phone": "5511999999999",
  "registered": true,
  "jid": "5511999999999@s.whatsapp.net"
}
```

---

### POST /send/text
Envia mensagem de texto para um número.

**Body:**
```json
{
  "phone": "5511999999999",
  "message": "Olá! Esta é uma mensagem de teste."
}
```

**Resposta:**
```json
{
  "success": true,
  "messageId": "3EB0123456789ABCDEF",
  "to": "5511999999999@s.whatsapp.net"
}
```

---

### POST /send/image
Envia uma imagem a partir de uma URL pública.

**Body:**
```json
{
  "phone": "5511999999999",
  "url": "https://exemplo.com/imagem.jpg",
  "caption": "Legenda opcional"
}
```

---

### POST /send/file
Envia um documento/arquivo a partir de uma URL pública.

**Body:**
```json
{
  "phone": "5511999999999",
  "url": "https://exemplo.com/relatorio.pdf",
  "filename": "relatorio.pdf",
  "mimetype": "application/pdf"
}
```

> `mimetype` é opcional. Padrão: `application/octet-stream`

---

### POST /send/audio
Envia um áudio. Defina `ptt: true` para enviar como mensagem de voz.

**Body:**
```json
{
  "phone": "5511999999999",
  "url": "https://exemplo.com/audio.mp4",
  "ptt": true
}
```

---

### GET /groups
Lista todos os grupos dos quais o número conectado participa.

**Resposta:**
```json
{
  "count": 2,
  "groups": [
    {
      "id": "5511999999999-1234567890@g.us",
      "subject": "Nome do Grupo",
      "participantCount": 45,
      "owner": "5511999999999@s.whatsapp.net"
    }
  ]
}
```

---

## Canais (Newsletter)

Os canais do WhatsApp são identificados por:
- **JID**: `120363XXXXXXXXXX@newsletter`
- **Código de convite**: código curto do link do canal
- **URL completa**: `https://whatsapp.com/channel/CODIGO`

Todos os endpoints de canal aceitam qualquer um dos três formatos nos campos `jid` ou `invite`.

---

### POST /newsletter/info
Retorna informações detalhadas de um canal.

**Body (por JID):**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

**Body (por código ou URL):**
```json
{ "invite": "https://whatsapp.com/channel/CODIGO" }
```

**Resposta:** objeto com metadados do canal (id, nome, descrição, inscritos, etc.)

---

### POST /newsletter/send/text
Envia mensagem de texto para um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "message": "Conteúdo da publicação no canal."
}
```

**Resposta:**
```json
{
  "success": true,
  "messageId": "3EB0123456789ABCDEF",
  "to": "120363XXXXXXXXXX@newsletter"
}
```

---

### POST /newsletter/send/image
Envia imagem para um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "url": "https://exemplo.com/imagem.jpg",
  "caption": "Legenda opcional"
}
```

---

### POST /newsletter/send/video
Envia vídeo para um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "url": "https://exemplo.com/video.mp4",
  "caption": "Legenda opcional"
}
```

---

### POST /newsletter/send/file
Envia documento para um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "url": "https://exemplo.com/arquivo.pdf",
  "filename": "arquivo.pdf",
  "mimetype": "application/pdf"
}
```

---

### POST /newsletter/messages
Busca o histórico de mensagens de um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "count": 20,
  "since": 0,
  "after": 0
}
```

> `count`, `since` e `after` são opcionais. Padrão: `count = 20`.

**Resposta:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "count": 20,
  "messages": [ ... ]
}
```

---

### POST /newsletter/react
Reage a uma mensagem de um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "serverId": "ID_DA_MENSAGEM",
  "reaction": "👍"
}
```

> Envie `reaction: ""` para remover a reação.

---

### POST /newsletter/follow
Segue um canal.

**Body:**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

---

### POST /newsletter/unfollow
Deixa de seguir um canal.

**Body:**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

---

### POST /newsletter/mute
Silencia notificações de um canal.

**Body:**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

---

### POST /newsletter/unmute
Reativa notificações de um canal.

**Body:**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

---

### POST /newsletter/subscribers
Retorna a contagem de inscritos de um canal.

**Body:**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

---

### POST /newsletter/create
Cria um novo canal.

**Body:**
```json
{
  "name": "Nome do Canal",
  "description": "Descrição opcional do canal"
}
```

**Resposta:**
```json
{ "success": true, "newsletter": { ... } }
```

---

### POST /newsletter/update/name
Atualiza o nome de um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "name": "Novo Nome do Canal"
}
```

---

### POST /newsletter/update/description
Atualiza a descrição de um canal.

**Body:**
```json
{
  "jid": "120363XXXXXXXXXX@newsletter",
  "description": "Nova descrição do canal."
}
```

---

### DELETE /newsletter
Deleta permanentemente um canal. **Ação irreversível.**

**Body:**
```json
{ "jid": "120363XXXXXXXXXX@newsletter" }
```

---

## Erros Comuns

| HTTP | Mensagem | Causa |
|------|----------|-------|
| `401` | `Unauthorized: X-Api-Key inválida ou ausente` | Header `X-Api-Key` incorreto ou não enviado |
| `400` | `Campos obrigatórios: phone, message` | Campos obrigatórios ausentes no body |
| `404` | `QR não disponível. Status atual: reconnecting` | QR solicitado fora da janela de geração |
| `503` | `WhatsApp não conectado` | Tentativa de envio sem conexão ativa |
| `500` | `mensagem do erro interno` | Erro inesperado no envio |

---

## Exemplo de Integração (n8n / HTTP Request)

### Enviar texto para canal
```
Method: POST
URL: https://wpp.webcontabeis.com.br/newsletter/send/text
Headers:
  X-Api-Key: SUA_CHAVE
  Content-Type: application/json
Body:
  {
    "jid": "120363XXXXXXXXXX@newsletter",
    "message": "{{ $json.mensagem }}"
  }
```

### Enviar imagem para canal
```
Method: POST
URL: https://wpp.webcontabeis.com.br/newsletter/send/image
Headers:
  X-Api-Key: SUA_CHAVE
  Content-Type: application/json
Body:
  {
    "jid": "120363XXXXXXXXXX@newsletter",
    "url": "{{ $json.url_imagem }}",
    "caption": "{{ $json.legenda }}"
  }
```
