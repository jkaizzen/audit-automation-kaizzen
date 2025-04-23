require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  TENANT_ID,
  REDIRECT_URI,
  PORT,
  CLICKUP_CLIENT_ID,
  CLICKUP_CLIENT_SECRET,
  CLICKUP_REDIRECT_URI,
  N8N_WEBHOOK
} = process.env;

const MS_SCOPE = 'https://graph.microsoft.com/.default';
const MS_AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

const normalize = str =>
  str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, '');

app.get('/', (req, res) => {
  const authUrl = `${MS_AUTH_URL}?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent(MS_SCOPE)}&state=12345`;
  console.log("➡️ Redirection vers URL d'auth Microsoft :", authUrl);
  res.send(`<a href="${authUrl}">🔐 Se connecter avec Microsoft</a>`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  console.log("🔁 Code reçu depuis Microsoft :", code);

  try {
    console.log("📡 Demande de token Microsoft...");
    const msToken = await axios.post(MS_TOKEN_URL, new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: MS_SCOPE,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const msAccessToken = msToken.data.access_token;
    console.log("✅ Token Microsoft reçu");

    const profile = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${msAccessToken}` }
    });

    const userProfile = profile.data;
    console.log("👤 Profil Microsoft :", userProfile);

    const stateEncoded = Buffer.from(JSON.stringify({
      msAccessToken,
      userProfile
    })).toString('base64');

    const clickupOAuthURL = `https://app.clickup.com/api?client_id=${CLICKUP_CLIENT_ID}&redirect_uri=${encodeURIComponent(CLICKUP_REDIRECT_URI)}&state=${stateEncoded}`;
    console.log("➡️ Redirection vers ClickUp OAuth :", clickupOAuthURL);

    res.redirect(clickupOAuthURL);

  } catch (error) {
    console.error("❌ Erreur Microsoft:", error.response?.data || error.message);
    res.status(500).send(`<h2>Erreur Microsoft</h2><pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

app.get('/clickup-callback', async (req, res) => {
  const code = req.query.code;
  const state = JSON.parse(Buffer.from(req.query.state, 'base64').toString());

  console.log("🔁 Code reçu depuis ClickUp :", code);
  console.log("📦 State décodé :", state);

  try {
    console.log("📡 Demande de token ClickUp...");
    const clickupTokenRes = await axios.post('https://api.clickup.com/api/v2/oauth/token', {
      client_id: CLICKUP_CLIENT_ID,
      client_secret: CLICKUP_CLIENT_SECRET,
      code,
      redirect_uri: CLICKUP_REDIRECT_URI
    });

    const clickupAccessToken = clickupTokenRes.data.access_token;
    console.log("✅ Token ClickUp reçu");

    console.log("🔍 Récupération des équipes...");
    const workspacesRes = await axios.get('https://api.clickup.com/api/v2/team', {
      headers: { Authorization: clickupAccessToken }
    });

    const team = workspacesRes.data.teams[0];
    if (!team) throw new Error('❌ Aucun espace ClickUp trouvé');
    console.log("✅ Espace ClickUp trouvé :", team.name);

    const teamId = team.id;

    console.log("📁 Récupération des espaces...");
    const spaceRes = await axios.get(`https://api.clickup.com/api/v2/team/${teamId}/space`, {
      headers: { Authorization: clickupAccessToken }
    });

    const space = spaceRes.data.spaces.find(s => normalize(s.name) === normalize("Equipes Technique"));
    if (!space) throw new Error('❌ Espace "Equipes Technique" non trouvé');
    console.log("✅ Espace 'Equipes Technique' trouvé :", space.name);

    const listsRes = await axios.get(`https://api.clickup.com/api/v2/space/${space.id}/list`, {
      headers: { Authorization: clickupAccessToken }
    });

    const list = listsRes.data.lists.find(l => normalize(l.name) === normalize("Audit de sécurité"));
    if (!list) throw new Error('❌ Liste "Audit de sécurité" non trouvée');
    console.log("✅ Liste 'Audit de sécurité' trouvée :", list.name);

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
        msAccessToken: state.msAccessToken,
        userProfile: state.userProfile
      });

      results.push({
        taskId: task.id,
        name: task.name,
        script: scriptContent,
        webhookResult: webhookRes.data
      });

      console.log(`✅ Webhook exécuté pour ${task.name} → Résultat:`, webhookRes.data);
    }

    // 🧾 Résumé HTML avec stdout affiché
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
    console.error("❌ Erreur ClickUp dynamique:", error.response?.data || error.message);
    res.status(500).send(`<h2>Erreur ClickUp</h2><pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ App en écoute sur http://localhost:${PORT}`);
});
