# 💇 Salão Vanessa Vasconcelos — Sistema de Agendamento

Sistema completo de agendamento online para salão de beleza, com notificações automáticas via WhatsApp e painel de consulta de agenda por mensagem.

![Python](https://img.shields.io/badge/Python-3.11-blue?logo=python)
![Flask](https://img.shields.io/badge/Flask-3.x-lightgrey?logo=flask)
![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)
![Firebase](https://img.shields.io/badge/Firebase-Firestore-orange?logo=firebase)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Baileys-25D366?logo=whatsapp)

---

## 🏗️ Arquitetura

```
┌─────────────────────────┐        ┌─────────────────────────┐
│    backend-flask        │        │     bot-whatsapp        │
│    (Render - Nuvem)     │◄──────►│     (PC Local)          │
│                         │  HTTP  │                         │
│  • Website agendamento  │        │  • Envia mensagens WA   │
│  • API REST             │        │  • Recebe comandos dona │
│  • Firebase Firestore   │        │  • Baileys + Express    │
└─────────────────────────┘        └─────────────────────────┘
```

| Componente | Tecnologia | Deploy |
|---|---|---|
| **Backend/API** | Python, Flask, Firebase | Render (free tier) |
| **Bot WhatsApp** | Node.js, Baileys, Express | Local (PC da dona) |
| **Banco de dados** | Firebase Firestore | Google Cloud |

---

## ✨ Funcionalidades

- 📅 **Agendamento online** — calendário interativo com verificação de conflitos em tempo real
- ✅ **Confirmação automática** — mensagem WhatsApp enviada ao cliente após agendar
- 📋 **Notificação para a dona** — a dona recebe cada novo agendamento no WhatsApp
- 🤖 **Consulta de agenda via WhatsApp** — a dona envia "hoje", "amanhã" ou "semana" e recebe a lista
- 🔒 **Zero credenciais expostas** — tudo via variáveis de ambiente

### Comandos da Dona via WhatsApp

| Comando | Resultado |
|---|---|
| `hoje` ou `agenda` | Agendamentos do dia |
| `amanhã` | Agendamentos de amanhã |
| `semana` | Próximos 7 dias |
| `ajuda` | Lista de comandos |

---

## 🚀 Como rodar localmente

### Pré-requisitos

- Python 3.11+
- Node.js 20+
- Conta Firebase com Firestore ativo

### 1. Backend Flask

```bash
cd backend-flask
python -m venv venv
venv\Scripts\activate          # Windows
pip install -r requirements.txt

# Crie o .env baseado no exemplo
copy .env.example .env         # Preencha com suas credenciais

python app.py
```

### 2. Bot WhatsApp

```bash
cd bot-whatsapp
npm install

# Crie o .env baseado no exemplo
copy .env.example .env         # Preencha com suas credenciais

npm start
```

> Na primeira execução, o bot gera um **código de pareamento** no terminal. Abra o WhatsApp > Aparelhos conectados > Conectar com número de telefone e digite o código.

---

## ☁️ Deploy no Render (Flask)

1. Conecte este repositório ao [Render](https://render.com)
2. Crie um **Web Service** apontando para a pasta `backend-flask`
3. Configure as variáveis de ambiente no Dashboard:

| Variável | Descrição |
|---|---|
| `FIREBASE_CREDENTIALS` | Conteúdo JSON completo do serviceAccountKey.json |
| `BAILEYS_URL` | URL pública do bot (ex: ngrok ou Cloudflare Tunnel) |
| `NUMERO_DONA` | Número da dona com DDI (ex: `5511999998888`) |

4. Build command: `pip install -r requirements.txt`
5. Start command: `gunicorn app:app --bind 0.0.0.0:$PORT`

> ⚠️ O bot WhatsApp roda **localmente**. Para que o Render consiga alcançá-lo, use um túnel como [ngrok](https://ngrok.com) ou [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## 📁 Estrutura do Projeto

```
.
├── backend-flask/           # 🐍 API Flask + Website (deploy no Render)
│   ├── app.py               # Aplicação principal
│   ├── requirements.txt     # Dependências Python
│   ├── render.yaml          # Blueprint de deploy Render
│   ├── .env.example         # Modelo de variáveis de ambiente
│   ├── templates/           # HTML (Jinja2)
│   │   ├── home.html
│   │   ├── index.html
│   │   └── sucesso.html
│   └── static/
│       └── logo.png
│
├── bot-whatsapp/            # 📱 Bot WhatsApp Baileys (roda local)
│   ├── index.js             # Microserviço Baileys
│   ├── package.json         # Dependências Node.js
│   └── .env.example         # Modelo de variáveis de ambiente
│
├── .gitignore               # Protege credenciais e arquivos sensíveis
└── README.md                # Este arquivo
```

---

## 🔐 Segurança

- ✅ Credenciais Firebase via variável de ambiente (`FIREBASE_CREDENTIALS`)
- ✅ Números de telefone via variável de ambiente
- ✅ Arquivo `.gitignore` protege: `.env`, `serviceAccountKey.json`, `sessao_whatsapp/`, `node_modules/`, `venv/`
- ✅ Arquivos `.env.example` documentam as variáveis sem expor valores reais

---

## 📄 Licença

Este projeto é de uso pessoal/educacional.

---

> Desenvolvido por **Bruno** como projeto de portfólio.
