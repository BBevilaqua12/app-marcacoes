import os
import re
import json
import firebase_admin
import requests
from flask import Flask, render_template, request, redirect, url_for, jsonify
from firebase_admin import credentials, firestore
from datetime import datetime, timedelta

app = Flask(__name__)

# ============================================================================
# 🔐 CONFIGURAÇÕES FIREBASE VIA VARIÁVEIS DE AMBIENTE
# ============================================================================
# No Render: configure a variável FIREBASE_CREDENTIALS com o conteúdo JSON
# completo do serviceAccountKey.json (colado como string única).
# Localmente: crie um arquivo .env com essa variável ou exporte no terminal.
# ============================================================================

firebase_json = os.environ.get("FIREBASE_CREDENTIALS")

if firebase_json:
    # Produção (Render): carrega o JSON da variável de ambiente
    cred_dict = json.loads(firebase_json)
    cred = credentials.Certificate(cred_dict)
else:
    # Desenvolvimento local: fallback para arquivo (NÃO commitado)
    cred = credentials.Certificate("serviceAccountKey.json")

if not firebase_admin._apps:
    firebase_admin.initialize_app(cred)
db = firestore.client()

# ============================================================================
# 🔐 CONFIGURAÇÕES SENSÍVEIS VIA VARIÁVEIS DE AMBIENTE
# ============================================================================

# URL do bot WhatsApp (local ou via túnel)
BAILEYS_URL = os.environ.get("BAILEYS_URL", "http://localhost:3001/enviar")

# Número da dona do salão (com DDI) — OBRIGATÓRIO em produção
NUMERO_DONA = os.environ.get("NUMERO_DONA", "")

# ============================================================================
# DICIONÁRIO DE SERVIÇOS COM PREÇO E DURAÇÃO
# ============================================================================

SERVICOS = {
    "corte": {"nome": "Corte", "preco": 70.00, "duracao_minutos": 60},
    "coloracao_retoque_curto": {"nome": "Coloração com Retoque - Cabelos Curtos", "preco": 150.00, "duracao_minutos": 90},
    "coloracao_retoque_medio": {"nome": "Coloração com Retoque - Cabelos Médios", "preco": 170.00, "duracao_minutos": 90},
    "coloracao_retoque_longo": {"nome": "Coloração com Retoque - Cabelos Longos", "preco": 200.00, "duracao_minutos": 90},
    "coloracao_total_curto": {"nome": "Coloração Total - Cabelos Curtos", "preco": 180.00, "duracao_minutos": 120},
    "coloracao_total_medio": {"nome": "Coloração Total - Cabelos Médios", "preco": 220.00, "duracao_minutos": 120},
    "coloracao_total_longo": {"nome": "Coloração Total - Cabelos Longos", "preco": 280.00, "duracao_minutos": 120},
    "hidratacao": {"nome": "Hidratação", "preco": 80.00, "duracao_minutos": 45},
    "hidratacao_vaporizador": {"nome": "Hidratação com Vaporizador Capilar", "preco": 120.00, "duracao_minutos": 60},
    "mechas_curto": {"nome": "Mechas - Cabelos Curtos", "preco": 350.00, "duracao_minutos": 240},
    "mechas_medio": {"nome": "Mechas - Cabelos Médios", "preco": 400.00, "duracao_minutos": 240},
    "mechas_longo": {"nome": "Mechas - Cabelos Longos", "preco": 600.00, "duracao_minutos": 240},
}

# ============================================================================
# FUNÇÕES DE ENVIO DE MENSAGEM VIA BAILEYS
# ============================================================================

