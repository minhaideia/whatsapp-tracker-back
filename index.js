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
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version } = await fetchLatestBaileysVersion();

        connectionStatus = 'connecting';
        console.log('Iniciando conexão com WhatsApp...');

        sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: true,
            browser: ['WhatsApp Tracker', 'Chrome', '10.0'],
            connectTimeoutMs: 60000,
            qrTimeout: 40000,
            defaultQueryTimeoutMs: 60000,
            syncFullHistory: false,
            keepAliveIntervalMs: 10000,
            patchMessageBeforeSending: msg => {
                const requiresPatch = !!(
                    msg.buttonsMessage || 
                    msg.listMessage || 
                    msg.templateMessage
                );
                if (requiresPatch) {
                    msg = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {},
                                },
                                ...msg,
                            },
                        },
                    };
                }
                return msg;
            }
        });

        // Melhorar o tratamento de eventos de conexão
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log('Status de conexão:', connection);
            
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('Conexão fechada. Código:', statusCode);
                
                if (shouldReconnect) {
                    console.log('Tentando reconectar...');
                    setTimeout(() => {
                        startBot();
                    }, 5000); // Aguarda 5 segundos antes de tentar reconectar
                } else {
                    console.log('Desconectado permanentemente. Não tentará reconectar.');
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
    } catch (error) {
        console.error('Erro ao iniciar o bot:', error);
        setTimeout(() => {
            startBot();
        }, 5000); // Aguarda 5 segundos antes de tentar reconectar
    }
}

// Adicionar manipulação global de erros mais robusta
process.on('uncaughtException', (err) => {
    console.error('Erro não tratado:', err);
    
    // Registra o erro nos logs
    logEvent(`ERRO: ${err.message}`);
    
    // Se o erro for crítico, tenta reiniciar o processo de conexão
    try {
        console.log('Tentando reiniciar após erro crítico...');
        setTimeout(() => {
            if (sock) {
                try {
                    sock.logout();
                } catch (logoutErr) {
                    console.error('Erro ao tentar desconectar após erro:', logoutErr);
                }
            }
            
            setTimeout(() => {
                startBot();
            }, 5000);
        }, 3000);
    } catch (restartError) {
        console.error('Falha ao tentar reiniciar após erro:', restartError);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promessa rejeitada não tratada:', reason);
    
    // Registra o erro nos logs
    logEvent(`ERRO PROMESSA: ${reason}`);
});

// Adicionar tratamento para saída limpa
process.on('SIGTERM', () => {
    console.log('Recebido SIGTERM. Encerrando graciosamente...');
    if (sock) {
        try {
            sock.logout();
        } catch (error) {
            console.error('Erro ao desconectar no encerramento:', error);
        }
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Recebido SIGINT. Encerrando graciosamente...');
    if (sock) {
        try {
            sock.logout();
        } catch (error) {
            console.error('Erro ao desconectar no encerramento:', error);
        }
    }
    process.exit(0);
});

// Função para verificar o estado do bot periodicamente
function setupConnectionCheck() {
    // Contador para tentativas de reconexão
    let stuckTimeCounter = 0;
    
    setInterval(() => {
        // Verifica se o processo está travado em 'connecting'
        if (connectionStatus === 'connecting') {
            stuckTimeCounter += 1;
            console.log(`Estado 'connecting' por ${stuckTimeCounter * 30} segundos`);
            
            // Se estiver preso por mais de 2 minutos (4 checagens), tenta reiniciar
            if (stuckTimeCounter >= 4 && !currentQR) {
                console.log('Conexão presa no estado "connecting". Forçando reinício...');
                
                // Forçar desconexão e reinicialização
                if (sock) {
                    try {
                        sock.logout();
                    } catch (error) {
                        console.error('Erro ao tentar desconectar:', error);
                    }
                }
                
                setTimeout(() => {
                    startBot();
                }, 3000);
                
                // Reinicia o contador
                stuckTimeCounter = 0;
            }
        } else {
            // Reinicia o contador se não estiver mais em connecting
            stuckTimeCounter = 0;
        }
        
        // Ping para manter o servidor ativo no Railway
        try {
            console.log(`Verificação periódica: ${new Date().toISOString()} - Status: ${connectionStatus}`);
        } catch (error) {
            console.error('Erro na verificação periódica:', error);
        }
    }, 30000); // Verifica a cada 30 segundos
}

startBot();
setupConnectionCheck();

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
        console.log('Solicitação de desconexão recebida');
        
        // Primeiro tentar logout se estiver conectado
        if (sock) {
            try {
                console.log('Tentando logout do WhatsApp...');
                await sock.logout();
                console.log('Logout bem-sucedido');
            } catch (logoutError) {
                console.error('Erro no logout:', logoutError);
                // Continua mesmo com erro
            }
        }
        
        // Remover os arquivos de autenticação
        console.log('Removendo arquivos de autenticação...');
        await fs.remove('auth_info');
        console.log('Arquivos de autenticação removidos');
        
        // Limpar variáveis de estado
        currentQR = null;
        monitoringNumber = null;
        onlineSince = null;
        connectionStatus = 'disconnected';
        
        // Responder ao cliente antes de reiniciar
        res.status(200).json({ 
            success: true, 
            message: 'Sessão desconectada. O serviço será reiniciado.' 
        });
        
        // Aguardar um pouco para garantir que a resposta seja enviada
        setTimeout(() => {
            console.log('Reiniciando serviço após desconexão...');
            
            // Reiniciar o processo de conexão em vez de encerrar o servidor
            startBot();
            
            // Se isso falhar, então forçamos a saída como último recurso
            setTimeout(() => {
                console.log('Forçando reinício do servidor...');
                process.exit(0); // Código 0 para indicar saída normal (sem erro)
            }, 5000);
        }, 2000);
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

// Adicionar endpoint para reconexão
app.post('/reconectar', async (req, res) => {
    try {
        console.log('Solicitação de reconexão recebida');
        
        // Tentar desconectar se estiver conectado
        if (sock) {
            try {
                console.log('Tentando desconectar antes de reconectar...');
                await sock.logout();
            } catch (error) {
                console.error('Erro ao desconectar:', error);
                // Continua mesmo se der erro
            }
        }
        
        // Limpar QR
        currentQR = null;
        connectionStatus = 'disconnected';
        
        res.status(200).json({ 
            success: true, 
            message: 'Reconexão iniciada.' 
        });
        
        // Iniciar reconexão
        setTimeout(() => {
            console.log('Iniciando reconexão...');
            startBot();
        }, 1000);
    } catch (error) {
        console.error('Erro ao reconectar:', error);
        res.status(500).json({ success: false, message: 'Erro ao tentar reconectar.' });
    }
});

// Endpoint para limpar apenas o QR code (força a geração de um novo QR)
app.post('/resetqr', async (req, res) => {
    try {
        console.log('Solicitação para resetar QR code');
        currentQR = null;
        
        res.status(200).json({
            success: true,
            message: 'QR code resetado. Um novo QR será gerado quando disponível.'
        });
    } catch (error) {
        console.error('Erro ao resetar QR:', error);
        res.status(500).json({ success: false, message: 'Erro ao resetar QR code.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});