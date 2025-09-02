# 🍓 YouTube Resolver for Raspberry Pi

Este é um resolver de YouTube que roda no seu Raspberry Pi usando cookies do navegador local.

## 🎯 **Como Funciona:**

1. **Raspberry Pi** roda um servidor Express.js
2. **Bot na VPS** envia requisições para o Raspberry
3. **Raspberry resolve** URLs usando `yt-dlp --cookies-from-browser`
4. **Bot reproduz** os streams diretamente

## 🚀 **Setup no Raspberry Pi:**

### **1. Instalar no Raspberry:**

```bash
# 1. Clone o projeto
git clone https://github.com/vhrita/musa-bot.git
cd musa-bot/raspberry-resolver

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
export RASPBERRY_RESOLVER_URL="http://IP_DO_SEU_RASPBERRY:3001"
```

### **3. Executar:**

```bash
# No Raspberry Pi
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

O bot vai automaticamente usar o `RaspberryYouTubeService` se:
- A variável `RASPBERRY_RESOLVER_URL` estiver configurada
- O health check do Raspberry passar

## 🐛 **Troubleshooting:**

### **Cookies não funcionam:**
```bash
# Fazer novo login no Chromium
chromium-browser --no-sandbox
# Ir para youtube.com e fazer login novamente
```

### **Raspberry não responde:**
```bash
# Verificar se está rodando
curl http://IP_DO_RASPBERRY:3001/health

# Ver logs
tail -f resolver.log
```

### **Bot não encontra Raspberry:**
```bash
# No bot, verificar variável
echo $RASPBERRY_RESOLVER_URL

# Testar conectividade
curl $RASPBERRY_RESOLVER_URL/health
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
- Mantenha o Raspberry atualizado

```bash
# Configurar iptables (exemplo)
sudo iptables -A INPUT -p tcp --dport 3001 -s IP_DA_VPS -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3001 -j DROP
```
