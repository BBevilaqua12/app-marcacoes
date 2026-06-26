// ============================================================================
// 🟢 MICROSERVIÇO WHATSAPP COM BAILEYS (DEPLOY CLOUD/RENDER)
// ============================================================================

import 'dotenv/config';
import express from 'express';
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } from 'baileys';
import { useFirestoreAuthState } from './useFirestoreAuthState.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Proteção contra quedas do bot (Erros internos) ---
process.on('uncaughtException', (err) => { 
    if (typeof consoleErrorOriginal === 'function') consoleErrorOriginal('❌ Uncaught Exception:', err);
    else console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => { 
    if (typeof consoleErrorOriginal === 'function') consoleErrorOriginal('❌ Unhandled Rejection:', reason);
    else console.error('❌ Unhandled Rejection:', reason);
});

// ============================================================================
// 🛡️ ESCUDO DE PRIVACIDADE DO TERMINAL
// ============================================================================
const consoleLogOriginal = console.log;
const consoleErrorOriginal = console.error;
const consoleWarnOriginal = console.warn;

function filtroDePrivacidade(args, logFunction) {
    if (!args || args.length === 0) return logFunction(...args);
    const texto = String(args[0]);
    
    // Lista de prefixos que NÓS usamos nos nossos logs.
    const permitidos = ['✅', '🚀', '📱', '🔑', '🔗', '👉', '📤', '📨', '⚠️  Sessão', '🔄', '❌', 'Error:', 'SyntaxError:', 'TypeError:', ''];
    
    if (permitidos.some(prefixo => texto.startsWith(prefixo))) {
        logFunction(...args);
    }
}

console.log = (...args) => filtroDePrivacidade(args, consoleLogOriginal);
console.error = (...args) => filtroDePrivacidade(args, consoleErrorOriginal);
console.warn = (...args) => filtroDePrivacidade(args, consoleWarnOriginal);

// --- Configuração de Diretórios ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Logger silencioso ---
const logger = pino({ level: 'silent' });

// --- Variável global do socket ---
let sock = null;
let conectado = false;

// ============================================================================
// 🔐 VARIÁVEIS DE AMBIENTE (carregadas do .env)
// ============================================================================

const NUMERO_DONA = process.env.NUMERO_DONA || '';
const FLASK_API_URL = process.env.FLASK_API_URL || 'http://localhost:5000';
// Garante o PORT do Render, com fallback para PORTA ou 3001
const PORTA = parseInt(process.env.PORT || process.env.PORTA || '3001', 10);

const JID_DONA = NUMERO_DONA + '@s.whatsapp.net';

// ============================================================================
// FUNÇÕES AUXILIARES DE CONSULTA À AGENDA
// ============================================================================

async function buscarAgendamentosPorData(data) {
    try {
        const response = await fetch(`${FLASK_API_URL}/api/agendamentos_por_data?data=${data}`);
        if (response.ok) return await response.json();
        return [];
    } catch (erro) {
        consoleErrorOriginal('❌ Erro ao buscar agendamentos por data:', erro.message);
        return [];
    }
}

async function buscarProximosAgendamentos() {
    try {
        const response = await fetch(`${FLASK_API_URL}/api/proximos_agendamentos`);
        if (response.ok) return await response.json();
        return [];
    } catch (erro) {
        consoleErrorOriginal('❌ Erro ao buscar próximos agendamentos:', erro.message);
        return [];
    }
}

function formatarListaAgendamentos(agendamentos, titulo) {
    if (agendamentos.length === 0) return `📭 *${titulo}*\n\nNenhum agendamento encontrado.`;

    let texto = `📋 *${titulo}*\n━━━━━━━━━━━━━━━━━\n\n`;
    agendamentos.forEach((a, index) => {
        const partes = a.data_hora_inicio.split(' ');
        const [ano, mes, dia] = partes[0].split('-');
        texto += `*${index + 1}.* ⏰ ${partes[1]} (${dia}/${mes})\n   👤 ${a.nome}\n   💇 ${a.servico_nome}\n   💰 R$ ${a.preco.toFixed(2)}\n   📞 ${a.whatsapp}\n   ⏱️ ${a.duracao_minutos} min\n\n`;
    });
    texto += `━━━━━━━━━━━━━━━━━\n📊 *Total:* ${agendamentos.length} agendamento(s)`;
    return texto;
}

function getAmanha() {
    const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0];
}
function getHoje() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================================
// HANDLER DE MENSAGENS RECEBIDAS
// ============================================================================

