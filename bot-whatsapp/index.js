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
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } from 'baileys';
import { useFirestoreAuthState } from './useFirestoreAuthState.js';
import admin from 'firebase-admin';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Proteção contra quedas do bot (Erros internos do WhatsApp/libsignal) ---
process.on('uncaughtException', (err) => { });
process.on('unhandledRejection', (reason, promise) => { });

// ============================================================================
// 🛡️ ESCUDO DE PRIVACIDADE DO TERMINAL
// ============================================================================
// Intercepta todos os logs do Node.js e bloqueia TUDO que não for do nosso bot.
// Isso impede que a biblioteca libsignal vaze mensagens privadas no terminal
// quando ocorrerem erros de criptografia.
const consoleLogOriginal = console.log;
const consoleErrorOriginal = console.error;
const consoleWarnOriginal = console.warn;

function filtroDePrivacidade(args, logFunction) {
    if (!args || args.length === 0) return logFunction(...args);
    const texto = String(args[0]);
    
    // Lista de prefixos que NÓS usamos nos nossos logs.
    // Qualquer coisa fora disso é lixo da biblioteca e será silenciado.
    const permitidos = ['✅', '🚀', '📱', '🔑', '🔗', '👉', '📤', '📨', '⚠️  Sessão', '🔄', '❌', 'Error:', 'SyntaxError:', 'TypeError:', ''];
    
    if (permitidos.some(prefixo => texto.startsWith(prefixo))) {
        logFunction(...args);
    }
}

console.log = (...args) => filtroDePrivacidade(args, consoleLogOriginal);
console.error = (...args) => filtroDePrivacidade(args, consoleErrorOriginal);
console.warn = (...args) => filtroDePrivacidade(args, consoleWarnOriginal);
// ============================================================================

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
const PORTA = parseInt(process.env.PORT || process.env.PORTA || '3001', 10);

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

    // ⚠️ SÓ DEVE RESPONDER SE A CONVERSA FOR O CHAT "VOCÊ" (ELA COM ELA MESMA)
    // Extrai o número do próprio celular que está conectado no bot
    const meuNumeroLocal = sock?.user?.id?.split(':')[0];
    
    // Se por acaso o socket ainda não carregou o user, cai fora por segurança
    if (!meuNumeroLocal) return;

    // Lista estrita: APENAS o chat dela com ela mesma é permitido para comandos.
    // O NUMERO_DONA do .env agora serve apenas para receber notificações do site, não para enviar comandos.
    const chatsPermitidos = [
        `${meuNumeroLocal}@s.whatsapp.net`
    ];

    // RETURN IMEDIATO: Se não for o chat com o próprio número dela, ignora.
    if (!chatsPermitidos.includes(mensagem.key.remoteJid)) {
        return; 
    }

    // Extrai o texto da mensagem
    const texto = mensagem.message?.conversation
        || mensagem.message?.extendedTextMessage?.text
        || '';

    if (!texto) return;

    const textoLower = texto.trim().toLowerCase();
    // Ignora as respostas do próprio bot
    if (texto.includes('🤖') || texto.includes('📋') || texto.includes('📭')) return;

    let resposta = null;
    let comandoValido = false;

    // --- Comando: AGENDA ou HOJE ---
    if (['agenda', 'hoje', 'marcações', 'marcacoes', 'agendamentos'].includes(textoLower)) {
        comandoValido = true;
        const hoje = getHoje();
        const agendamentos = await buscarAgendamentosPorData(hoje);
        const [ano, mes, dia] = hoje.split('-');
        resposta = formatarListaAgendamentos(agendamentos, `Agenda de Hoje (${dia}/${mes})`);
    }
    // --- Comando: AMANHÃ ---
    else if (['amanha', 'amanhã'].includes(textoLower)) {
        comandoValido = true;
        const amanha = getAmanha();
        const agendamentos = await buscarAgendamentosPorData(amanha);
        const [ano, mes, dia] = amanha.split('-');
        resposta = formatarListaAgendamentos(agendamentos, `Agenda de Amanhã (${dia}/${mes})`);
    }
    // --- Comando: SEMANA ---
    else if (['semana', 'próximos', 'proximos', 'próximos dias', 'proximos dias'].includes(textoLower)) {
        comandoValido = true;
        const agendamentos = await buscarProximosAgendamentos();
        resposta = formatarListaAgendamentos(agendamentos, 'Próximos 7 Dias');
    }
    // --- Comando: AJUDA ou MENU ---
    else if (['ajuda', 'menu', 'comandos', 'help', '?'].includes(textoLower)) {
        comandoValido = true;
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

    // Se gerou resposta, loga o comando que foi reconhecido e envia a resposta
    if (comandoValido) {
        console.log(`📨 Comando RECONHECIDO no chat privado: "${texto}"`);
        try {
            await sock.sendMessage(remetenteJid, { text: resposta });
            console.log(`📤 Resposta enviada com a agenda/menu`);
        } catch (erro) {
            console.error(`❌ Erro ao responder:`, erro.message);
        }
    }
}

// ============================================================================
// INICIALIZA FIREBASE ADMIN
// ============================================================================
// ============================================================================
// INICIALIZA FIREBASE ADMIN
// ============================================================================
let firebaseCreds;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        // Busca na raiz do projeto
        const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');
        if (fs.existsSync(serviceAccountPath)) {
            firebaseCreds = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        } else {
            consoleErrorOriginal('❌ ERRO: Arquivo serviceAccountKey.json não encontrado nem FIREBASE_CREDENTIALS configurada.');
            process.exit(1);
        }
    }
} catch (error) {
    consoleErrorOriginal('\n❌ ERRO CRÍTICO AO LER O JSON DO FIREBASE:');
    consoleErrorOriginal(error.message);
    consoleErrorOriginal('\nVerifique se você colou o JSON corretamente no Render, sem aspas a mais no começo ou no fim, e sem quebras de linha erradas.\n');
    process.exit(1);
}

try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseCreds)
        });
    }
} catch (error) {
    consoleErrorOriginal('\n❌ ERRO AO INICIALIZAR FIREBASE:');
    consoleErrorOriginal(error.message);
    process.exit(1);
}
const db = admin.firestore();

// ============================================================================
// FUNÇÃO PRINCIPAL: Inicializa a conexão Baileys com Pairing Code
// ============================================================================
async function iniciarBaileys() {
    // Carrega ou cria o estado de autenticação no Firebase Firestore
    const { state, saveCreds } = await useFirestoreAuthState(db, 'sessao_vanessa');
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
                console.log('⚠️  Sessão encerrada. Apagando credenciais do Firebase e reiniciando...');
                try {
                    await db.collection('whatsapp_sessions').doc('sessao_vanessa').collection('auth').doc('creds').delete();
                } catch(e) {}
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