def enviar_whatsapp_confirmacao(telefone, nome_cliente, servico_nome, data_hora_str):
    """
    Envia uma mensagem de confirmação de agendamento via Baileys (microserviço Node.js).
    """
    texto = (
        f"✅ *Agendamento Confirmado!*\n\n"
        f"👤 *Cliente:* {nome_cliente}\n"
        f"💇 *Serviço:* {servico_nome}\n"
        f"📅 *Data/Hora:* {data_hora_str}\n\n"
        f"Obrigada por agendar conosco! Qualquer dúvida, estamos à disposição. 💜"
    )

    try:
        response = requests.post(
            BAILEYS_URL,
            json={"telefone": telefone, "texto": texto},
            timeout=15
        )
        print("BAILEYS STATUS:", response.status_code, flush=True)
        print("BAILEYS RESPOSTA:", response.text, flush=True)
        return response.json()
    except Exception as e:
        print(f"Erro ao enviar mensagem via Baileys: {e}", flush=True)
        return None

def notificar_dona(nome_cliente, servico_nome, preco, data_hora_str, duracao_minutos, whatsapp_cliente):
    """
    Envia uma notificação para a dona do salão (Vanessa) informando o novo agendamento.
    """
    texto = (
        f"📋 *Novo Agendamento!*\n\n"
        f"👤 *Cliente:* {nome_cliente}\n"
        f"📞 *WhatsApp:* {whatsapp_cliente}\n"
        f"💇 *Serviço:* {servico_nome}\n"
        f"💰 *Valor:* R$ {preco:.2f}\n"
        f"📅 *Data/Hora:* {data_hora_str}\n"
        f"⏱️ *Duração:* {duracao_minutos} min\n\n"
        f"ℹ️ _Para consultar sua agenda, envie *agenda* ou *hoje* nesta conversa._"
    )

    try:
        response = requests.post(
            BAILEYS_URL,
            json={"telefone": NUMERO_DONA, "texto": texto},
            timeout=15
        )
        print("NOTIFICAÇÃO DONA STATUS:", response.status_code, flush=True)
        return response.json()
    except Exception as e:
        print(f"Erro ao notificar dona: {e}", flush=True)
        return None

# ============================================================================
# ROTAS PRINCIPAIS
# ============================================================================

@app.route('/')
def home():
    return render_template('home.html')

@app.route('/agendar')
def agendar_page():
    # Passamos o 'agora' para o HTML travar o calendário visualmente
    agora = datetime.now().strftime("%Y-%m-%d %H:%M")
    servicos_json = json.dumps(SERVICOS)
    return render_template('index.html', agora=agora, servicos_json=servicos_json)

# ============================================================================
# ENDPOINTS API
# ============================================================================

@app.route('/api/servicos')
def api_servicos():
    """Endpoint para buscar serviços disponíveis"""
    return jsonify(SERVICOS)

@app.route('/api/agendamentos')
def api_agendamentos():
    """Endpoint para buscar todos os agendamentos pendentes"""
    try:
        agendamentos = db.collection("agendamentos").where(
            "status", "==", "pendente"
        ).stream()
        lista = []
        for agendamento in agendamentos:
            dados = agendamento.to_dict()
            data_hora = dados.get("data_hora_inicio") or dados.get("data_hora")
            if data_hora:
                lista.append({
                    "data_hora_inicio": data_hora,
                    "duracao_minutos": dados.get("duracao_minutos", 30)
                })
        return jsonify(lista)
    except Exception as e:
        return jsonify({"erro": str(e)}), 500

@app.route('/api/agendamentos_por_data')
def api_agendamentos_por_data():
    """Endpoint para buscar agendamentos de uma data específica (usado pelo bot da Vanessa).
    Params: ?data=YYYY-MM-DD (se omitido, retorna os de hoje)
    """
    try:
        data_param = request.args.get('data', datetime.now().strftime('%Y-%m-%d'))

        agendamentos = db.collection("agendamentos").where(
            "status", "==", "pendente"
        ).stream()

        lista = []
        for agendamento in agendamentos:
            dados = agendamento.to_dict()
            data_hora = dados.get("data_hora_inicio") or dados.get("data_hora")
            if data_hora and data_hora.startswith(data_param):
                lista.append({
                    "nome": dados.get("nome", "—"),
                    "whatsapp": dados.get("whatsapp", "—"),
                    "servico_nome": dados.get("servico_nome", "—"),
                    "preco": dados.get("preco", 0),
                    "data_hora_inicio": data_hora,
                    "duracao_minutos": dados.get("duracao_minutos", 30)
                })

        # Ordena por horário
        lista.sort(key=lambda x: x["data_hora_inicio"])
        return jsonify(lista)
    except Exception as e:
        return jsonify({"erro": str(e)}), 500