async function processarMensagemRecebida(mensagem) {
    if (mensagem.key.remoteJid.includes('@g.us') || mensagem.key.remoteJid === 'status@broadcast') return;

    const meuNumeroLocal = sock?.user?.id?.split(':')[0];
    if (!meuNumeroLocal) return;

    const chatsPermitidos = [`${meuNumeroLocal}@s.whatsapp.net`];
    if (!chatsPermitidos.includes(mensagem.key.remoteJid)) return;

    const texto = (mensagem.message?.conversation || mensagem.message?.extendedTextMessage?.text || '').trim();
    if (!texto) return;

    const textoLower = texto.toLowerCase();
    if (texto.includes('🤖') || texto.includes('📋') || texto.includes('📭')) return;

    let resposta = null;
    let comandoValido = false;

    if (['agenda', 'hoje', 'marcações', 'marcacoes', 'agendamentos'].includes(textoLower)) {
        comandoValido = true;
        const hoje = getHoje();
        const agendamentos = await buscarAgendamentosPorData(hoje);
        const [ano, mes, dia] = hoje.split('-');
        resposta = formatarListaAgendamentos(agendamentos, `Agenda de Hoje (${dia}/${mes})`);
    } else if (['amanha', 'amanhã'].includes(textoLower)) {
        comandoValido = true;
        const amanha = getAmanha();
        const agendamentos = await buscarAgendamentosPorData(amanha);
        const [ano, mes, dia] = amanha.split('-');
        resposta = formatarListaAgendamentos(agendamentos, `Agenda de Amanhã (${dia}/${mes})`);
    } else if (['semana', 'próximos', 'proximos', 'próximos dias', 'proximos dias'].includes(textoLower)) {
        comandoValido = true;
        const agendamentos = await buscarProximosAgendamentos();
        resposta = formatarListaAgendamentos(agendamentos, 'Próximos 7 Dias');
    } else if (['ajuda', 'menu', 'comandos', 'help', '?'].includes(textoLower)) {
        comandoValido = true;
        resposta = `🤖 *Comandos Disponíveis*\n━━━━━━━━━━━━━━━━━\n\n📅 *hoje* ou *agenda* → Agendamentos de hoje\n📅 *amanhã* → Agendamentos de amanhã\n📅 *semana* → Próximos 7 dias\n❓ *ajuda* → Mostra este menu\n\n━━━━━━━━━━━━━━━━━\n_As notificações de novos agendamentos chegam automaticamente aqui!_ ✨`;
    }

    if (comandoValido && resposta) {
        consoleLogOriginal(`📨 Comando RECONHECIDO no chat privado: "${texto}"`);
        try {
            await sock.sendMessage(mensagem.key.remoteJid, { text: resposta });
            consoleLogOriginal(`📤 Resposta enviada com a agenda/menu`);
        } catch (erro) {
            consoleErrorOriginal(`❌ Erro ao responder:`, erro.message);
        }
    }
}

// ============================================================================
// INICIALIZA FIREBASE ADMIN
// ============================================================================

let firebaseCreds;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        // Se a string contiver quebras de linha com problema, tenta corrigir formatando ou avisando
        firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');
        if (fs.existsSync(serviceAccountPath)) {
            firebaseCreds = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        } else {
            consoleErrorOriginal('❌ ERRO FATAL: Variável FIREBASE_CREDENTIALS não encontrada no Render, e arquivo local também não existe!');
            consoleErrorOriginal('👉 Crie a variável FIREBASE_CREDENTIALS no Dashboard do Render e cole o conteúdo do serviceAccountKey.json nela.');
            process.exit(1);
        }
    }
} catch (error) {
    consoleErrorOriginal('\n❌ ERRO CRÍTICO AO LER O JSON DO FIREBASE NO RENDER:');
    consoleErrorOriginal('Detalhe Técnico:', error.message);
    consoleErrorOriginal('\n👉 DICA: O problema está no conteúdo que você colou na variável FIREBASE_CREDENTIALS.');
    consoleErrorOriginal('Certifique-se de copiar todo o conteúdo do serviceAccountKey.json, sem aspas extras no início ou no fim, e colar como uma única string.');
    process.exit(1);
}

