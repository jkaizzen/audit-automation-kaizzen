require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const fs = require('fs');
const app = express();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  PORT,
  TENANT_ID,
  CLICKUP_CLIENT_ID,
  CLICKUP_CLIENT_SECRET,
  CLICKUP_REDIRECT_URI,
  N8N_WEBHOOK_URL
} = process.env;

const SCOPES = [
  "Application.ReadWrite.All",
  "AppRoleAssignment.ReadWrite.All",
  "Directory.ReadWrite.All",
  "User.Read"
];

const permissionScopesToGrant = [
  "User.Read", "Directory.Read.All", "User.Read.All", "Group.Read.All",
  "Sites.Read.All", "Team.ReadBasic.All", "TeamSettings.Read.All", "Channel.ReadBasic.All",
  "SecurityEvents.Read.All", "DeviceManagementManagedDevices.Read.All", "DeviceManagementConfiguration.Read.All",
  "Reports.Read.All", "ChannelMessage.Read.All", "Sites.FullControl.All", "Sites.Manage.All",
  "Sites.ReadWrite.All", "SecurityEvents.ReadWrite.All", "DeviceManagementApps.Read.All",
  "DeviceManagementConfiguration.ReadWrite.All", "Policy.Read.All", "Policy.ReadWrite.ConditionalAccess",
  "SecurityActions.Read.All"
];

app.get('/', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    prompt: 'consent'
  });

  const authUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`;
  res.send(`<a href="${authUrl}">🔐 Se connecter avec Microsoft</a>`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('❌ Aucun code reçu');

  try {
    const tokenRes = await axios.post(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, qs.stringify({
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      client_secret: CLIENT_SECRET,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data.access_token;
    const graph = axios.create({
      baseURL: 'https://graph.microsoft.com/v1.0',
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    console.log("✅ Token Microsoft reçu");

    const servicePrincipalRes = await graph.get(`/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'`);
    const graphSp = servicePrincipalRes.data.value[0];

    const availableScopes = graphSp.oauth2PermissionScopes;
    console.log(`🔍 ${availableScopes.length} scopes récupérés`);

    const matchedScopes = permissionScopesToGrant.map(scopeName => {
      const match = availableScopes.find(s => s.value === scopeName);
      if (!match) throw new Error(`❌ Scope non trouvé : ${scopeName}`);
      return { id: match.id, type: 'Scope' };
    });

    console.log("🛠️ Création de l'application...");
    const appRes = await graph.post('/applications', {
      displayName: `Audit-OAuth-App-${Date.now()}`,
      signInAudience: 'AzureADMyOrg',
      requiredResourceAccess: [{
        resourceAppId: '00000003-0000-0000-c000-000000000000',
        resourceAccess: matchedScopes
      }]
    });

    const newApp = appRes.data;
    console.log("✅ Application créée !");
    console.log("🔑 App ID :", newApp.appId);
    console.log("📎 Object ID :", newApp.id);

    const secretRes = await graph.post(`/applications/${newApp.id}/addPassword`, {
      passwordCredential: { displayName: "Auto-Secret" }
    });

    const clientSecret = secretRes.data.secretText;
    console.log("🔐 Secret généré :", clientSecret);

    // Stockage temporaire
    fs.writeFileSync(`clickup-${newApp.appId}.json`, JSON.stringify({
      microsoft: {
        appId: newApp.appId,
        clientSecret,
        tenantId: TENANT_ID
      }
    }, null, 2));

    // Démarrer OAuth ClickUp
    const clickUpAuthUrl = `https://app.clickup.com/api?client_id=${CLICKUP_CLIENT_ID}&redirect_uri=${CLICKUP_REDIRECT_URI}`;
    res.redirect(clickUpAuthUrl);

  } catch (err) {
    console.error("❌ Erreur Microsoft Graph :", err.response?.data || err.message);
    res.status(500).send(`<pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

app.get('/clickup/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('❌ Aucun code ClickUp reçu');

  try {
    const tokenRes = await axios.post('https://api.clickup.com/api/v2/oauth/token', {
      client_id: CLICKUP_CLIENT_ID,
      client_secret: CLICKUP_CLIENT_SECRET,
      code,
      redirect_uri: CLICKUP_REDIRECT_URI
    });

    const clickupToken = tokenRes.data.access_token;
    console.log("✅ Token ClickUp reçu :", clickupToken);

    const userRes = await axios.get('https://api.clickup.com/api/v2/user', {
      headers: { Authorization: clickupToken }
    });

    const userId = userRes.data.user.id;
    console.log("👤 Utilisateur ClickUp ID :", userId);

    const tasksRes = await axios.get(`https://api.clickup.com/api/v2/user/${userId}/task`, {
      headers: { Authorization: clickupToken }
    });

    console.log("📋 Tâches récupérées :", tasksRes.data.tasks?.length || 0);

    const webhookPayload = {
      userId,
      tasks: tasksRes.data.tasks,
      timestamp: Date.now()
    };

    const n8nRes = await axios.post(N8N_WEBHOOK_URL, webhookPayload);
    console.log("🚀 Webhook n8n déclenché :", n8nRes.status);

    res.send('<h2>🎉 Intégration terminée avec succès !</h2>');

  } catch (err) {
    console.error("❌ Erreur ClickUp :", err.response?.data || err.message);
    res.status(500).send(`<pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ App en écoute sur http://localhost:${PORT}`);
});
