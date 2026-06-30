const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
} = require('@whiskeysockets/baileys');
const { arslanmd } = require('./lib/system');
const config = require('./config');
const events = require('./arslan');
const { sms } = require('./lib/msg');
const {
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const moment = require('moment-timezone');

const prefix = config.PREFIX;
const mode = config.MODE || config.WORK_TYPE;
const router = express.Router();

connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();

function createarslanStore() {
    const store = {
        messages: {},
        bind(ev) {
            ev.on('messages.upsert', ({ messages }) => {
                for (const msg of messages) {
                    const jid = msg.key && msg.key.remoteJid;
                    if (!jid) continue;
                    if (!store.messages[jid]) store.messages[jid] = [];
                    store.messages[jid].push(msg);
                    if (store.messages[jid].length > 200) store.messages[jid].shift();
                }
            });
        },
        async loadMessage(jid, id) {
            if (!store.messages[jid]) return null;
            return store.messages[jid].find(m => m.key && m.key.id === id) || null;
        }
    };
    return store;
}

const createSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0, size);

const getGroupAdmins = (participants) => {
    let admins = [];
    for (let i of participants) {
        if (i.admin == null) continue;
        admins.push(i.id);
    }
    return admins;
};

function isNumberAlreadyConnected(number) {
    return activeSockets.has(number.replace(/[^0-9]/g, ''));
}

function getConnectionStatus(number) {
    const n = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(n);
    const connectionTime = socketCreationTime.get(n);
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

function arslanLog(message, type = 'info') {
    const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️', debug: '🐛' };
    console.log(`${icons[type] || '📝'} [ARSLAN-MD] ${new Date().toISOString()}: ${message}`);
}

const pluginsDir = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
const pluginFiles = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
arslanLog(`Loading ${pluginFiles.length} plugins...`, 'info');
for (const file of pluginFiles) {
    try { require(path.join(pluginsDir, file)); }
    catch (e) { arslanLog(`Failed to load plugin ${file}: ${e.message}`, 'error'); }
}

async function setupCallHandlers(socket, number) {
    socket.ev.on('call', async (calls) => {
        try {
            const userConfig = await getUserConfigFromMongoDB(number);
            if (userConfig.ANTI_CALL !== 'true') return;
            for (const call of calls) {
                if (call.status !== 'offer') continue;
                await socket.rejectCall(call.id, call.from);
                await socket.sendMessage(call.from, { text: userConfig.REJECT_MSG || config.REJECT_MSG });
                arslanLog(`Auto-rejected call for ${number} from ${call.from}`, 'info');
            }
        } catch (err) {
            arslanLog(`Anti-call error for ${number}: ${err.message}`, 'error');
        }
    });
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 3;

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            arslanLog(`Connection closed for ${number}: ${statusCode} - ${errorMessage}`, 'warning');

            if (statusCode === 401 || (errorMessage && errorMessage.includes('401'))) {
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                socket.ev.removeAllListeners();
                return;
            }

            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                arslanLog(`Reconnecting ${number} (${restartAttempts}/${maxRestartAttempts}) in 10s...`, 'warning');
                await delay(10000);
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes, setHeader: () => {}, json: () => {} };
                    await arslanPair(number, mockRes);
                } catch (e) { arslanLog(`Reconnection failed for ${number}: ${e.message}`, 'error'); }
            }
        }
        if (connection === 'open') { restartAttempts = 0; }
    });
}

async function arslanPair(number, res = null) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        const sessionPath = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
        const existingSession = await getSessionFromMongoDB(sanitizedNumber);
        if (!existingSession) {
            arslanLog(`No MongoDB session for ${sanitizedNumber} — new pairing required`, 'info');
            if (fs.existsSync(sessionPath)) await fs.remove(sessionPath);
        } else {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(existingSession, null, 2));
            arslanLog(`🔄 Restored session from MongoDB for ${sanitizedNumber}`, 'success');
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const conn = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ['Mac OS', 'Safari', '10.15.7']
        });

        activeSockets.set(sanitizedNumber, conn);
        setupCallHandlers(conn, number);
        setupAutoRestart(conn, number);

        if (!conn.authState.creds.registered) {
            arslanLog(`🔐 Starting NEW pairing process for ${sanitizedNumber}`, 'info');
            await delay(1500);
            const code = await conn.requestPairingCode(sanitizedNumber);
            if (res && !res.headersSent) res.send({ code, status: 'new_pairing' });
        } else {
            if (res && !res.headersSent) res.json({ status: 'reconnecting' });
        }

        conn.ev.on('creds.update', async () => {
            await saveCreds();
            const creds = JSON.parse(await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8'));
            await saveSessionToMongoDB(sanitizedNumber, creds);
        });

        conn.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await addNumberToMongoDB(sanitizedNumber);
                arslanLog(`Connected: ${sanitizedNumber}`, 'success');
            }
        });
    } catch (err) {
        arslanLog(`Pairing error: ${err.message}`, 'error');
        if (res && !res.headersSent) res.status(500).json({ error: "Pairing failed" });
    }
}

// ==========================================
// PAIRING CODE ROUTE
// ==========================================
router.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "Number is required" });
    try {
        await arslanPair(number, res);
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;