try {
    if (getApps().length === 0) {
        initializeApp({
            credential: cert(firebaseCreds)
        });
    }
} catch (error) {
    consoleErrorOriginal('\n❌ ERRO AO CONECTAR COM O BANCO DE DADOS DO FIREBASE:');
    consoleErrorOriginal(error.message);
    process.exit(1);
}

const db = getFirestore();

// ============================================================================
// FUNÇÃO PRINCIPAL
// ============================================================================

async function iniciarBaileys() {
    const { state, saveCreds } = await useFirestoreAuthState(db, 'sessao_vanessa');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            conectado = false;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            if (reason === DisconnectReason.loggedOut) {
                consoleLogOriginal('⚠️  Sessão encerrada (loggedOut). Apagando credenciais antigas do Firebase...');
                try {
                    await db.collection('whatsapp_sessions').doc('sessao_vanessa').collection('auth').doc('creds').delete();
                } catch(e) {}
                await iniciarBaileys();
            } else {
                consoleLogOriginal(`🔄 Desconectado (razão: ${reason}). Reconectando em 5s...`);
                setTimeout(iniciarBaileys, 5000);
            }
        }

        if (connection === 'open') {
            conectado = true;
            consoleLogOriginal('\n✅ ========================================');
            consoleLogOriginal('✅  WHATSAPP CONECTADO COM SUCESSO (FIREBASE)!');
            consoleLogOriginal('✅  Pronto para receber e enviar mensagens');
            consoleLogOriginal('✅ ========================================\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
            await processarMensagemRecebida(msg);
        }
    });

    if (!state.creds.registered) {
        consoleLogOriginal('\n🔑 ========================================');
        consoleLogOriginal('🔑  PAREAMENTO NECESSÁRIO!');
        consoleLogOriginal(`🔑  Para o número: ${NUMERO_DONA || 'NÃO CONFIGURADO'}`);
        consoleLogOriginal('🔑 ========================================\n');

        if (!NUMERO_DONA) {
            consoleErrorOriginal('❌ ERRO: Variável NUMERO_DONA não foi definida! Impossível gerar código de pareamento.');
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
        
        try {
            const code = await sock.requestPairingCode(NUMERO_DONA);
            consoleLogOriginal('\n🔗 ========================================');
            consoleLogOriginal(`🔗  CÓDIGO DE PAREAMENTO: ${code}`);
            consoleLogOriginal('🔗 ========================================\n');
            consoleLogOriginal('👉 Abra o WhatsApp no celular:');
            consoleLogOriginal('   Configurações > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone');
        } catch (e) {
            consoleErrorOriginal(`❌ Erro ao solicitar código de pareamento: ${e.message}`);
        }
    }
}

// ============================================================================
// FUNÇÃO DE ENVIO HTTP -> WHATSAPP
// ============================================================================

async function enviarMensagem(telefone, texto) {
    if (!sock || !conectado) throw new Error('WhatsApp não está conectado.');
    
    let numero = telefone.replace(/\D/g, '');
    if (!numero.startsWith('55')) numero = '55' + numero;
    
    const jid = numero + '@s.whatsapp.net';
    const resultado = await sock.sendMessage(jid, { text: texto });
    consoleLogOriginal(`📤 Mensagem enviada para ${numero}`);
    return { sucesso: true, id: resultado?.key?.id };
}

// ============================================================================
// SERVIDOR HTTP EXPRESS (Render Web Service)
// ============================================================================

const app = express();
app.use(express.json());

app.post('/enviar', async (req, res) => {
    const { telefone, texto } = req.body;
    if (!telefone || !texto) return res.status(400).json({ sucesso: false, erro: 'Parâmetros "telefone" e "texto" são obrigatórios.' });

    try {
        const resultado = await enviarMensagem(telefone, texto);
        return res.json(resultado);
    } catch (erro) {
        consoleErrorOriginal(`❌ Erro HTTP /enviar para ${telefone}:`, erro.message);
        return res.status(500).json({ sucesso: false, erro: erro.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ conectado, timestamp: new Date().toISOString() });
});

// Apenas escutamos em $PORT ou local (para o Render)
app.listen(PORTA, '0.0.0.0', async () => {
    consoleLogOriginal(`\n🚀 Servidor Baileys (API WhatsApp) rodando na porta ${PORTA}`);
    consoleLogOriginal(`   Flask API apontada para → ${FLASK_API_URL}`);
    consoleLogOriginal(`   Ouvindo comandos de    → ${NUMERO_DONA}\n`);
    await iniciarBaileys();
});
