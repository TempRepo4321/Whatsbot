/*
 * aiService.js — wrapper OpenRouter / OpenAI / Gemini pour le chatbot IA
 * intégré à DazBot.
 *
 * Porté depuis dazbot-1/Chat-Bot-Dazi (src/services/openaiService.js) :
 *   - Compatibilité OpenRouter, OpenAI ET Gemini (Gemini expose un endpoint
 *     OpenAI-compatible : /v1beta/openai/chat/completions). Même code pour
 *     les 3 providers, seule la baseURL + l'auth change.
 *   - Historique par conversation en mémoire (Map, bornée par
 *     aiMaxContextMessages).
 *   - Prompt système = personality.json (systemPrompt + description +
 *     examples).
 *   - Pas de Supabase (volontairement retiré : on garde DazBot simple).
 *
 * Dépendances : axios (déjà présent dans package.json).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PERSONALITY_PATH = path.resolve(__dirname, 'personality.json');

function normalizeConversationId(conversationId) {
    const raw = String(conversationId || '').trim();
    if (!raw) return 'default';
    return raw.split(':').map((segment) => segment.replace(/@lid$/i, '@s.whatsapp.net')).join(':');
}

// Charge personality.json et retourne un objet avec les différents modes
// de personnalité supportés. `default` = Daziano standard, `romantic` =
// mode copine (mots doux, ton affectueux). On accepte aussi l'ancienne
// forme ({ personality: {...} }) pour rétro-compatibilité : elle est
// mappée sur `default`.
function loadPersonality() {
    const empty = { systemPrompt: '', description: '', examples: [] };
    try {
        const raw = fs.readFileSync(PERSONALITY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const pickMode = (src) => ({
            systemPrompt: src?.systemPrompt || '',
            description: src?.description || '',
            examples: Array.isArray(src?.examples) ? src.examples : [],
        });
        // Forme v2 : { personalities: { default: {...}, romantic: {...} } }
        if (parsed.personalities && typeof parsed.personalities === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(parsed.personalities)) out[k] = pickMode(v);
            if (!out.default) out.default = { ...empty };
            return out;
        }
        // Forme v1 (rétro-compat) : { personality: {...}, romantic: {...}? }
        const modes = { default: pickMode(parsed.personality || parsed) };
        if (parsed.romantic) modes.romantic = pickMode(parsed.romantic);
        return modes;
    } catch (e) {
        return { default: { ...empty } };
    }
}

class AIService {
    // opts.sharedHistory : Map partagée entre instances (permet de conserver
    // le contexte conversationnel quand on bascule sur un provider de fallback).
    constructor(config, opts = {}) {
        this.config = config;
        this._sharedHistory = opts.sharedHistory || null;
        // Défaut = 'gemini' pour rester cohérent avec envKeyForProvider() côté
        // index.js (message d'erreur qui dit "ajoute GEMINI_API_KEY"). Avant
        // c'était 'openrouter' → incohérence signalée par Devin Review.
        const provider = (config.aiProvider || 'gemini').toLowerCase();

        if (provider === 'gemini') {
            const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
            if (!apiKey) {
                throw new Error('GEMINI_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            // Gemini expose un endpoint compatible OpenAI : même schema
            // /chat/completions, donc on réutilise le même code que pour
            // OpenRouter / OpenAI.
            this.baseURL = process.env.GEMINI_BASE_URL
                || 'https://generativelanguage.googleapis.com/v1beta/openai';
            this.extraHeaders = {};
            this.provider = 'gemini';
        } else if (provider === 'groq') {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) {
                throw new Error('GROQ_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            // Groq expose un endpoint OpenAI-compat : /openai/v1/chat/completions
            this.baseURL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
            this.extraHeaders = {};
            this.provider = 'groq';
        } else if (provider === 'cerebras') {
            const apiKey = process.env.CEREBRAS_API_KEY;
            if (!apiKey) {
                throw new Error('CEREBRAS_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1';
            this.extraHeaders = {};
            this.provider = 'cerebras';
        } else if (provider === 'openrouter') {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
                throw new Error('OPENROUTER_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
            this.extraHeaders = {
                'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://github.com/dazbot-1/DazBot',
                'X-Title': process.env.OPENROUTER_X_TITLE || 'DazBot',
            };
            this.provider = 'openrouter';
        } else if (provider === 'haoduomi') {
            const apiKey = process.env.API_KEY;
            if (!apiKey) {
                throw new Error('API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = process.env.HAODUOMI_BASE_URL || 'https://api.lk888.ai/api/v1';
            this.extraHeaders = {};
            this.provider = 'haoduomi';
        } else if (provider === 'mercury') {
            const apiKey = process.env.INCEPTION_API_KEY || process.env.MERCURY_API_KEY || process.env.API_KEY;
            if (!apiKey) {
                throw new Error('INCEPTION_API_KEY / MERCURY_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = process.env.MERCURY_BASE_URL || 'https://api.inceptionlabs.ai/v1';
            this.extraHeaders = {};
            this.provider = 'mercury';
        } else {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error('OPENAI_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = 'https://api.openai.com/v1';
            this.extraHeaders = {};
            const project = process.env.OPENAI_PROJECT_ID;
            const organization = process.env.OPENAI_ORG_ID;
            if (project) this.extraHeaders['OpenAI-Project'] = project;
            if (organization) this.extraHeaders['OpenAI-Organization'] = organization;
            this.provider = 'openai';
        }

        // Historique par conversation : Map<conversationId, [{role, content}]>
        // Si un `sharedHistory` a été fourni par le host, on l'utilise pour que
        // tous les providers d'un pool voient le même contexte → la bascule de
        // fallback ne casse pas la continuité conversationnelle.
        this.history = this._sharedHistory || new Map();
        this.personality = loadPersonality();
    }

    reloadPersonality() {
        this.personality = loadPersonality();
    }

    // `mode` : 'default' (Daziano standard) ou 'romantic' (copine, mots doux).
    // Fallback automatique sur 'default' si un mode demandé n'est pas défini
    // dans personality.json — comme ça un personality.json simple qui ne
    // contient que la section standard ne casse rien.
    _buildSystemMessages(mode) {
        const requested = mode && this.personality[mode] ? mode : 'default';
        const p = this.personality[requested] || { systemPrompt: '', description: '', examples: [] };
        const { systemPrompt, description, examples } = p;
        const exampleLines = (examples || []).map(
            (ex) => `Utilisateur: "${ex.user}" → Toi: "${ex.assistant}"`,
        );
        const content = [
            systemPrompt,
            '',
            description,
            '',
            'Règles strictes :',
            '- Réponds en français naturel, court et cohérent.',
            '- Tu dois suivre le contexte de la conversation.',
            '- Si l’utilisateur pose une question simple, réponds directement.',
            '- Si la dernière question fait référence à un élément précédent, utilise ce contexte.',
            '- Évite les réponses vagues, absurdes ou complètement déconnectées.',
            '- Si tu ne sais pas, dis-le simplement sans inventer.',
            '',
            'Exemples de style :',
            exampleLines.join('\n'),
        ].join('\n');
        return [{ role: 'system', content }];
    }

    _currentModel() {
        if (this.config.aiModel) return this.config.aiModel;
        if (this.provider === 'gemini') return 'gemini-2.5-flash-lite';
        if (this.provider === 'groq') return 'llama-3.3-70b-versatile';
        if (this.provider === 'cerebras') return 'gpt-oss-120b';
        if (this.provider === 'openrouter') return 'openai/gpt-4o-mini';
        if (this.provider === 'mercury') return 'mercury-2';
        return 'gpt-4o-mini';
    }

    // opts.mode : personnalité à utiliser ('default' | 'romantic'). Par défaut
    // 'default'. Le mode n'influence que le prompt système ; l'historique
    // conversationnel reste partagé, donc si tu changes un contact de mode,
    // le nouveau ton prend effet tout de suite sans perdre le contexte.
    async generateReply(conversationId, incomingMessage, opts = {}) {
        const mode = opts.mode || 'default';
        const maxContextMessages = Number(this.config.aiMaxContextMessages || 10);
        const normalizedConversationId = normalizeConversationId(conversationId);

        // On enregistre immédiatement le message utilisateur dans l'historique
        // pour éviter de perdre le fil de conversation lorsqu'un provider
        // échoue ou rate limite la requête.
        let history = [...(this.history.get(normalizedConversationId) || [])];
        history.push({ role: 'user', content: incomingMessage });

        const maxEntries = maxContextMessages * 2;
        if (history.length > maxEntries) history = history.slice(-maxEntries);
        this.history.set(normalizedConversationId, history);

        const messages = [...this._buildSystemMessages(mode), ...history];

        const url = `${this.baseURL}/chat/completions`;
        const body = {
            model: this._currentModel(),
            messages,
            temperature: this.provider === 'mercury' ? 0.75 : 0.3,
            max_tokens: this.provider === 'mercury' ? 8192 : 220,
        };
        if (this.provider === 'mercury') {
            body.reasoning_effort = process.env.MERCURY_REASONING_EFFORT || 'medium';
        }
        // presence_penalty / frequency_penalty ne sont pas supportés par
        // l'endpoint OpenAI-compat de Gemini ni par Cerebras (HTTP 400).
        // Groq les accepte mais on reste défensif : on ne les met que pour
        // OpenRouter / OpenAI qui les gèrent correctement.
        if (this.provider === 'openrouter' || this.provider === 'openai') {
            body.presence_penalty = 0.3;
            body.frequency_penalty = 0.3;
        }

        // Retry sur 429 / 503 (surcharge provider, surtout Gemini free tier
        // qui renvoie "This model is currently experiencing high demand"
        // ~30-50% du temps). Backoff exponentiel : 1s, 2s, 4s. On ne retry
        // PAS 401/402/403 (erreurs persistantes, re-essayer ne sert à rien).
        const RETRYABLE = new Set([429, 503]);
        const MAX_ATTEMPTS = 3;
        let lastErr = null;
        try {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    const resp = await axios.post(url, body, {
                        headers: {
                            Authorization: `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            ...this.extraHeaders,
                        },
                        timeout: 30000,
                    });

                    const reply = resp?.data?.choices?.[0]?.message?.content?.trim();
                    if (!reply) throw new Error('Réponse IA vide.');

                    history.push({ role: 'assistant', content: reply });
                    this.history.set(normalizedConversationId, history);
                    return reply;
                } catch (err) {
                    lastErr = err;
                    const status = err?.response?.status;
                    if (!RETRYABLE.has(status) || attempt === MAX_ATTEMPTS) throw err;
                    const waitMs = 1000 * Math.pow(2, attempt - 1);
                    console.log(`[AI] Retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs}ms (status ${status}).`);
                    await new Promise((r) => setTimeout(r, waitMs));
                }
            }
            throw lastErr;
        } catch (err) {
            const status = err?.response?.status;
            const code = err?.code;
            const detail = err?.response?.data?.error?.message || err?.message;
            console.error(
                '[AI] Erreur requête :',
                [status ? `status=${status}` : null, code ? `code=${code}` : null, detail]
                    .filter(Boolean)
                    .join(' '),
            );
            const e = new Error(detail || 'AI request failed');
            e.status = status;
            e.code = code;
            e.aiError = true;
            throw e;
        }
    }

    clearHistory(conversationId) {
        if (conversationId) {
            this.history.delete(conversationId);
        } else {
            this.history.clear();
        }
    }

    // Supprime toutes les entrées d'historique dont la clé commence par le
    // préfixe donné. Utile pour les groupes : l'historique y est stocké sous
    // `${groupJid}:${participantJid}` — un simple `clearHistory(groupJid)` ne
    // matcherait aucune clé. `clearHistoryByPrefix(groupJid + ':')` (ou juste
    // `groupJid`) efface tous les threads du groupe d'un coup.
    clearHistoryByPrefix(prefix) {
        if (!prefix) return 0;
        let count = 0;
        for (const key of this.history.keys()) {
            if (key === prefix || key.startsWith(prefix + ':')) {
                this.history.delete(key);
                count++;
            }
        }
        return count;
    }

    getStats() {
        const totalMessages = Array.from(this.history.values()).reduce(
            (acc, h) => acc + h.length,
            0,
        );
        return {
            provider: this.provider,
            model: this._currentModel(),
            activeConversations: this.history.size,
            totalMessages,
        };
    }
}

module.exports = AIService;