@app.route('/api/proximos_agendamentos')
def api_proximos_agendamentos():
    """Endpoint que retorna os próximos 7 dias de agendamentos pendentes."""
    try:
        agora = datetime.now()
        limite = agora + timedelta(days=7)

        agendamentos = db.collection("agendamentos").where(
            "status", "==", "pendente"
        ).stream()

        lista = []
        for agendamento in agendamentos:
            dados = agendamento.to_dict()
            data_hora = dados.get("data_hora_inicio") or dados.get("data_hora")
            if data_hora:
                dt = datetime.strptime(data_hora, '%Y-%m-%d %H:%M')
                if agora <= dt <= limite:
                    lista.append({
                        "nome": dados.get("nome", "—"),
                        "whatsapp": dados.get("whatsapp", "—"),
                        "servico_nome": dados.get("servico_nome", "—"),
                        "preco": dados.get("preco", 0),
                        "data_hora_inicio": data_hora,
                        "duracao_minutos": dados.get("duracao_minutos", 30)
                    })

        lista.sort(key=lambda x: x["data_hora_inicio"])
        return jsonify(lista)
    except Exception as e:
        return jsonify({"erro": str(e)}), 500

# ============================================================================
# VERIFICAÇÃO DE CONFLITO DE HORÁRIO
# ============================================================================

def verificar_conflito_horario(data_hora_inicio_str, duracao_minutos):
    """
    Verifica se há conflito de SOBREPOSIÇÃO com agendamentos existentes.
    Retorna True se está disponível, False se há conflito.
    """
    try:
        dt_inicio = datetime.strptime(data_hora_inicio_str, '%Y-%m-%d %H:%M')
        dt_fim = dt_inicio + timedelta(minutes=duracao_minutos)

        agendamentos = db.collection("agendamentos").where(
            "status", "==", "pendente"
        ).stream()

        for agendamento in agendamentos:
            dados = agendamento.to_dict()
            data_hora = dados.get("data_hora_inicio") or dados.get("data_hora")
            if not data_hora:
                continue

            agend_inicio = datetime.strptime(data_hora, '%Y-%m-%d %H:%M')
            agend_duracao = dados.get("duracao_minutos", 30)
            agend_fim = agend_inicio + timedelta(minutes=agend_duracao)

            # Verifica sobreposição: novo intervalo NÃO deve sobrepor nenhum existente
            if not (dt_fim <= agend_inicio or dt_inicio >= agend_fim):
                return False  # CONFLITO DETECTADO

        return True  # SEM CONFLITO
    except Exception as e:
        print(f"Erro ao verificar horário: {e}")
        return False

# ============================================================================
# ROTA DE AGENDAMENTO (POST)
# ============================================================================

