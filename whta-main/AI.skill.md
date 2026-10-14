---
description: Documentation du module IA et de l'API de configuration pour david.
globs:
- "**/*.js"
- "**/*.md"
---

# david - Module IA et API de configuration

## Objectif
Ce document décrit les nouvelles capacités IA ajoutées au bot :
- configuration IA runtime via API HTTP
- persistance de la configuration IA dans `ai-config.json`
- commande WhatsApp pour choisir le modèle IA
- commandes de gestion des providers et du reload de personnalité

## Commandes IA disponibles

- `?davai on` : active l'auto-réponse IA
- `?davai off` : désactive l'auto-réponse IA
- `?davai model <nom>` : change le modèle IA utilisé
  - exemple : `?davai model openai/gpt-4o-mini`
- `?davai provider <nom>` : change le provider IA primaire
  - providers valides : `gemini`, `groq`, `cerebras`, `openrouter`, `openai`, `haoduomi`
  - pour `haoduomi`, ajoute `API_KEY` dans `.env`
- `?davai reload` : recharge `personality.json` sur tous les providers
- `?davai stats` : affiche l'état IA actuel
- `?davai key set <provider> <clé>` : stocke une clé API dans `.env`
- `?davai key remove <provider>` : supprime la clé API du provider

## Fichier de configuration IA runtime

Le bot charge maintenant un fichier facultatif `ai-config.json` à la racine :
- `aiProvider`
- `aiModel`
- `aiAutoReply`
- `aiMaxContextMessages`
- `aiRespondToGroups`

Ce fichier est créé automatiquement lorsqu'une configuration IA est modifiée via l'API ou via `?davai model` / `?davai provider`.

## Endpoints API IA

Le bot expose désormais une API HTTP sur le même serveur Express actif sur `PORT` (par défaut 3000).

### GET /api/ai/config
Retourne l'état IA runtime : provider, modèle, autoReply, réponse aux groupes.

### GET /api/ai/providers
Retourne la liste des providers supportés et leur disponibilité.

### POST /api/ai/model
Modifie le modèle IA courant.

Request body JSON :
```json
{ "model": "openai/gpt-4o-mini" }
```

### POST /api/ai/provider
Change le provider IA primaire.

Request body JSON :
```json
{ "provider": "openrouter" }
```

### POST /api/ai/config
Met à jour plusieurs paramètres IA.

Request body JSON possible :
```json
{
  "aiProvider": "openai",
  "aiModel": "gpt-4o-mini",
  "aiAutoReply": true,
  "aiMaxContextMessages": 12,
  "aiRespondToGroups": false
}
```

### POST /api/ai/reload-personality
Recharge `personality.json` sur tous les providers du pool.

## Notes

- L'API attend des requêtes JSON.
- Les changements appliqués via l'API sont persistés dans `ai-config.json`.
- Le bot continue de respecter la clé API des providers dans `.env`.
- La commande `?davai model` fonctionne immédiatement et persiste le modèle.
- Pour le provider `haoduomi`, la variable d'environnement attendue est `API_KEY`.

## Prochaine étape
Je suis prêt à recevoir l'API distante que tu veux intégrer pour que je connecte le bot directement au service IA approprié.
