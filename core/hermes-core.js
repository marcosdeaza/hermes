#!/usr/bin/env node
/**
 * HERMES - Agente de Coding Autónomo
 * v1.2.0 - Audio (Groq Whisper) + Visión de imágenes + Estabilidad WS
 */

require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const winston = require('winston');

// ============================================
// CONFIGURACIÓN Y ESTADO GLOBAL
// ============================================

const CONFIG = {
  AI_KEY: process.env.AI_API_KEY,
  AI_URL: process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1',
  GROQ_KEY: process.env.GROQ_API_KEY,
  WHATSAPP_SESSION_PATH: process.env.WHATSAPP_SESSION_PATH || './.wwebjs_auth',
  PROJECTS_PATH: process.env.PROJECTS_PATH || './projects',
  LOG_PATH: process.env.LOG_PATH || './logs',
  MAX_OUTPUT_LENGTH: parseInt(process.env.MAX_OUTPUT_LENGTH) || 10000,
  MAX_ITERATIONS: parseInt(process.env.MAX_ITERATIONS) || 60,
  BASH_TIMEOUT: parseInt(process.env.BASH_TIMEOUT) || 120000,   // 2 min por comando bash
  CONTEXT_CHAR_BUDGET: parseInt(process.env.CONTEXT_CHAR_BUDGET) || 320000,
  TASK_TIMEOUT: parseInt(process.env.TASK_TIMEOUT) || 8 * 60 * 1000, // 8 min máx por tarea completa
  OWNER_FILE: './.owner_registered',
};

let CURRENT_MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4-5';
const conversationHistory = new Map();
let OWNER_NUMBER = process.env.OWNER_NUMBER || null;
let isFirstContact = !OWNER_NUMBER && !fs.existsSync(CONFIG.OWNER_FILE);

// ============================================
// LOGGING
// ============================================

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'hermes' },
  transports: [
    new winston.transports.File({ filename: path.join(CONFIG.LOG_PATH, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(CONFIG.LOG_PATH, 'combined.log') }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    })
  ],
});

// ============================================
// SEGURIDAD - OWNER
// ============================================

// Optionally pin your WhatsApp identities here (skips the first-contact flow).
// WhatsApp may deliver messages as a LID and/or a phone number, so add both.
// Format: '123456789@lid' or '34612345678@c.us'
const AUTHORIZED_IDENTITIES = new Set(
  (process.env.OWNER_NUMBER || '').split(',').map(s => s.trim()).filter(Boolean)
);

