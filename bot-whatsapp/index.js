// ============================================================================
// 🟢 MICROSERVIÇO WHATSAPP COM BAILEYS
// ============================================================================
// Roda LOCALMENTE no PC da dona do salão.
// Todas as credenciais sensíveis vêm do arquivo .env (via process.env).
//
// Funcionalidades:
// 1. Recebe chamadas HTTP do Flask (Render) para enviar mensagens ao cliente
// 2. Escuta mensagens da dona para consultar agenda via comandos
// 3. Notifica a dona automaticamente a cada novo agendamento
// ============================================================================

import 'dotenv/config';
import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from 'baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Configuração de Diretórios ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PASTA_SESSAO = path.join(__dirname, 'sessao_whatsapp');

// --- Logger silencioso (para não poluir o terminal) ---
const logger = pino({ level: 'silent' });

// --- Variável global do socket ---
let sock = null;
let conectado = false;

// ============================================================================
// 🔐 VARIÁVEIS DE AMBIENTE (carregadas do .env)
// ============================================================================

const NUMERO_DONA = process.env.NUMERO_DONA || '';
const FLASK_API_URL = process.env.FLASK_API_URL || 'http://localhost:5000';
const PORTA = parseInt(process.env.PORTA || '3001', 10);

// JID formatado para o WhatsApp
const JID_DONA = NUMERO_DONA + '@s.whatsapp.net';

// ============================================================================
// FUNÇÕES AUXILIARES DE CONSULTA À AGENDA
// ============================================================================

/**
 * Busca agendamentos por data na API Flask.
 * @param {string} data - Data no formato YYYY-MM-DD
 * @returns {Promise<Array>} Lista de agendamentos
 */
async function buscarAgendamentosPorData(data) {
    try {
        const response = await fetch(`${FLASK_API_URL}/api/agendamentos_por_data?data=${data}`);
        if (response.ok) {
            return await response.json();
        }
        return [];
    } catch (erro) {
        console.error('❌ Erro ao buscar agendamentos por data:', erro.message);
        return [];
    }
}

/**
 * Busca os próximos 7 dias de agendamentos na API Flask.
 * @returns {Promise<Array>} Lista de agendamentos
 */
async function buscarProximosAgendamentos() {
    try {
        const response = await fetch(`${FLASK_API_URL}/api/proximos_agendamentos`);
        if (response.ok) {
            return await response.json();
        }
        return [];
    } catch (erro) {
        console.error('❌ Erro ao buscar próximos agendamentos:', erro.message);
        return [];
    }
}

/**
 * Formata a lista de agendamentos em texto legível para WhatsApp.
 * @param {Array} agendamentos
 * @param {string} titulo
 * @returns {string}
 */
function formatarListaAgendamentos(agendamentos, titulo) {
    if (agendamentos.length === 0) {
        return `📭 *${titulo}*\n\nNenhum agendamento encontrado.`;
    }

    let texto = `📋 *${titulo}*\n`;
    texto += `━━━━━━━━━━━━━━━━━\n\n`;

    agendamentos.forEach((a, index) => {
        // Extrai hora do formato "YYYY-MM-DD HH:MM"
        const partes = a.data_hora_inicio.split(' ');
        const data = partes[0]; // YYYY-MM-DD
        const hora = partes[1]; // HH:MM

        // Formata data para DD/MM
        const [ano, mes, dia] = data.split('-');
        const dataFormatada = `${dia}/${mes}`;

        texto += `*${index + 1}.* ⏰ ${hora} (${dataFormatada})\n`;
        texto += `   👤 ${a.nome}\n`;
        texto += `   💇 ${a.servico_nome}\n`;
        texto += `   💰 R$ ${a.preco.toFixed(2)}\n`;
        texto += `   📞 ${a.whatsapp}\n`;
        texto += `   ⏱️ ${a.duracao_minutos} min\n\n`;
    });

    texto += `━━━━━━━━━━━━━━━━━\n`;
    texto += `📊 *Total:* ${agendamentos.length} agendamento(s)`;

    return texto;
}

/**
 * Retorna a data de amanhã no formato YYYY-MM-DD.
 */
function getAmanha() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
}

/**
 * Retorna a data de hoje no formato YYYY-MM-DD.
 */
function getHoje() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================================
// HANDLER DE MENSAGENS RECEBIDAS (Consultas da Dona)
// ============================================================================

