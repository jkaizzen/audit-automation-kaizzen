require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const fs = require('fs');
const app = express();

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

// Microsoft scope et URLs d'authentification
const MS_SCOPE    = 'https://graph.microsoft.com/.default';
const MS_AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL= `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

// Liste de scopes à valider lors de la création de l'application via Graph
const permissionScopesToGrant = [
  "User.Read", "Directory.Read.All", "User.Read.All", "Group.Read.All",
  "Sites.Read.All", "Team.ReadBasic.All", "TeamSettings.Read.All", "Channel.ReadBasic.All",
  "SecurityEvents.Read.All", "DeviceManagementManagedDevices.Read.All", "DeviceManagementConfiguration.Read.All",
  "Reports.Read.All", "ChannelMessage.Read.All", "Sites.FullControl.All", "Sites.Manage.All",
  "Sites.ReadWrite.All", "SecurityEvents.ReadWrite.All", "DeviceManagementApps.Read.All",
  "DeviceManagementConfiguration.ReadWrite.All", "Policy.Read.All", "Policy.ReadWrite.ConditionalAccess",
  "SecurityActions.Read.All"
];

// Fonction utilitaire pour normaliser une chaîne
const normalize = str =>
  str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '');

// Middleware global pour logger toutes les requêtes entrantes
app.use((req, res, next) => {
  console.log(`→ Requête entrante: ${req.method} ${req.url}`);
  next();
});

// Racine : lien pour déclencher l'authentification Microsoft
app.get('/', (req, res) => {
  const authUrl = `${MS_AUTH_URL}`
    + `?client_id=${CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_mode=query`
    + `&scope=${encodeURIComponent(MS_SCOPE)}`
    + `&state=12345`;
  console.log('➡️ Redirection vers l’URL d’auth Microsoft :', authUrl);
  res.send(`<a href="${authUrl}">🔐 Se connecter avec Microsoft</a>`);
});

// Callback pour Microsoft
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  console.log('🔁 Code reçu depuis Microsoft :', code);
  if (!code) return res.send('❌ Aucun code reçu');

  try {
    console.log('📡 Demande de token Microsoft…');
    const tokenResponse = await axios.post(
      MS_TOKEN_URL,
      qs.stringify({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
        scope:         MS_SCOPE
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const msAccessToken = tokenResponse.data.access_token;
    console.log('✅ Token Microsoft reçu :', msAccessToken);

    const graph = axios.create({
      baseURL: 'https://graph.microsoft.com/v1.0',
      headers: { Authorization: `Bearer ${msAccessToken}` }
    });

    const profileRes = await graph.get('/me');
    const userProfile = profileRes.data;
    console.log('👤 Profil Microsoft :', userProfile);

    const tenantRes = await graph.get('/organization');
    const tenantIdResolved = tenantRes.data.value?.[0]?.id;
    console.log('🏢 Tenant ID détecté :', tenantIdResolved);

    const spRes = await graph.get(
      `/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'`
    );
    const graphSp = spRes.data.value[0];
    const availableScopes = graphSp.oauth2PermissionScopes;
    console.log(`🔍 ${availableScopes.length} scopes récupérés du SP`);

    const matchedScopes = permissionScopesToGrant.map(scopeName => {
      const match = availableScopes.find(s => s.value === scopeName);
      if (!match) throw new Error(`❌ Scope non trouvé : ${scopeName}`);
      return { id: match.id, type: 'Scope' };
    });
    console.log(`🔎 ${matchedScopes.length} scopes correspondants trouvés`);

    console.log('🛠️ Création de l’application dans Microsoft Graph…');
    const appCreateRes = await graph.post('/applications', {
      displayName: `Audit-OAuth-App-${Date.now()}`,
      signInAudience: 'AzureADMyOrg',
      requiredResourceAccess: [{
        resourceAppId: '00000003-0000-0000-c000-000000000000',
        resourceAccess: matchedScopes
      }]
    });
    const newApp = appCreateRes.data;
    console.log('✅ Application créée !');
    console.log('🔑 App ID (Client ID) :', newApp.appId);
    console.log('📎 Object ID :', newApp.id);

    const passwordRes = await graph.post(
      `/applications/${newApp.id}/addPassword`,
      { passwordCredential: { displayName: 'Auto-Secret' } }
    );
    const appClientSecret = passwordRes.data.secretText;
    console.log('🔐 Client Secret généré :', appClientSecret);

    fs.writeFileSync(
      `clickup-${newApp.appId}.json`,
      JSON.stringify({
        microsoft: {
          appId:        newApp.appId,
          clientId:     newApp.appId,
          clientSecret: appClientSecret,
          tenantId:     TENANT_ID
        }
      }, null, 2),
      'utf8'
    );
    console.log(
      `💾 Infos sauvegardées dans clickup-${newApp.appId}.json`
    );

    const clickupCreds = clickupApps[tenantIdResolved];
    if (!clickupCreds)
      throw new Error(`❌ Pas de config ClickUp pour tenant ${tenantIdResolved}`);

    const stateObj = {
      msAccessToken,
      userProfile,
      tenantId:  tenantIdResolved,
      clientId:  newApp.appId,
      clientSecret: appClientSecret
    };
    const stateEncoded = Buffer
      .from(JSON.stringify(stateObj), 'utf8')
      .toString('base64');
    const clickupOAuthURL = `https://app.clickup.com/api`
      + `?client_id=${clickupCreds.client_id}`
      + `&redirect_uri=${encodeURIComponent(clickupCreds.redirect_uri)}`
      + `&state=${encodeURIComponent(stateEncoded)}`;
    console.log('➡️ Redirection vers ClickUp OAuth :', clickupOAuthURL);
    res.redirect(clickupOAuthURL);

  } catch (error) {
    console.error(
      '❌ Erreur callback Microsoft :',
      error.response?.data || error.message
    );
    res.status(500).send(
      `<h2>Erreur Microsoft</h2><pre>${JSON.stringify(
        error.response?.data || error.message, null, 2
      )}</pre>`
    );
  }
});

