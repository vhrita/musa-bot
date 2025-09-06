# � YouTube Resolver Server

Este é um resolver de YouTube que pode rodar em qualquer máquina usando cookies do navegador local.

## 🎯 **Como Funciona:**

1. **Servidor remoto** roda um servidor Express.js
2. **Bot na VPS** envia requisições para o servidor resolver
3. **Servidor resolve** URLs usando `yt-dlp --cookies-from-browser`
4. **Bot reproduz** os streams diretamente

## 🚀 **Setup do Servidor Resolver:**

### **1. Instalar no servidor:**

```bash
# 1. Clone o projeto
git clone https://github.com/vhrita/musa-bot.git
cd musa-bot/youtube-resolver

# 2. Instalar dependências
npm install

# 3. Instalar yt-dlp (se não tiver)
sudo apt update
sudo apt install python3 python3-pip
pip3 install yt-dlp

# 4. Configurar cookies do YouTube
# Copie seus cookies.txt para o servidor
# Exemplo: usando scp
scp cookies.txt usuario@servidor:/home/usuario/musa-bot/youtube-resolver/cookies/

# 5. Configurar variáveis de ambiente
export YTDLP_COOKIES_PATH=/home/usuario/musa-bot/youtube-resolver/cookies/cookies.txt
# ou
export YTDLP_COOKIES=/home/usuario/musa-bot/youtube-resolver/cookies/cookies.txt
```

### **2. Configurar o Bot na VPS:**

```bash
# Adicionar variável de ambiente no bot
export RESOLVER_URL="http://IP_DO_SEU_SERVIDOR:3001"
```

### **3. Executar:**

```bash
# No servidor resolver
npm start

# Ou com Docker (método recomendado)
docker build -t youtube-resolver .

# Executar com cookies persistentes
docker run -d \
  --name youtube-resolver \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /path/to/your/cookies:/data/cookies:ro \
  -e YTDLP_COOKIES_PATH=/data/cookies/cookies.txt \
  youtube-resolver

# Para Raspberry Pi com systemd (comando que vai no seu script)
# IMPORTANTE: Volume montado como read-only (:ro) para segurança
# O resolver copia os cookies para /tmp automaticamente
docker run -d \
  --name youtube-resolver \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /home/pi/cookies:/data/cookies:ro \
  -e YTDLP_COOKIES_PATH=/data/cookies/cookies.txt \
  youtube-resolver
```

### **🔄 Systemd Service (Raspberry Pi):**

Crie o arquivo `/etc/systemd/system/youtube-resolver.service`:

```ini
[Unit]
Description=YouTube Resolver for Musa Bot
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
ExecStartPre=-/usr/bin/docker stop youtube-resolver
ExecStartPre=-/usr/bin/docker rm youtube-resolver
ExecStart=/usr/bin/docker run -d \
  --name youtube-resolver \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /home/pi/cookies:/data/cookies:ro \
  -e YTDLP_COOKIES_PATH=/data/cookies/cookies.txt \
  youtube-resolver
ExecStop=/usr/bin/docker stop youtube-resolver
ExecStopPost=/usr/bin/docker rm youtube-resolver

[Install]
WantedBy=multi-user.target
```

Ativar:
```bash
sudo systemctl daemon-reload
sudo systemctl enable youtube-resolver
sudo systemctl start youtube-resolver
```

## 🔧 **API Endpoints:**

### **POST /search**
```json
{
  "query": "shape of you",
  "maxResults": 3
}
```

**Response:**
```json
{
  "results": [
    {
      "title": "Ed Sheeran - Shape of You",
      "creator": "Ed Sheeran",
      "duration": 263,
      "url": "https://www.youtube.com/watch?v=JGwWNGJdvx8",
      "thumbnail": "https://...",
      "service": "youtube"
    }
  ]
}
```

### **POST /stream**
```json
{
  "url": "https://www.youtube.com/watch?v=JGwWNGJdvx8"
}
```

**Response:**
```json
{
  "streamUrl": "https://rr3---sn-ab5l6ne7.googlevideo.com/..."
}
```

### **ALL /proxy-stream**
Proxy do stream do YouTube (aceita GET e HEAD). Exemplo:

```
GET /proxy-stream?url={URL_GOOGLEVIDEO_ENCODED}
```

Validações de destino: esquemas, hosts e CIDRs permitidos (ver seção de Segurança & Configuração).

### **GET /health**
```json
{
  "status": "ok",
  "service": "youtube-resolver",
  "timestamp": "2025-09-02T03:25:00.000Z"
}
```

## 🔐 Configuração segura por padrão (Option A)

Sem configurar variáveis, o resolver já inicia com proteções razoáveis:

- CORS desabilitado (não envia headers CORS) — acessos via navegador são bloqueados.
- `/proxy-stream` aceita apenas `https` e hosts terminando em `googlevideo.com`.
- Bloqueio de IPs privados/loopback/link-local por padrão (somente IPs públicos resolvidos via DNS são permitidos).

Para uma UI específica, libere somente sua origem:

```env
ALLOWED_ORIGINS=https://seu-site.example.com
```

Para endurecer ainda mais, restrinja por CIDR (opcional):

```env
# Exemplo (ranges do Google; mantenha atualizado conforme necessário)
ALLOWED_DEST_CIDRS=173.194.0.0/16,74.125.0.0/16,142.250.0.0/15,216.58.192.0/19
```

As chaves e explicações completas estão na seção “Segurança & Configuração via ENV”.