@app.route('/enviar_agendamento', methods=['POST'])
def enviar_agendamento():
    nome = request.form.get("nome")
    whatsapp_bruto = request.form.get("whatsapp")
    email = request.form.get("email", "")
    data_hora_str = request.form.get("data_hora")
    servico_id = request.form.get("servico_id")

    # 1. VALIDAÇÃO DO SERVIÇO
    if servico_id not in SERVICOS:
        return render_template('index.html', erro="❌ Serviço inválido! Escolha um serviço da lista.",
                             nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

    servico = SERVICOS[servico_id]
    duracao_minutos = servico["duracao_minutos"]
    preco = servico["preco"]

    # 2. LIMPEZA E VALIDAÇÃO DO WHATSAPP
    whatsapp_limpo = re.sub(r'\D', '', whatsapp_bruto)

    if not re.match(r'^[1-9]{2}9?\d{8}$', whatsapp_limpo):
        return render_template('index.html', erro="❌ Número Inválido! Use o formato: (XX) XXXX-XXXX ou (XX) 9 XXXX-XXXX (10 ou 11 dígitos)",
                             nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

    # 3. VALIDAÇÃO DE DATA E HORA
    try:
        dt_inicio = datetime.strptime(data_hora_str, '%Y-%m-%d %H:%M')
        dt_fim = dt_inicio + timedelta(minutes=duracao_minutos)
        agora = datetime.now()

        if dt_inicio < agora:
            return render_template('index.html', erro="❌ Erro: Não é possível agendar no passado.",
                                 nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

        # Validar que não é domingo (6 = domingo no Python)
        if dt_inicio.weekday() == 6:
            return render_template('index.html', erro="❌ Erro: O salão não funciona aos domingos. Atendemos de segunda a sábado.",
                                 nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

        # Validar que início está dentro do horário de funcionamento (9h-19h)
        if dt_inicio.hour < 9 or dt_inicio.hour >= 19:
            return render_template('index.html', erro="❌ Erro: O salão atende das 09:00 às 19:00. Escolha um horário dentro desse intervalo.",
                                 nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

        # Validar que FIM não ultrapassa 19h
        if dt_fim.hour > 19 or (dt_fim.hour == 19 and dt_fim.minute > 0):
            horas_minutos = f"{duracao_minutos // 60}h{duracao_minutos % 60}m" if duracao_minutos >= 60 else f"{duracao_minutos}m"
            return render_template('index.html', erro=f"❌ Erro: Serviço leva {horas_minutos}. Não cabe no horário 09:00-19:00 neste slot.",
                                 nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

        # Validar que incremento é de 30 minutos
        if dt_inicio.minute not in [0, 30]:
            return render_template('index.html', erro="❌ Erro: Escolha intervalos de 30 minutos (ex: 14:00 ou 14:30).",
                                 nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

        # 4. VERIFICAR DISPONIBILIDADE DO HORÁRIO (verificar sobreposição)
        if not verificar_conflito_horario(data_hora_str, duracao_minutos):
            horas_minutos = f"{duracao_minutos // 60}h{duracao_minutos % 60}m" if duracao_minutos >= 60 else f"{duracao_minutos}m"
            return render_template('index.html', erro=f"❌ Indisponível! Este slot está ocupado (necessário {horas_minutos} contínuos para {servico['nome']}). Escolha outro horário.",
                                 nome=nome, whatsapp=whatsapp_bruto, data_hora=data_hora_str, servicos_json=json.dumps(SERVICOS))

        # 5. SALVAR NO FIREBASE
        db.collection("agendamentos").add({
            "nome": nome,
            "whatsapp": f"+55{whatsapp_limpo}",
            "email": email,
            "servico_id": servico_id,
            "servico_nome": servico["nome"],
            "preco": preco,
            "data_hora_inicio": data_hora_str,
            "duracao_minutos": duracao_minutos,
            "status": "pendente",
            "criado_em": datetime.now()
        })

        # 6. ENVIO DE MENSAGEM VIA BAILEYS (microserviço Node.js)
        enviar_whatsapp_confirmacao(whatsapp_limpo, nome, servico["nome"], data_hora_str)

        # 7. NOTIFICAR A DONA DO SALÃO (Vanessa)
        notificar_dona(nome, servico["nome"], preco, data_hora_str, duracao_minutos, f"+55{whatsapp_limpo}")

        return render_template('sucesso.html', nome=nome, data=data_hora_str, servico=servico["nome"], duracao=duracao_minutos, preco=preco)

    except Exception as e:
        return f"❌ Erro ao processar: {e}", 500

# ============================================================================
# INICIALIZAÇÃO
# ============================================================================

if __name__ == '__main__':
    app.run(debug=True)