function loadRegisteredOwner() {
  try {
    if (fs.existsSync(CONFIG.OWNER_FILE)) {
      const data = fs.readFileSync(CONFIG.OWNER_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      OWNER_NUMBER = parsed.ownerNumber;
      isFirstContact = false;
      (parsed.identities || [parsed.ownerNumber]).filter(Boolean).forEach(id => AUTHORIZED_IDENTITIES.add(id));
      logger.info(`Dueño registrado cargado: ${OWNER_NUMBER}`);
      return true;
    }
  } catch (err) {
    logger.error('Error cargando dueño registrado:', err);
  }
  return false;
}

async function registerOwner(phoneNumber) {
  try {
    const data = { ownerNumber: phoneNumber, identities: [phoneNumber], registeredAt: new Date().toISOString(), version: '1.2.0' };
    await fs.writeJson(CONFIG.OWNER_FILE, data, { spaces: 2 });
    OWNER_NUMBER = phoneNumber;
    AUTHORIZED_IDENTITIES.add(phoneNumber);
    isFirstContact = false;
    logger.info(`NUEVO DUEÑO REGISTRADO: ${phoneNumber}`);
    return true;
  } catch (err) {
    logger.error('Error registrando dueño:', err);
    return false;
  }
}

function isAuthorized(number) {
  // Sin dueño y sin identidades fijadas → modo registro abierto (primer contacto manda)
  if (!OWNER_NUMBER && AUTHORIZED_IDENTITIES.size === 0) return true;
  return AUTHORIZED_IDENTITIES.has(number);
}

// ============================================
// TRANSCRIPCIÓN DE AUDIO - GROQ WHISPER
// ============================================

async function transcribeAudio(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const buffer = Buffer.from(media.data, 'base64');
    const tmpOgg = path.join(os.tmpdir(), `hermes_${Date.now()}.ogg`);
    const tmpMp3 = path.join(os.tmpdir(), `hermes_${Date.now()}.mp3`);
    await fs.writeFile(tmpOgg, buffer);

    // Convertir OGG/opus → MP3 con ffmpeg para máxima compatibilidad
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -y -i "${tmpOgg}" -ar 16000 -ac 1 -b:a 64k "${tmpMp3}"`, { timeout: 30000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpMp3), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    form.append('response_format', 'text');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: { 'Authorization': `Bearer ${CONFIG.GROQ_KEY}`, ...form.getHeaders() },
        timeout: 30000
      }
    );

    await fs.remove(tmpOgg).catch(() => {});
    await fs.remove(tmpMp3).catch(() => {});

    const text = typeof response.data === 'string' ? response.data : response.data.text;
    return text ? text.trim() : null;
  } catch (err) {
    logger.error('Error transcribiendo audio:', err.message);
    return null;
  }
}

// ============================================
// DESCARGA DE IMAGEN
// ============================================

async function downloadImage(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;
    return { data: media.data, mimetype: media.mimetype || 'image/jpeg' };
  } catch (err) {
    logger.error('Error descargando imagen:', err.message);
    return null;
  }
}

// ============================================
// HERRAMIENTAS DEL AGENTE
// ============================================

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Ejecuta un comando bash en el VPS y devuelve el resultado.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Comando bash a ejecutar.' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: 'Escribe contenido en un fichero del VPS.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['filepath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Lee el contenido de un fichero del VPS.',
      parameters: {
        type: 'object',
        properties: { filepath: { type: 'string' } },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: 'Lista archivos en un directorio.',
      parameters: {
        type: 'object',
        properties: { directory: { type: 'string' } },
        required: ['directory']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Busca información en internet vía DuckDuckGo.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deploy_project',
      description: 'Hace deploy de un proyecto Node.js con PM2 + Nginx.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string' },
          project_name: { type: 'string' },
          port: { type: 'number' },
          start_command: { type: 'string' }
        },
        required: ['project_path', 'project_name', 'port', 'start_command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_clone',
      description: 'Clona un repositorio de GitHub.',
      parameters: {
        type: 'object',
        properties: {
          repo_url: { type: 'string' },
          target_dir: { type: 'string' }
        },
        required: ['repo_url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Obtiene información del sistema (CPU, RAM, disco).',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// ============================================
// EJECUTORES DE HERRAMIENTAS
// ============================================

// Comandos destructivos del sistema
const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=/dev/zero',
  '> /dev/sda', 'mv / /dev/null', ':(){ :|:& };:',
  'chmod -R 777 /', 'halt', 'shutdown', 'reboot', 'poweroff',
];

// Lógica anti-suicidio: regex en vez de lista fija (cubre TODAS las variantes)
function isCommandBlocked(cmd) {
  const c = cmd.toLowerCase().trim();
  // 1. Destructivos del sistema
  if (BLOCKED_COMMANDS.some(b => c.includes(b.toLowerCase()))) return true;
  // 2. pm2 + subcomando destructivo — bloquea: pm2 delete all|0|hermes, pm2 stop all, pm2 kill, pm2 update...
  if (/\bpm2\b/.test(c) && /\b(delete|stop|kill|update|reload)\b/.test(c)) return true;
  // 3. killall/pkill de node o de todo
  if (/\b(killall|pkill)\b/.test(c) && /\b(node|hermes|all)\b/.test(c)) return true;
  // 4. systemctl parando hermes
  if (/\bsystemctl\b/.test(c) && /\b(stop|disable|kill)\b/.test(c) && /\bhermes\b/.test(c)) return true;
  return false;
}
function isPathBlocked(filepath) {
  return BLOCKED_PATHS.some(b => filepath.includes(b));
}

async function executeTool(name, args) {
  logger.info(`Ejecutando herramienta: ${name}`, args);

  switch (name) {
    case 'bash_exec': {
      if (isCommandBlocked(args.command)) return 'Comando bloqueado por seguridad';
      return new Promise((resolve) => {
        exec(args.command, { timeout: CONFIG.BASH_TIMEOUT, maxBuffer: 8 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
          let body = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (body.length > CONFIG.MAX_OUTPUT_LENGTH) body = body.substring(0, CONFIG.MAX_OUTPUT_LENGTH) + '\n...(truncado)';
          // Estado explícito para que el modelo sepa si funcionó o falló (evita bucles de reintento)
          let status;
          if (err) {
            if (err.killed && err.signal === 'SIGTERM') status = `[TIMEOUT tras ${CONFIG.BASH_TIMEOUT / 1000}s — el comando seguía corriendo]`;
            else status = `[FALLÓ exit ${err.code ?? '?'}]`;
          } else {
            status = '[OK exit 0]';
          }
          resolve(`${status}\n${body || '(sin output)'}`);
        });
      });
    }
    case 'file_write': {
      if (isPathBlocked(args.filepath)) return 'Ruta bloqueada por seguridad';
      try {
        await fs.ensureDir(path.dirname(args.filepath));
        await fs.writeFile(args.filepath, args.content, 'utf-8');
        return `Archivo escrito: ${args.filepath}`;
      } catch (err) { return `Error: ${err.message}`; }
    }
    case 'file_read': {
      if (isPathBlocked(args.filepath)) return 'Ruta bloqueada por seguridad';
      try {
        const content = await fs.readFile(args.filepath, 'utf-8');
        return content.length > CONFIG.MAX_OUTPUT_LENGTH ? content.substring(0, CONFIG.MAX_OUTPUT_LENGTH) + '\n...(truncado)' : content;
      } catch (err) { return `Error: ${err.message}`; }
    }
    case 'file_list': {
      try {
        const items = await fs.readdir(args.directory, { withFileTypes: true });
        return items.map(i => `${i.isDirectory() ? '[DIR]' : '[FILE]'} ${i.name}`).join('\n') || 'Vacío';
      } catch (err) { return `Error: ${err.message}`; }
    }
    case 'web_search': {
      try {
        const res = await axios.get(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`,
          { timeout: 10000 }
        );
        let results = res.data.Abstract ? res.data.Abstract + '\n\n' : '';
        if (res.data.RelatedTopics?.length) {
          results += 'Resultados:\n';
          res.data.RelatedTopics.slice(0, 5).forEach((t, i) => { if (t.Text) results += `${i + 1}. ${t.Text}\n`; });
        }
        return results || 'Sin resultados';
      } catch (err) { return 'Error en búsqueda'; }
    }
    case 'deploy_project': {
      try {
        if (!await fs.pathExists(args.project_path)) return `Proyecto no encontrado: ${args.project_path}`;
        const nginxConf = `server {\n    listen 80;\n    server_name ${args.project_name}.local;\n    location / {\n        proxy_pass http://localhost:${args.port};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection 'upgrade';\n        proxy_set_header Host $host;\n    }\n}`;
        const nginxPath = `/etc/nginx/sites-available/${args.project_name}`;
        await fs.writeFile(nginxPath, nginxConf);
        await new Promise((res, rej) => exec(`ln -sf ${nginxPath} /etc/nginx/sites-enabled/ && nginx -t && nginx -s reload`, (e, o) => e ? rej(e) : res(o)));
        await new Promise((res, rej) => exec(`cd ${args.project_path} && pm2 start ${args.start_command} --name ${args.project_name}`, (e, o) => e ? rej(e) : res(o)));
        await new Promise((res) => exec('pm2 save', res));
        return `Deploy completado: ${args.project_name} en puerto ${args.port}`;
      } catch (err) { return `Error deploy: ${err.message}`; }
    }
    case 'github_clone': {
      const target = args.target_dir || path.join(CONFIG.PROJECTS_PATH, path.basename(args.repo_url, '.git'));
      return new Promise((resolve) => {
        exec(`git clone ${args.repo_url} ${target}`, { timeout: 120000 }, (err) =>
          resolve(err ? `Error: ${err.message}` : `Clonado en: ${target}`)
        );
      });
    }
    case 'system_info': {
      return new Promise((resolve) => {
        exec('free -h && df -h / && uptime', (err, stdout) => resolve(stdout || 'Error obteniendo info'));
      });
    }
    default:
      return 'Herramienta no reconocida';
  }
}

