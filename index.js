require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const fs = require('fs');
const bodyParser = require('body-parser');
const app = express();

// Pour stocker temporairement l'état entre étapes
const stateStore = {};

const {
  CLIENT_ID,
  CLIENT_SECRET,
  TENANT_ID,
  REDIRECT_URI,
  PORT,
  N8N_WEBHOOK
} = process.env;

// On lit la configuration ClickUp depuis un fichier JSON
const clickupApps = JSON.parse(
  fs.readFileSync('clickup_apps.json', 'utf8')
);

// Microsoft constants
const MS_SCOPE    = 'https://graph.microsoft.com/.default';
const MS_AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL= `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

// Template HTML moderne
const getModernHTML = (title, content) => `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            max-width: 500px;
            width: 100%;
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        h1, h2 {
            color: #333;
            margin-bottom: 30px;
            font-weight: 300;
        }
        
        h1 {
            font-size: 2.5em;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        h2 {
            font-size: 1.8em;
        }
        
        .auth-button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 40px;
            border: none;
            border-radius: 50px;
            font-size: 1.1em;
            text-decoration: none;
            display: inline-block;
            transition: all 0.3s ease;
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
            margin: 20px 0;
        }
        
        .auth-button:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 30px rgba(102, 126, 234, 0.4);
        }
        
        .form-group {
            margin: 20px 0;
            text-align: left;
        }
        
        .radio-option {
            background: rgba(102, 126, 234, 0.1);
            border: 2px solid transparent;
            border-radius: 15px;
            padding: 15px 20px;
            margin: 10px 0;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
        }
        
        .radio-option:hover {
            background: rgba(102, 126, 234, 0.2);
            border-color: rgba(102, 126, 234, 0.3);
        }
        
        .radio-option input[type="radio"] {
            margin-right: 15px;
            transform: scale(1.2);
            accent-color: #667eea;
        }
        
        .radio-option input[type="radio"]:checked + label {
            color: #667eea;
            font-weight: 600;
        }
        
        .radio-option.selected {
            background: rgba(102, 126, 234, 0.2);
            border-color: #667eea;
        }
        
        .submit-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 40px;
            border: none;
            border-radius: 50px;
            font-size: 1.1em;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 20px;
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }
        
        .submit-btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 30px rgba(102, 126, 234, 0.4);
        }
        
        .submit-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
            box-shadow: 0 5px 10px rgba(102, 126, 234, 0.2);
        }
        
        .success-message {
            background: linear-gradient(135deg, #56ab2f 0%, #a8e6cf 100%);
            color: white;
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
            box-shadow: 0 10px 20px rgba(86, 171, 47, 0.3);
        }
        
        .success-icon {
            font-size: 3em;
            margin-bottom: 20px;
            animation: bounce 2s infinite;
        }
        
        @keyframes bounce {
            0%, 20%, 50%, 80%, 100% {
                transform: translateY(0);
            }
            40% {
                transform: translateY(-10px);
            }
            60% {
                transform: translateY(-5px);
            }
        }
        
        .result-data {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 10px;
            padding: 15px;
            margin: 20px 0;
            text-align: left;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
            max-height: 300px;
            overflow-y: auto;
        }
        
        .icons {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin: 30px 0;
        }
        
        .icon {
            width: 60px;
            height: 60px;
            background: rgba(102, 126, 234, 0.1);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5em;
            color: #667eea;
        }
        
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
            margin-left: 10px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        ${content}
    </div>
    
    <script>
        // Animation des options radio
        document.querySelectorAll('.radio-option').forEach(option => {
            option.addEventListener('click', function() {
                const radio = this.querySelector('input[type="radio"]');
                radio.checked = true;
                
                // Retirer la classe selected de tous les autres
                document.querySelectorAll('.radio-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Ajouter la classe selected à l'option courante
                this.classList.add('selected');
                
                // Activer le bouton submit
                const submitBtn = document.querySelector('.submit-btn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                }
            });
        });
        
        // Désactiver le bouton submit par défaut s'il y a des options radio
        const radioOptions = document.querySelectorAll('input[type="radio"]');
        const submitBtn = document.querySelector('.submit-btn');
        if (radioOptions.length > 0 && submitBtn) {
            submitBtn.disabled = true;
        }
        
        // Animation de soumission
        document.querySelectorAll('form').forEach(form => {
            form.addEventListener('submit', function() {
                const submitBtn = this.querySelector('.submit-btn');
                if (submitBtn) {
                    submitBtn.innerHTML += '<span class="loading"></span>';
                    submitBtn.disabled = true;
                }
            });
        });
    </script>
</body>
</html>
`;

// Étape 1: Microsoft OAuth
app.get('/', (req, res) => {
  const authUrl = `${MS_AUTH_URL}`
    + `?client_id=${CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_mode=query`
    + `&scope=${encodeURIComponent(MS_SCOPE)}`
    + `&state=ms_auth`;

  const content = `
    <div class="icons">
      <div class="icon">🏢</div>
      <div class="icon">🔗</div>
      <div class="icon">✅</div>
    </div>
    <h1>Intégration Microsoft & ClickUp</h1>
    <p style="color: #666; margin-bottom: 30px; font-size: 1.1em;">
      Connectez votre compte Microsoft pour synchroniser vos tâches ClickUp
    </p>
    <a href="${authUrl}" class="auth-button">
      🚀 Se connecter avec Microsoft
    </a>
  `;

  res.send(getModernHTML('Connexion Microsoft', content));
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send(getModernHTML('Erreur', '<h2>❌ Aucun code reçu</h2>'));
  try {
    const tokenResponse = await axios.post(
      MS_TOKEN_URL,
      qs.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: MS_SCOPE
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const msAccessToken = tokenResponse.data.access_token;

    // Appel Graph pour org
    const graph = axios.create({
      baseURL: 'https://graph.microsoft.com/v1.0',
      headers: { Authorization: `Bearer ${msAccessToken}` }
    });
    const tenantRes = await graph.get('/organization');
    const tenantIdResolved = tenantRes.data.value[0].id;

    // Génération état pour ClickUp + stockage temporaire
    const state = { msAccessToken, tenantIdResolved };
    const stateKey = Buffer.from(JSON.stringify(state)).toString('base64');
    stateStore[stateKey] = state;

    // Redirection vers ClickUp OAuth
    const clickupCreds = clickupApps[state.tenantIdResolved];
    if (!clickupCreds) throw new Error(`Pas de config ClickUp pour tenant ${tenantIdResolved}`);
    const clickupUrl = `https://app.clickup.com/api?client_id=${clickupCreds.client_id}`
      + `&redirect_uri=${encodeURIComponent(clickupCreds.redirect_uri)}`
      + `&state=${stateKey}`;
    res.redirect(clickupUrl);
  } catch (err) {
    console.error('Erreur MS callback:', err.response?.data || err.message);
    const content = `
      <h2>❌ Erreur de connexion Microsoft</h2>
      <p style="color: #e74c3c; margin: 20px 0;">
        ${err.response?.data?.error || err.message}
      </p>
      <a href="/" class="auth-button">🔄 Réessayer</a>
    `;
    res.status(500).send(getModernHTML('Erreur Microsoft', content));
  }
});

// Étape 2: ClickUp OAuth + sélection interactive
app.get('/clickup-callback', async (req, res) => {
  const code = req.query.code;
  const stateKey = req.query.state;
  const state = stateStore[stateKey];
  if (!code || !state) {
    const content = `
      <h2>⚠️ Session expirée</h2>
      <p style="color: #f39c12; margin: 20px 0;">
        Paramètres manquants ou session expirée.
      </p>
      <a href="/" class="auth-button">🏠 Recommencer</a>
    `;
    return res.send(getModernHTML('Session expirée', content));
  }

  try {
    const clickupCreds = clickupApps[state.tenantIdResolved];
    const tokenRes = await axios.post(
      'https://api.clickup.com/api/v2/oauth/token',
      {
        client_id: clickupCreds.client_id,
        client_secret: clickupCreds.client_secret,
        code,
        redirect_uri: clickupCreds.redirect_uri
      }
    );
    const clickupAccessToken = tokenRes.data.access_token;
    state.clickupAccessToken = clickupAccessToken;

    // Récupérer espaces
    const teamRes = await axios.get('https://api.clickup.com/api/v2/team', {
      headers: { Authorization: clickupAccessToken }
    });
    const teamId = teamRes.data.teams?.[0]?.id;
    if (!teamId) throw new Error('Aucune équipe trouvée');

    const spacesRes = await axios.get(
      `https://api.clickup.com/api/v2/team/${teamId}/space`,
      { headers: { Authorization: clickupAccessToken } }
    );
    const spaces = spacesRes.data.spaces;

    // Afficher formulaire de sélection d'espace
    let content = `
      <h2>📁 Choisissez un espace ClickUp</h2>
      <p style="color: #666; margin-bottom: 30px;">
        Sélectionnez l'espace contenant vos tâches à traiter
      </p>
      <form method="post" action="/select-list">
        <input type="hidden" name="stateKey" value="${stateKey}"/>
    `;

    spaces.forEach(s => {
      content += `
        <div class="radio-option">
          <input type="radio" name="spaceId" value="${s.id}" id="space-${s.id}"/>
          <label for="space-${s.id}">📂 ${s.name}</label>
        </div>
      `;
    });

    content += `
        <button type="submit" class="submit-btn">➡️ Suivant</button>
      </form>
    `;

    res.send(getModernHTML('Sélection Espace', content));
  } catch (err) {
    console.error('Erreur ClickUp callback:', err.response?.data || err.message);
    const content = `
      <h2>❌ Erreur ClickUp</h2>
      <p style="color: #e74c3c; margin: 20px 0;">
        ${err.response?.data?.err || err.message}
      </p>
      <a href="/" class="auth-button">🔄 Réessayer</a>
    `;
    res.status(500).send(getModernHTML('Erreur ClickUp', content));
  }
});

// POST sélection liste
app.post('/select-list', async (req, res) => {
  const { stateKey, spaceId, listId } = req.body;
  const state = stateStore[stateKey];
  if (!state?.clickupAccessToken) {
    const content = `
      <h2>⚠️ Session expirée</h2>
      <p style="color: #f39c12; margin: 20px 0;">
        Veuillez recommencer le processus de connexion.
      </p>
      <a href="/" class="auth-button">🏠 Recommencer</a>
    `;
    return res.send(getModernHTML('Session expirée', content));
  }

  try {
    // Récup listes de l'espace choisi
    const listsRes = await axios.get(
      `https://api.clickup.com/api/v2/space/${spaceId}/list`,
      { headers: { Authorization: state.clickupAccessToken } }
    );
    const lists = listsRes.data.lists;

    // Afficher formulaire de sélection de liste
    let content = `
      <h2>📋 Choisissez une liste</h2>
      <p style="color: #666; margin-bottom: 30px;">
        Sélectionnez la liste contenant les tâches à traiter
      </p>
      <form method="get" action="/select-status">
        <input type="hidden" name="stateKey" value="${stateKey}"/>
        <input type="hidden" name="spaceId" value="${spaceId}"/>
    `;

    lists.forEach(l => {
      content += `
        <div class="radio-option">
          <input type="radio" name="listId" value="${l.id}" id="list-${l.id}"/>
          <label for="list-${l.id}">📝 ${l.name}</label>
        </div>
      `;
    });

    content += `
        <button type="submit" class="submit-btn">➡️ Suivant</button>
      </form>
    `;

    res.send(getModernHTML('Sélection Liste', content));
  } catch (err) {
    console.error('Erreur récupération listes:', err.response?.data || err.message);
    const content = `
      <h2>❌ Erreur de récupération</h2>
      <p style="color: #e74c3c; margin: 20px 0;">
        ${err.response?.data?.err || err.message}
      </p>
      <a href="/" class="auth-button">🔄 Réessayer</a>
    `;
    res.status(500).send(getModernHTML('Erreur Listes', content));
  }
});

// GET sélection du statut
app.get('/select-status', (req, res) => {
  const { stateKey, spaceId, listId } = req.query;
  const state = stateStore[stateKey];
  if (!state?.clickupAccessToken) {
    return res.send(getModernHTML('Session expirée', '<h2>⚠️ Session expirée</h2>'));
  }

  // Statuts à proposer (tu peux ajuster ou récupérer dynamiquement)
  const statusOptions = ['TO DO', 'TO DO 2', 'A CONTROLLER', 'CONFORME', 'NON CONFORME'];

  let content = `
    <h2>🎯 Choisissez un statut</h2>
    <p style="color: #666; margin-bottom: 30px;">
      Quel statut souhaitez-vous traiter ?
    </p>
    <form method="post" action="/process-tasks">
      <input type="hidden" name="stateKey" value="${stateKey}"/>
      <input type="hidden" name="spaceId" value="${spaceId}"/>
      <input type="hidden" name="listId" value="${listId}"/>
  `;

  statusOptions.forEach(status => {
    content += `
      <div class="radio-option">
        <input type="radio" name="targetStatus" value="${status}" id="status-${status}"/>
        <label for="status-${status}">📌 ${status}</label>
      </div>
    `;
  });

  content += `
      <button type="submit" class="submit-btn">⚡ Traiter les tâches</button>
    </form>
  `;

  res.send(getModernHTML('Sélection Statut', content));
});

// POST traitement des tâches (filtrage sur le statut choisi)
app.post('/process-tasks', async (req, res) => {
  const { stateKey, listId, targetStatus } = req.body;
  const state = stateStore[stateKey];
  if (!state?.clickupAccessToken) {
    const content = `
      <h2>⚠️ Session expirée</h2>
      <p style="color: #f39c12; margin: 20px 0;">
        Veuillez recommencer le processus de connexion.
      </p>
      <a href="/" class="auth-button">🏠 Recommencer</a>
    `;
    return res.send(getModernHTML('Session expirée', content));
  }

  try {
    // Récupérer toutes les tâches de la liste sélectionnée
    const tasksRes = await axios.get(
      `https://api.clickup.com/api/v2/list/${listId}/task`,
      { headers: { Authorization: state.clickupAccessToken } }
    );

    // Filtrer selon le statut choisi
    const filtered = tasksRes.data.tasks.filter(t => {
      const status = t.status?.status?.toUpperCase() || t.status?.toUpperCase();
      return status === targetStatus.toUpperCase();
    });

    // Préparer les scripts à envoyer via le webhook
    const results = filtered.map((task, i) => ({
      varName: `auditscript${i + 1}`,
      script: task.custom_fields.find(f => f.name.toLowerCase() === 'audit')?.value,
      taskId: task.id
    }));

    // Envoi webhook
    console.log(`Envoi de ${results.length} scripts à ${N8N_WEBHOOK}`);
    const whRes = await axios.post(N8N_WEBHOOK, { ...state, scripts: results });

    const content = `
      <div class="success-message">
        <div class="success-icon">✅</div>
        <h2>Traitement réussi !</h2>
        <p style="font-size: 1.2em; margin: 10px 0;">
          <strong>${results.length}</strong> scripts ont été envoyés avec succès
        </p>
      </div>
      <div class="result-data">
        ${JSON.stringify(whRes.data, null, 2)}
      </div>
      <a href="/" class="auth-button">🔄 Nouveau traitement</a>
    `;

    res.send(getModernHTML('Succès', content));
  } catch (err) {
    console.error('Erreur traitement tasks:', err.response?.data || err.message);
    const content = `
      <h2>❌ Erreur de traitement</h2>
      <p style="color: #e74c3c; margin: 20px 0;">
        ${err.response?.data?.err || err.message}
      </p>
      <a href="/" class="auth-button">🔄 Réessayer</a>
    `;
    res.status(err.response?.status || 500).send(getModernHTML('Erreur Traitement', content));
  }
});

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