// Callback ClickUp
app.get('/clickup-callback', async (req, res) => {
  const code         = req.query.code;
  const stateEncoded = req.query.state;
  console.log('🔁 Code ClickUp :', code);
  console.log('📦 State brut :', stateEncoded);
  if (!code || !stateEncoded) return res.send('❌ Paramètres manquants');

  try {
    const decodedState = Buffer
      .from(decodeURIComponent(stateEncoded), 'base64')
      .toString('utf8');
    const state = JSON.parse(decodedState);
    const { tenantId, msAccessToken } = state;
    console.log('📦 State décodé :', state);

    const clickupCreds = clickupApps[tenantId];
    if (!clickupCreds)
      throw new Error(`❌ Pas de config ClickUp pour tenant ${tenantId}`);

    console.log('📡 Demande token ClickUp…');
    const clickupTokenRes = await axios.post(
      'https://api.clickup.com/api/v2/oauth/token', {
        client_id:     clickupCreds.client_id,
        client_secret: clickupCreds.client_secret,
        code,
        redirect_uri:  clickupCreds.redirect_uri
      }
    );
    const clickupAccessToken = clickupTokenRes.data.access_token;
    console.log('✅ Token ClickUp reçu');

    // Récup équipe → espace → liste → tâches à auditer…
    const teamRes   = await axios.get('https://api.clickup.com/api/v2/team', {
      headers: { Authorization: clickupAccessToken }
    });
    const teamId    = teamRes.data.teams[0].id;
    const spacesRes= await axios.get(
      `https://api.clickup.com/api/v2/team/${teamId}/space`,
      { headers:{ Authorization: clickupAccessToken } }
    );
    const space     = spacesRes.data.spaces
      .find(s=> normalize(s.name)==='equipestechnique');
    const listsRes = await axios.get(
      `https://api.clickup.com/api/v2/space/${space.id}/list`,
      { headers:{ Authorization: clickupAccessToken } }
    );
    const list      = listsRes.data.lists
      .find(l=> normalize(l.name)==='auditdesecurite');

    const tasksRes = await axios.get(
      `https://api.clickup.com/api/v2/list/${list.id}/task`,
      { headers:{ Authorization: clickupAccessToken } }
    );
    const filtered = tasksRes.data.tasks.filter(t=>{
      const f = t.custom_fields.find(f=> normalize(f.name)==='traitement');
      return f?.value===0;
    });

    const results = [];
    filtered.forEach((task, i)=>{
      const auditField = task.custom_fields
        .find(f=> normalize(f.name)==='audit');
      if (!auditField?.value) return;
      results.push({
        varName: `auditscript${i+1}`,
        script:  auditField.value,
        taskId:  task.id
      });
    });

    // Envoi au webhook n8n
    const payload = {
      msAccessToken,
      clickupAccessToken,
      tenantId,
      scripts: results
    };
    console.log(`🚀 Envoi de ${results.length} scripts à n8n`);
    const whRes = await axios.post(N8N_WEBHOOK, payload);
    console.log('✅ Webhook répondu:', whRes.data);

    res.send(`<h2>✅ Audit déclenché ( ${results.length} scripts )</h2>`);

  } catch (error) {
    console.error(
      '❌ Erreur ClickUp callback:',
      error.response?.data || error.message
    );
    res.status(500).send(
      `<h2>Erreur ClickUp</h2><pre>${JSON.stringify(
        error.response?.data || error.message, null,2
      )}</pre>`
    );
  }
});

// Démarrage
app.listen(PORT, () => {
  console.log(`✅ App en écoute sur http://localhost:${PORT}`);
});