## 🚦 Rate Limiting por IP

O resolver aplica um limitador leve por IP (token bucket) aos endpoints `/search`, `/stream` e `/proxy-stream`.

Ambiente:

```env
RATE_LIMIT_WINDOW_MS=60000   # Janela (ms)
RATE_LIMIT_MAX=60            # Taxa média permitida por janela
RATE_LIMIT_BURST=20          # Capacidade de burst por IP
```

Os valores podem ser ajustados para seu ambiente. Em caso de estouro, retorna `429 Too Many Requests`.

## 🧰 Logging & NODE_ENV

- `NODE_ENV=production` → logs no nível `info` por padrão.
- Outras (dev/test) → `debug` por padrão.
- URLs de stream (googlevideo) são sanitizadas em produção (mostram apenas host/path/expire). Fora de produção, os logs incluem `originalUrl` para facilitar debug via SSH.

Tamanho/rotação de logs:

```env
LOG_MAX_SIZE_MB=5
LOG_MAX_FILES=3
```

## 🧾 Validação de Entrada

- JSON body limitado: `10kb`.
- `/search`:
  - `query`: string trimada, 1..200 chars
  - `maxResults`: padrão 3, clamp 1..5
  - `quickMode`: boolean, padrão `true` quando ausente
- `/stream`:

  - `url`: YouTube (`youtube.com`/`youtu.be`), 1..2048 chars
  - `proxy`/`bypass`: booleanos aceitam `true/false`

## ⚙️ Configuração via ENV (Resumo)

```env
# Server
PORT=3001

# CORS
ALLOWED_ORIGINS=https://seu-site.example.com

# Destino permitido no proxy
ALLOWED_DEST_SCHEMES=https
ALLOWED_DEST_HOST_SUFFIXES=googlevideo.com
# Opcional: restringir por CIDR IPv4
ALLOWED_DEST_CIDRS=173.194.0.0/16,74.125.0.0/16

# Cookies
# Caminho canônico (aceito pelo resolver e pelo bot):
COOKIES_PATH=/cookies/cookies.txt
# Alternativas específicas do resolver (se preferir):
# YTDLP_COOKIES_PATH=/cookies/cookies.txt
# QUICK_SEARCH_COOKIES=false

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
RATE_LIMIT_BURST=20

# Logging e proxy
LOG_MAX_SIZE_MB=5
LOG_MAX_FILES=3
TRUST_PROXY=false
```

## 🔄 **Integração com o Bot:**

O bot vai automaticamente usar o `ResolverYouTubeService` se:
- A variável `RESOLVER_URL` estiver configurada
- O health check do servidor resolver passar

## 🐛 **Troubleshooting:**

### **Cookies não funcionam:**
```bash
# Fazer novo login no Chromium
chromium-browser --no-sandbox
# Ir para youtube.com e fazer login novamente
```

### **Servidor não responde:**
```bash
# Verificar se está rodando
curl http://IP_DO_SERVIDOR:3001/health

# Ver logs
tail -f resolver.log
```

### **Bot não encontra servidor resolver:**
```bash
# No bot, verificar variável
echo $RESOLVER_URL

# Testar conectividade
curl $RESOLVER_URL/health
```

## 📱 **Monitoramento:**

```bash
# Ver logs em tempo real
tail -f resolver.log

# Verificar status
curl http://localhost:3001/health
```

## 🔒 **Segurança:**

- Use firewall para expor apenas porta 3001
- Configure acesso apenas para IP da VPS
- Mantenha o servidor resolver atualizado

### Segurança & Configuração via ENV

Variáveis de ambiente para CORS e validação de destino:

```env
# CORS: origens permitidas (se vazio, CORS desabilitado)
ALLOWED_ORIGINS=https://seu-site.example.com

# Esquemas de destino permitidos (padrão: https)
ALLOWED_DEST_SCHEMES=https

# Sufixos de host de destino permitidos (padrão: googlevideo.com)
ALLOWED_DEST_HOST_SUFFIXES=googlevideo.com

# Opcional: restringir IPs de destino a CIDRs IPv4 (se vazio, bloqueia IPs privados e permite públicos)
ALLOWED_DEST_CIDRS=173.194.0.0/16,74.125.0.0/16
```

Notas:
- O endpoint `/proxy-stream` aceita apenas `GET` e `HEAD`.
- Se `ALLOWED_DEST_CIDRS` não for definido, IPs privados/loopback são bloqueados por padrão.
- Suporte a CIDR IPv4; IPv6 pode ser adicionado posteriormente.

### Exemplo com Docker Compose (local)

```yaml
services:
  youtube-resolver:
    build:
      context: ./youtube-resolver
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    volumes:
      - ./cookies:/data/cookies:ro
      - ./youtube-resolver/logs:/app/logs
    environment:
      - NODE_ENV=development
      - YTDLP_COOKIES_PATH=/data/cookies/cookies.txt
      # Segurança (opcional)
      # - ALLOWED_ORIGINS=http://localhost:3000
      # - ALLOWED_DEST_SCHEMES=https
      # - ALLOWED_DEST_HOST_SUFFIXES=googlevideo.com
      # - ALLOWED_DEST_CIDRS=173.194.0.0/16,74.125.0.0/16
```

```bash
# Configurar iptables (exemplo)
sudo iptables -A INPUT -p tcp --dport 3001 -s IP_DA_VPS -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3001 -j DROP
```
