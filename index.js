const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs-extra');

const app = express();
app.use(express.json());

let sock;
let monitoringNumber = null;
let onlineSince = null;
const dataFile = './logs.json';

let currentQR = null;

const logEvent = (event) => {
    const logs = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile)) : [];
    logs.push({ timestamp: new Date(), event });
    fs.writeFileSync(dataFile, JSON.stringify(logs, null, 2));
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            console.log('QR atualizado');
        }

        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startBot();
            }
        }
    });

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
        await fs.remove('auth_info');
        currentQR = null;
        res.send('Sessão desconectada. Reinicie o serviço para gerar novo QR code.');
        process.exit(1); // Força reinício no Railway após limpar a sessão
    } catch (error) {
        console.error('Erro ao desconectar:', error);
        res.status(500).send('Erro ao tentar desconectar.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});