async function processarMensagemRecebida(mensagem) {
    // Ignora grupos e status
    if (mensagem.key.remoteJid.includes('@g.us')) return;
    if (mensagem.key.remoteJid === 'status@broadcast') return;

    // Extrai o número da conversa (remoteJid)
    const remetenteJid = mensagem.key.remoteJid;
    // Tira o sufixo para ter apenas o número
    const numeroConversa = remetenteJid.split('@')[0].split(':')[0];

    // ⚠️ SÓ DEVE RESPONDER SE A CONVERSA FOR COM ELA MESMA (CHAT "VOCÊ")
    // Aceita o número dela ou o identificador interno (LID) gerado pelo próprio celular
    const isLidInterno = remetenteJid.includes('@lid') && mensagem.key.fromMe;
    const isNumeroDela = numeroConversa === NUMERO_DONA || numeroConversa === (sock?.user?.id?.split(':')[0]);

    if (!isLidInterno && !isNumeroDela) {
        return; // Ignora silenciosamente mensagens trocadas com clientes
    }

    // Extrai o texto da mensagem
    const texto = mensagem.message?.conversation
        || mensagem.message?.extendedTextMessage?.text
        || '';

    if (!texto) return;

    const textoLower = texto.trim().toLowerCase();
    
    // Ignora as respostas do próprio bot (para não entrar em loop caso o texto bata com algum comando sem querer)
    // Se a mensagem contiver o emoji de robô ou os menus, ignora.
    if (texto.includes('🤖') || texto.includes('📋') || texto.includes('📭')) return;

    console.log(`📨 Comando recebido no chat da dona: "${texto}"`);

    let resposta = null;

    // --- Comando: AGENDA ou HOJE ---
    if (['agenda', 'hoje', 'marcações', 'marcacoes', 'agendamentos'].includes(textoLower)) {
        const hoje = getHoje();
        const agendamentos = await buscarAgendamentosPorData(hoje);
        const [ano, mes, dia] = hoje.split('-');
        resposta = formatarListaAgendamentos(agendamentos, `Agenda de Hoje (${dia}/${mes})`);
    }
    // --- Comando: AMANHÃ ---
    else if (['amanha', 'amanhã'].includes(textoLower)) {
        const amanha = getAmanha();
        const agendamentos = await buscarAgendamentosPorData(amanha);
        const [ano, mes, dia] = amanha.split('-');
        resposta = formatarListaAgendamentos(agendamentos, `Agenda de Amanhã (${dia}/${mes})`);
    }
    // --- Comando: SEMANA ---
    else if (['semana', 'próximos', 'proximos', 'próximos dias', 'proximos dias'].includes(textoLower)) {
        const agendamentos = await buscarProximosAgendamentos();
        resposta = formatarListaAgendamentos(agendamentos, 'Próximos 7 Dias');
    }
    // --- Comando: AJUDA ou MENU ---
    else if (['ajuda', 'menu', 'comandos', 'help', '?'].includes(textoLower)) {
        resposta = (
            `🤖 *Comandos Disponíveis*\n`
            + `━━━━━━━━━━━━━━━━━\n\n`
            + `📅 *hoje* ou *agenda* → Agendamentos de hoje\n`
            + `📅 *amanhã* → Agendamentos de amanhã\n`
            + `📅 *semana* → Próximos 7 dias\n`
            + `❓ *ajuda* → Mostra este menu\n\n`
            + `━━━━━━━━━━━━━━━━━\n`
            + `_As notificações de novos agendamentos chegam automaticamente aqui!_ ✨`
        );
    }

    // Se gerou resposta, envia
    if (resposta) {
        try {
            await sock.sendMessage(remetenteJid, { text: resposta });
            console.log(`📤 Resposta enviada para a dona`);
        } catch (erro) {
            console.error(`❌ Erro ao responder a dona:`, erro.message);
        }
    }
}

