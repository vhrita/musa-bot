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

# 4. Instalar Chromium (para cookies)
sudo apt install chromium-browser

# 5. Fazer login no YouTube
chromium-browser --no-sandbox
# Vai para youtube.com e faz login
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

# Ou com Docker
docker build -t youtube-resolver .
docker run -p 3001:3001 youtube-resolver
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

### **GET /health**
```json
{
  "status": "ok",
  "service": "youtube-resolver",
  "timestamp": "2025-09-02T03:25:00.000Z"
}
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

```bash
# Configurar iptables (exemplo)
sudo iptables -A INPUT -p tcp --dport 3001 -s IP_DA_VPS -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3001 -j DROP
```
