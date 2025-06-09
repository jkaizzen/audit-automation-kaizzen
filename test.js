require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring'); // pour encoder les paramètres en URL
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
const clickupApps = JSON.parse(fs.readFileSync('clickup_apps.json'));

// Microsoft scope et URLs d'authentification
const MS_SCOPE = 'https://graph.microsoft.com/.default';
const MS_AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

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

// Fonction utilitaire pour normaliser une chaîne (pour comparer les noms des espaces, listes, etc.)
const normalize = str =>
  str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, '');

// Middleware global pour logger toutes les requêtes entrantes
app.use((req, res, next) => {
  console.log(`→ Requête entrante: ${req.method} ${req.url}`);
  next();
});

// Racine : lien pour déclencher l'authentification Microsoft
app.get('/', (req, res) => {
  const authUrl = `${MS_AUTH_URL}?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent(MS_SCOPE)}&state=12345`;
  console.log("➡️ Redirection vers l'URL d'auth Microsoft :", authUrl);
  res.send(`<a href="${authUrl}">🔐 Se connecter avec Microsoft</a>`);
});

// Callback pour Microsoft : récupère le code, demande le token, crée l'application via Graph et déclenche l'OAuth ClickUp
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  console.log("🔁 Code reçu depuis Microsoft :", code);
  if (!code) return res.send('❌ Aucun code reçu');
  
  try {
    // Demande du token Microsoft
    console.log("📡 Demande de token Microsoft...");
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
    console.log("✅ Token Microsoft reçu :", msAccessToken);
    
    // Création d'un client pour appeler l'API Microsoft Graph
    const graph = axios.create({
      baseURL: 'https://graph.microsoft.com/v1.0',
      headers: { Authorization: `Bearer ${msAccessToken}` }
    });
    
    // Récupération du profil utilisateur
    const profileRes = await graph.get('/me');
    const userProfile = profileRes.data;
    console.log("👤 Profil Microsoft :", userProfile);
    
    // Récupération des informations du tenant (organisation)
    const tenantRes = await graph.get('/organization');
    const tenantIdResolved = tenantRes.data.value?.[0]?.id;
    console.log("🏢 Tenant ID détecté :", tenantIdResolved);
    
    // Récupération du service principal de Microsoft Graph (appId fixe)
    const spRes = await graph.get(`/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'`);
    const graphSp = spRes.data.value[0];
    const availableScopes = graphSp.oauth2PermissionScopes;
    console.log(`🔍 ${availableScopes.length} scopes récupérés depuis le service principal`);
    
    // Pour chaque scope requis, on cherche une correspondance dans les scopes disponibles
    const matchedScopes = permissionScopesToGrant.map(scopeName => {
      const match = availableScopes.find(s => s.value === scopeName);
      if (!match) throw new Error(`❌ Scope non trouvé : ${scopeName}`);
      return { id: match.id, type: 'Scope' };
    });
    console.log(`🔎 ${matchedScopes.length} scopes correspondants trouvés`);
    
    // Création de l'application via Microsoft Graph
    console.log("🛠️ Création de l'application dans Microsoft Graph...");
    const appCreateRes = await graph.post('/applications', {
      displayName: `Audit-OAuth-App-${Date.now()}`,
      signInAudience: 'AzureADMyOrg',
      requiredResourceAccess: [{
        resourceAppId: '00000003-0000-0000-c000-000000000000',
        resourceAccess: matchedScopes
      }]
    });
    
    const newApp = appCreateRes.data;
    console.log("✅ Application créée !");
    console.log("🔑 App ID :", newApp.appId);
    console.log("📎 Object ID :", newApp.id);
    
    // Ajout d'un mot de passe (client secret) à l'application nouvellement créée
    const passwordRes = await graph.post(`/applications/${newApp.id}/addPassword`, {
      passwordCredential: { displayName: "Auto-Secret" }
    });
    const appClientSecret = passwordRes.data.secretText;
    console.log("🔐 Secret généré pour l'application :", appClientSecret);
    
    // Stockage temporaire des informations de l'app dans un fichier (pour référence ultérieure)
    fs.writeFileSync(`clickup-${newApp.appId}.json`, JSON.stringify({
      microsoft: {
        appId: newApp.appId,
        clientSecret: appClientSecret,
        tenantId: TENANT_ID
      }
    }, null, 2));
    console.log("💾 Informations de l'application sauvegardées dans le fichier clickup-" + newApp.appId + ".json");
    
    // Récupération des identifiants ClickUp depuis notre fichier de config
    const clickupCreds = clickupApps[tenantIdResolved];
    if (!clickupCreds) throw new Error(`❌ Aucun identifiant ClickUp trouvé pour ce tenant (${tenantIdResolved})`);
    
    // Création d'un objet "state" à transmettre à ClickUp
    const stateObj = {
      msAccessToken,
      userProfile,
      tenantId: tenantIdResolved
    };
    const stateEncoded = Buffer.from(JSON.stringify(stateObj)).toString('base64');
    console.log("📦 State encodé pour ClickUp :", stateEncoded);
    
    // Construction de l'URL OAuth de ClickUp avec les paramètres requis
    const clickupOAuthURL = `https://app.clickup.com/api?client_id=${clickupCreds.client_id}&redirect_uri=${encodeURIComponent(clickupCreds.redirect_uri)}&state=${stateEncoded}`;
    console.log("➡️ Redirection vers ClickUp OAuth :", clickupOAuthURL);
    
    // Redirection vers ClickUp pour poursuivre l'OAuth
    res.redirect(clickupOAuthURL);
    
  } catch (error) {
    console.error("❌ Erreur lors du traitement du callback Microsoft :", error.response?.data || error.message);
    res.status(500).send(`<h2>Erreur Microsoft</h2><pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

// Callback ClickUp : réception du code et suite du traitement (récupération de token ClickUp, équipes, espaces, tâches, etc.)
app.get('/clickup-callback', async (req, res) => {
  const code = req.query.code;
  const stateEncoded = req.query.state;
  
  console.log("🔁 Code reçu depuis ClickUp :", code);
  console.log("📦 State brut reçu depuis ClickUp :", stateEncoded);
  if (!code || !stateEncoded) return res.send('❌ Paramètres manquants');
  
  let state;
  try {
    state = JSON.parse(Buffer.from(stateEncoded, 'base64').toString());
  } catch (err) {
    console.error("❌ Erreur lors du décodage du state :", err);
    return res.status(400).send("Erreur lors du décodage du state.");
  }
  const { tenantId, msAccessToken, userProfile } = state;
  console.log("📦 State décodé :", state);
  
  try {
    const clickupCreds = clickupApps[tenantId];
    if (!clickupCreds) throw new Error(`❌ Aucune configuration ClickUp trouvée pour tenant ${tenantId}`);
    
    console.log("📡 Demande de token ClickUp...");
    const clickupTokenRes = await axios.post('https://api.clickup.com/api/v2/oauth/token', {
      client_id: clickupCreds.client_id,
      client_secret: clickupCreds.client_secret,
      code,
      redirect_uri: clickupCreds.redirect_uri
    });
    const clickupAccessToken = clickupTokenRes.data.access_token;
    console.log("✅ Token ClickUp reçu :", clickupAccessToken);
    
    console.log("🔍 Récupération des équipes...");
    const teamsRes = await axios.get('https://api.clickup.com/api/v2/team', {
      headers: { Authorization: clickupAccessToken }
    });
    const team = teamsRes.data.teams[0];
    if (!team) throw new Error('❌ Aucun espace ClickUp trouvé');
    console.log("✅ Espace ClickUp trouvé :", team.name);
    
    const teamId = team.id;
    console.log("📁 Récupération des espaces...");
    const spacesRes = await axios.get(`https://api.clickup.com/api/v2/team/${teamId}/space`, {
      headers: { Authorization: clickupAccessToken }
    });
    const space = spacesRes.data.spaces.find(s => normalize(s.name) === normalize("Equipes Technique"));
    if (!space) throw new Error('❌ Espace "Equipes Technique" non trouvé');
    console.log("✅ Espace 'Equipes Technique' trouvé :", space.name);
    
    console.log("📂 Récupération des listes...");
    const listsRes = await axios.get(`https://api.clickup.com/api/v2/space/${space.id}/list`, {
      headers: { Authorization: clickupAccessToken }
    });
    const list = listsRes.data.lists.find(l => normalize(l.name) === normalize("Audit de sécurité"));
    if (!list) throw new Error('❌ Liste "Audit de sécurité" non trouvée');
    console.log("✅ Liste 'Audit de sécurité' trouvée :", list.name);
    
    console.log("📋 Récupération des tâches...");
    const tasksRes = await axios.get(`https://api.clickup.com/api/v2/list/${list.id}/task`, {
      headers: { Authorization: clickupAccessToken }
    });
    const tasks = tasksRes.data.tasks;
    console.log(`📋 ${tasks.length} tâches récupérées`);
    
    const filteredTasks = tasks
      .filter(t => Array.isArray(t.custom_fields))
      .filter(t => {
        const traitementField = t.custom_fields.find(f => normalize(f.name) === normalize("Traitement"));
        return traitementField?.value === 0;
      });
    console.log(`🎯 ${filteredTasks.length} tâches filtrées à traiter`);
    
    const results = [];
    for (const task of filteredTasks) {
      const auditField = task.custom_fields.find(f => normalize(f.name) === normalize("Audit"));
      const scriptContent = auditField?.value;
      if (!scriptContent) {
        console.log(`⚠️ Aucun script trouvé pour la tâche: ${task.name}`);
        continue;
      }
      console.log(`🚀 Envoi du script pour la tâche: ${task.name} (${task.id})`);
      const webhookRes = await axios.post(N8N_WEBHOOK, {
        taskId: task.id,
        auditScript: scriptContent,
        clickupAccessToken,
        msAccessToken,
        userProfile
      });
      results.push({
        taskId: task.id,
        name: task.name,
        MSAccesstoken : msAccessToken,
        Clickupaccesstoken : clickupAccessToken,
        script: scriptContent,
        webhookResult: webhookRes.data
      });
      console.log(`✅ Webhook exécuté pour ${task.name} → Résultat:`, webhookRes.data);
      console.log('Résultats ajoutés:', {
        taskId: task.id,
        name: task.name,
        MSAccesstoken: msAccessToken,
        Clickupaccesstoken: clickupAccessToken,
        script: scriptContent,
        webhookResult: webhookRes.data
      });
      
    }
    
    const summaryHtml = results.map(r => `
      <li style="margin-bottom: 2rem;">
        <strong>${r.name}</strong>
        <pre><code>${r.script}</code></pre>
        <small><strong>Statut :</strong> ${r.webhookResult.complianceStatus}</small><br>
        <details style="margin-top: 0.5rem;">
          <summary>🔍 Voir sortie PowerShell</summary>
          <pre style="background:#f5f5f5;padding:1rem;border-radius:8px;">${r.webhookResult.stdout}</pre>
        </details>
      </li>
    `).join('');
    
    res.send(`
      <h2>✅ Audit terminé avec succès</h2>
      <ul style="list-style:none;padding-left:0;">${summaryHtml}</ul>
    `);
    
  } catch (error) {
    console.error("❌ Erreur ClickUp :", error.response?.data || error.message);
    res.status(500).send(`<h2>Erreur ClickUp</h2><pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`✅ App en écoute sur http://localhost:${PORT}`);
});