// ============================================================================
// FUNÇÃO PRINCIPAL: Inicializa a conexão Baileys com Pairing Code
// ============================================================================
async function iniciarBaileys() {
    // Carrega ou cria o estado de autenticação na pasta 'sessao_whatsapp'
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,      // ❌ Desabilita QR Code no terminal
        browser: Browsers.windows('Chrome'),  // ✅ Browser padrão reconhecido pelo WhatsApp
    });

    // --- Salvar credenciais sempre que forem atualizadas ---
    sock.ev.on('creds.update', saveCreds);

    // --- Gerenciamento de conexão ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'close') {
            conectado = false;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            if (reason === DisconnectReason.loggedOut) {
                console.log('⚠️  Sessão encerrada. Apagando credenciais e reiniciando...');
                // Remove a pasta de sessão para forçar novo pareamento
                fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
                await iniciarBaileys();
            } else {
                console.log(`🔄 Desconectado (razão: ${reason}). Reconectando em 5s...`);
                setTimeout(iniciarBaileys, 5000);
            }
        }

        if (connection === 'open') {
            conectado = true;
            console.log('');
            console.log('✅ ========================================');
            console.log('✅  WHATSAPP CONECTADO COM SUCESSO!');
            console.log('✅  Listener de mensagens ATIVO');
            console.log('✅ ========================================');
            console.log('');
        }
    });

    // --- Listener de mensagens recebidas ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Mensagens recebidas de outros são 'notify'. Mensagens do próprio celular vêm como 'append'.
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            await processarMensagemRecebida(msg);
        }
    });

    // --- Se não há sessão salva, parear automaticamente ---
    if (!state.creds.registered) {
        console.log('');
        console.log('🔑 ========================================');
        console.log('🔑  PAREAMENTO NECESSÁRIO');
        console.log(`🔑  Número: ${NUMERO_DONA}`);
        console.log('🔑 ========================================');
        console.log('');

        // Aguarda 3 segundos para o socket estar pronto antes de solicitar o código
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Solicita o código de pareamento ao WhatsApp
        const code = await sock.requestPairingCode(NUMERO_DONA);
        console.log('');
        console.log('🔗 ========================================');
        console.log(`🔗  CÓDIGO DE PAREAMENTO: ${code}`);
        console.log('🔗 ========================================');
        console.log('');
        console.log('👉 Abra o WhatsApp no celular:');
        console.log('   Configurações > Aparelhos conectados > Conectar aparelho');
        console.log('   Selecione "Conectar com número de telefone"');
        console.log(`   Digite o código: ${code}`);
        console.log('');
    }
}

// ============================================================================
// FUNÇÃO DE ENVIO: enviarMensagem(telefone, texto)
// ============================================================================
async function enviarMensagem(telefone, texto) {
    if (!sock || !conectado) {
        throw new Error('WhatsApp não está conectado. Aguarde a conexão.');
    }

    // Limpa o número: remove tudo que não é dígito
    let numero = telefone.replace(/\D/g, '');

    // Garante que o número tenha o DDI do Brasil (55)
    if (!numero.startsWith('55')) {
        numero = '55' + numero;
    }

    // Formata para JID do WhatsApp (numero@s.whatsapp.net)
    const jid = numero + '@s.whatsapp.net';

    try {
        const resultado = await sock.sendMessage(jid, { text: texto });
        console.log(`📤 Mensagem enviada para ${numero}`);
        return { sucesso: true, id: resultado?.key?.id };
    } catch (erro) {
        console.error(`❌ Erro ao enviar para ${numero}:`, erro.message);
        throw erro;
    }
}

// ============================================================================
// SERVIDOR HTTP EXPRESS (para receber chamadas do Flask/Render)
// ============================================================================
const app = express();
app.use(express.json());

// Endpoint de envio de mensagem
app.post('/enviar', async (req, res) => {
    const { telefone, texto } = req.body;

    if (!telefone || !texto) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Parâmetros "telefone" e "texto" são obrigatórios.'
        });
    }

    try {
        const resultado = await enviarMensagem(telefone, texto);
        return res.json(resultado);
    } catch (erro) {
        return res.status(500).json({
            sucesso: false,
            erro: erro.message
        });
    }
});

// Endpoint de status (para verificar se está conectado)
app.get('/status', (req, res) => {
    res.json({ conectado, timestamp: new Date().toISOString() });
});

// --- Inicialização ---
app.listen(PORTA, async () => {
    console.log('');
    console.log(`🚀 Servidor Baileys rodando em http://localhost:${PORTA}`);
    console.log(`   POST /enviar  → { "telefone": "11999998888", "texto": "Olá!" }`);
    console.log(`   GET  /status  → Verifica se o WhatsApp está conectado`);
    console.log(`   Flask API     → ${FLASK_API_URL}`);
    console.log('');
    console.log('📱 Comandos da dona via WhatsApp:');
    console.log('   "hoje" / "agenda"  → Agendamentos de hoje');
    console.log('   "amanhã"           → Agendamentos de amanhã');
    console.log('   "semana"           → Próximos 7 dias');
    console.log('   "ajuda"            → Lista de comandos');
    console.log('');

    // Inicia a conexão Baileys
    await iniciarBaileys();
});
