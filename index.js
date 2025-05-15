const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs-extra');

const app = express();
const cors = require('cors');

// Universal CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(cors());
app.use(express.json());

let sock;
let monitoringNumber = null;
let onlineSince = null;
const dataFile = './logs.json';

let currentQR = null;

// Variável para rastrear estado da conexão
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'connected'

const logEvent = (event) => {
    const logs = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile)) : [];
    logs.push({ timestamp: new Date(), event });
    fs.writeFileSync(dataFile, JSON.stringify(logs, null, 2));
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    connectionStatus = 'connecting';
    console.log('Iniciando conexão com WhatsApp...');

    sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            connectionStatus = 'connecting';
            console.log('QR atualizado');
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            currentQR = null;
            console.log('Conectado ao WhatsApp!');
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startBot();
            }
        }
    });

    // Salvar credenciais quando atualizar
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('presence.update', (update) => {
        if (!monitoringNumber) return;
        if (update.id.includes(monitoringNumber)) {
            if (update.presences) {
                Object.values(update.presences).forEach((presence) => {
                    if (presence.lastKnownPresence === 'available') {
                        if (!onlineSince) {
                            onlineSince = Date.now();
                            logEvent(`ONLINE - ${monitoringNumber}`);
                            console.log(`${monitoringNumber} ficou ONLINE`);
                        }
                    } else {
                        if (onlineSince) {
                            const duration = Math.floor((Date.now() - onlineSince) / 1000);
                            logEvent(`OFFLINE - ${monitoringNumber} - ficou online por ${duration} segundos`);
                            console.log(`${monitoringNumber} ficou OFFLINE após ${duration} segundos`);
                            onlineSince = null;
                        }
                    }
                });
            }
        }
    });
}

startBot();

app.post('/monitorar', (req, res) => {
    monitoringNumber = req.body.numero;
    if (!monitoringNumber.endsWith('@s.whatsapp.net')) {
        monitoringNumber = `${monitoringNumber.replace(/\D/g, '')}@s.whatsapp.net`;
    }
    res.send(`Monitorando o número: ${monitoringNumber}`);
});

app.get('/logs', (req, res) => {
    if (fs.existsSync(dataFile)) {
        res.json(JSON.parse(fs.readFileSync(dataFile)));
    } else {
        res.json([]);
    }
});

app.get('/qrcode', (req, res) => {
    if (currentQR) {
        res.json({ qr: currentQR });
    } else {
        res.status(404).json({ message: 'QR code não disponível. Já conectado ou não inicializado.' });
    }
});

app.post('/desconectar', async (req, res) => {
    try {
        // Remover os arquivos de autenticação
        await fs.remove('auth_info');
        
        // Limpar variáveis de estado
        currentQR = null;
        monitoringNumber = null;
        onlineSince = null;
        
        // Responder ao cliente antes de reiniciar
        res.status(200).json({ success: true, message: 'Sessão desconectada. O serviço será reiniciado.' });
        
        // Aguardar um pouco para garantir que a resposta seja enviada
        setTimeout(() => {
            console.log('Reiniciando serviço após desconexão');
            process.exit(0); // Código 0 para indicar saída normal (sem erro)
        }, 1000);
    } catch (error) {
        console.error('Erro ao desconectar:', error);
        res.status(500).json({ success: false, message: 'Erro ao tentar desconectar.' });
    }
});

app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        monitoringNumber: monitoringNumber || null,
        hasQrCode: !!currentQR
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});