// ============================================
// FORMATEO PARA WHATSAPP
// ============================================

function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  out = out.replace(/```[\w]*\n?([\s\S]*?)```/g, '```\n$1```');
  out = out.replace(/(?<!`)`([^`\n]+)`(?!`)/g, '"$1"');
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  out = out.replace(/__([^_\n]+?)__/g, '_$1_');
  out = out.replace(/~~([^~\n]+?)~~/g, '~$1~');
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  out = out.replace(/^[-*]\s+/gm, '• ');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  out = out.replace(/^---+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

// ============================================
// INTEGRACIÓN CON B.AI (kimi-k2.5 / glm-5.2)
// ============================================

async function callHermes(userMessage, userId, imageData = null) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);

  // Construir contenido del mensaje (texto o texto+imagen)
  let userContent;
  if (imageData) {
    userContent = [
      { type: 'image_url', image_url: { url: `data:${imageData.mimetype};base64,${imageData.data}` } },
      { type: 'text', text: userMessage }
    ];
  } else {
    userContent = userMessage;
  }

  history.push({ role: 'user', content: userContent });

  const systemPrompt = `Eres Hermes, un agente de coding autónomo y asistente personal que vive en un servidor Linux.

CAPACIDADES:
- Ejecutar comandos bash en el servidor
- Crear, leer y modificar archivos
- Buscar información en internet
- Clonar repositorios de GitHub
- Hacer deploy de proyectos con PM2 + Nginx
- Ver y analizar imágenes que te envíen
- Entender mensajes de voz transcritos

FORMATO WHATSAPP:
- Usa *texto* para negrita (un asterisco, NO dos)
- Usa _texto_ para cursiva
- Usa \`\`\`codigo\`\`\` para bloques de código
- Para listas usa • o números
- Respuestas concisas y legibles en móvil

COMPORTAMIENTO:
- Cuando el usuario te dé una idea, refínala, crea el código, súbelo al VPS y haz el deploy sin que te lo pidan explícitamente
- Directo, eficiente y proactivo
- Si puedes hacer algo en lugar de solo explicarlo, hazlo
- Responde siempre en español y de forma concisa
- Si una tarea requiere múltiples pasos, ejecutalos secuencialmente

SEGURIDAD:
- Solo respondes al dueño registrado
- No ejecutas comandos peligrosos`;

  let messages = [{ role: 'system', content: systemPrompt }, ...history];
  const maxIterations = CONFIG.MAX_ITERATIONS;
  let iterations = 0;
  let lastAssistantText = null;
  const taskDeadline = Date.now() + CONFIG.TASK_TIMEOUT;

  while (iterations < maxIterations) {
    iterations++;

    // Timeout total de tarea: corta el loop si llevamos más de TASK_TIMEOUT
    if (Date.now() > taskDeadline) {
      logger.warn(`[TIMEOUT] Tarea superó ${CONFIG.TASK_TIMEOUT / 60000} min.`);
      break;
    }

    // — Poda de contexto: evita que el loop reviente el context window (fallo silencioso) —
    messages = trimMessages(messages, CONFIG.CONTEXT_CHAR_BUDGET);

    let response;
    try {
      response = await axios.post(`${CONFIG.AI_URL}/chat/completions`, {
        model: CURRENT_MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096,
        temperature: 0.7
      }, {
        headers: { 'Authorization': `Bearer ${CONFIG.AI_KEY}`, 'Content-Type': 'application/json' },
        timeout: 120000
      });
    } catch (err) {
      const apiErr = err.response ? JSON.stringify(err.response.data) : (err.message || String(err));
      logger.error(`Error API (iter ${iterations}): ${apiErr}`);
      // Logging detallado para diagnóstico
      if (err.response?.data) logger.error('API response body:', JSON.stringify(err.response.data).substring(0, 500));
      if (err.response?.status) logger.error('API status code:', err.response.status);
      if (err.config?.url) logger.error('API endpoint:', err.config.url);

      // Context-length → poda agresiva y reintenta en vez de abortar
      if (/context|too long|maximum.*tokens|length/i.test(apiErr)) {
        messages = trimMessages(messages, Math.floor(CONFIG.CONTEXT_CHAR_BUDGET / 2));
        continue;
      }
      // Content policy violation → el historial contiene contenido que la API rechaza.
      // Limpiar historial y reintentar con contexto mínimo (system + último mensaje).
      if (err.response?.status === 400 || /content_policy_violation|moderation|harassment|policy/i.test(apiErr)) {
        logger.warn('[MODERACIÓN] Contenido rechazado por política. Limpiando historial y reintentando con contexto mínimo.');
        if (history.length > 0) history.splice(0, history.length);
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        messages = [{ role: 'system', content: systemPrompt }];
        if (lastUserMsg) messages.push(lastUserMsg);
        lastAssistantText = null;
        if (iterations < maxIterations) { await new Promise(r => setTimeout(r, 1500)); continue; }
        return '⚠️ La IA rechazó el contenido por políticas de uso. Reformula tu mensaje e inténtalo de nuevo.';
      }
      // Timeout / 5xx / red → reintento con espera
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.response?.status >= 500) {
        if (iterations < maxIterations) { await new Promise(r => setTimeout(r, 2500)); continue; }
      }
      // Rate limit
      if (err.response?.status === 429) {
        if (iterations < maxIterations) { await new Promise(r => setTimeout(r, 5000)); continue; }
        return '⚠️ Demasiadas peticiones a la IA. Espera un momento e intenta de nuevo.';
      }
      // Auth error
      if (err.response?.status === 401 || err.response?.status === 403) {
        logger.error('[AUTH] API key inválida o expirada.');
        return '❌ Error de autenticación con la IA. La API key puede estar expirada. Contacta al administrador.';
      }
      // Cualquier otro error → log completo y devolver texto parcial si existe
      logger.error('Error no clasificado API:', { status: err.response?.status, code: err.code, message: err.message });
      return lastAssistantText ? formatForWhatsApp(lastAssistantText) : null;
    }

    const msg = response.data.choices[0].message;
    messages.push(msg);
    if (msg.content) lastAssistantText = msg.content;

    // Sin tool_calls → respuesta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      history.push({ role: 'assistant', content: msg.content });
      if (history.length > 20) conversationHistory.set(userId, history.slice(-20));
      return formatForWhatsApp(msg.content);
    }

    // Ejecutar cada tool call de forma aislada: un fallo de UNA no mata toda la ejecución
    for (const toolCall of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        result = await executeTool(toolCall.function.name, args);
      } catch (e) {
        result = `Error ejecutando ${toolCall.function?.name}: ${e.message}. Revisa los argumentos e inténtalo de otra forma.`;
        logger.warn(`Tool ${toolCall.function?.name} falló: ${e.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: String(result).substring(0, 6000) });
    }
  }

  // Llegamos al tope: devolvemos el último texto útil, nunca un error vacío
  if (lastAssistantText) {
    history.push({ role: 'assistant', content: lastAssistantText });
    if (history.length > 20) conversationHistory.set(userId, history.slice(-20));
    return formatForWhatsApp(lastAssistantText);
  }
  return 'He hecho muchos pasos pero la tarea es muy grande. Dime el siguiente paso concreto y sigo desde donde lo dejé.';
}

// Poda segura de contexto: conserva system + primer mensaje de usuario (la tarea) y la cola
// más reciente que entre en el presupuesto, sin dejar mensajes 'tool' huérfanos (rompen la API).
function trimMessages(messages, maxChars) {
  const size = (m) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length) + 200;
  let total = messages.reduce((s, m) => s + size(m), 0);
  if (total <= maxChars) return messages;

  const system = messages[0];
  const firstUser = messages[1];
  let tail = messages.slice(2);
  let tailTotal = tail.reduce((s, m) => s + size(m), 0);
  const head = size(system) + (firstUser ? size(firstUser) : 0);

  // Quita los más antiguos de la cola hasta entrar en presupuesto
  while (tail.length && head + tailTotal > maxChars) {
    tailTotal -= size(tail[0]);
    tail.shift();
  }
  // No empezar la cola con un 'tool' huérfano (su 'assistant' con tool_calls se fue)
  while (tail.length && tail[0].role === 'tool') tail.shift();

  return [system, ...(firstUser ? [firstUser] : []), ...tail];
}

// ============================================
// CLIENTE WHATSAPP
// ============================================

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: CONFIG.WHATSAPP_SESSION_PATH }),
  puppeteer: {
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-features=site-per-process,IsolateOrigins',
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    headless: true,
    timeout: 60000
  }
});

// QR
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  logger.info('QR generado, esperando escaneo...');
  QRCode.toFile('/opt/hermes/qr-code.png', qr, { width: 500, margin: 2 }, (err) => {
    if (!err) logger.info('QR guardado como imagen en: /opt/hermes/qr-code.png');
  });
});

// Ready
client.on('ready', () => {
  console.log('\n============================================================');
  console.log('              HERMES v1.2.0 ONLINE');
  console.log('  Audio: Groq Whisper | Vision: kimi-k2.5/glm-5.2');
  console.log(`  Dueño: ${OWNER_NUMBER || 'pendiente'}`);
  console.log('============================================================\n');
  logger.info('Hermes listo y escuchando mensajes');
});

// ============================================
// MANEJADOR DE MENSAJES
// ============================================

const HANDLED_TYPES = ['chat', 'ptt', 'audio', 'image'];

client.on('message', async (msg) => {
  // Ignorar grupos y tipos no soportados
  if (msg.from.includes('@g.us') || !HANDLED_TYPES.includes(msg.type)) return;

  const sender = msg.from;

  // Registro de dueño
  if (isFirstContact && !OWNER_NUMBER) {
    const registered = await registerOwner(sender);
    if (registered) {
      await msg.reply(
        '*REGISTRO COMPLETADO*\n\nTu número ha sido registrado como ÚNICO DUEÑO de Hermes.\n\n' +
        '*Hermes v1.2.0 listo!*\n🎤 Envía audios → los transcribirá\n🖼️ Envía imágenes → las verá\n💻 Pídele código → lo despliega'
      );
      return;
    }
  }

  if (!isAuthorized(sender)) {
    logger.warn(`[SEGURIDAD] Acceso no autorizado: ${sender}`);
    return;
  }

  // Ack inmediato: confirma que el mensaje llegó aunque Hermes esté ocupado con otra tarea
  const isCmd = (msg.body || '').startsWith('!');
  if (!isCmd && msg.type === 'chat') {
    try { await msg.reply('_Procesando..._'); } catch (_) {}
  }

  let text = msg.body || '';
  let imageData = null;

  // — AUDIO / VOZ —
  if (msg.type === 'ptt' || msg.type === 'audio') {
    await msg.reply('🎤 _Transcribiendo audio..._');
    const transcription = await transcribeAudio(msg);
    if (transcription) {
      text = transcription;
      logger.info(`Audio transcrito de ${sender}: ${text.substring(0, 100)}`);
      await msg.reply(`_"${text}"_`);
    } else {
      await msg.reply('❌ No pude transcribir el audio. Intenta enviar texto.');
      return;
    }
  }

  // — IMAGEN —
  if (msg.type === 'image') {
    imageData = await downloadImage(msg);
    if (!imageData) {
      await msg.reply('❌ No pude procesar la imagen.');
      return;
    }
    text = msg.body || 'Analiza esta imagen y actúa según sea necesario.';
    logger.info(`Imagen recibida de ${sender}: ${text.substring(0, 50)}`);
  }

  // Comandos especiales
  if (text.startsWith('!modelo')) {
    const model = text.split(' ')[1]?.toLowerCase();
    if (model) { CURRENT_MODEL = model; await msg.reply(`Modelo → ${CURRENT_MODEL}`); }
    else await msg.reply(`Modelo actual: ${CURRENT_MODEL}\nUso: !modelo <model-id>\nEj: !modelo anthropic/claude-sonnet-4-5`);
    return;
  }
  if (text === '!reset') { conversationHistory.delete(sender); await msg.reply('Historial limpiado'); return; }
  if (text === '!status') {
    const info = await executeTool('system_info', {});
    await msg.reply(`*Estado del Sistema*\n\n${info}\n\nModelo: ${CURRENT_MODEL}`);
    return;
  }
  if (text === '!help' || text === '!ayuda') {
    await msg.reply(
      '*HERMES v1.2.0*\n\n' +
      '🎤 *Audio*: envía notas de voz, las transcribe y responde\n' +
      '🖼️ *Imágenes*: envía fotos, las analiza y actúa\n' +
      '💻 *Código*: crea, despliega y gestiona proyectos\n\n' +
      '*Comandos*:\n!modelo <model-id> — cambia modelo en runtime\n!reset — limpia el historial\n!status — info del servidor\n!help — este menú\n\n' +
      `Modelo actual: ${CURRENT_MODEL}`
    );
    return;
  }
  if (!text.trim()) return;

  logger.info(`Mensaje de ${sender}: ${text.substring(0, 80)}`);

  // Llamada a la IA
  try {
    const response = await callHermes(text, sender, imageData);
    if (!response) return;

    const MAX_LENGTH = 4000;
    if (response.length > MAX_LENGTH) {
      const chunks = [];
      for (let i = 0; i < response.length; i += MAX_LENGTH) chunks.push(response.substring(i, i + MAX_LENGTH));
      for (let i = 0; i < chunks.length; i++) {
        await msg.reply((i === 0 ? '' : `Parte ${i + 1}/${chunks.length}\n\n`) + chunks[i]);
      }
    } else {
      await msg.reply(response);
    }
  } catch (err) {
    logger.error('Error procesando mensaje:', err);
  }
});

// Auth failure
client.on('auth_failure', (msg) => {
  logger.error('Error de autenticación:', msg);
});

// Desconexión: destroy + reinicio con delay
client.on('disconnected', async (reason) => {
  logger.warn('Cliente desconectado:', reason);
  console.log('\nWhatsApp desconectado. Reconectando en 5s...\n');
  try { await client.destroy(); } catch (_) {}
  setTimeout(() => client.initialize(), 5000);
});

// Watchdog: cada 3 min verifica que Puppeteer/Chrome sigue activo
setInterval(async () => {
  try {
    const state = await Promise.race([
      client.getState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
    ]);
    if (state && !['CONNECTED', 'OPENING', 'PAIRING'].includes(state)) {
      logger.warn(`[WATCHDOG] Estado: ${state}. Reiniciando...`);
      try { await client.destroy(); } catch (_) {}
      setTimeout(() => client.initialize(), 3000);
    }
  } catch (e) {
    logger.warn(`[WATCHDOG] Puppeteer no responde (${e.message}). Reiniciando...`);
    try { await client.destroy(); } catch (_) {}
    setTimeout(() => client.initialize(), 3000);
  }
}, 3 * 60 * 1000);

// ============================================
// INICIALIZACIÓN
// ============================================

loadRegisteredOwner();

async function initialize() {
  await fs.ensureDir(CONFIG.LOG_PATH);
  await fs.ensureDir(CONFIG.PROJECTS_PATH);
  await fs.ensureDir(CONFIG.WHATSAPP_SESSION_PATH);

  logger.info('========================================');
  logger.info('INICIANDO HERMES v1.2.0');
  logger.info('========================================');
  logger.info(OWNER_NUMBER ? `Dueño: ${OWNER_NUMBER}` : 'Modo registro: esperando primer contacto');

  client.initialize();
}

process.on('SIGINT', async () => { logger.info('SIGINT recibido'); await client.destroy(); process.exit(0); });
process.on('SIGTERM', async () => { logger.info('SIGTERM recibido'); await client.destroy(); process.exit(0); });

initialize();
