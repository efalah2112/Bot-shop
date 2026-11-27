const path = require("path");
const crypto = require("crypto");
const expressSession = require("express-session");
const Database = require("better-sqlite3");
const maker = require("../handlers/modules/maker");
const tokenVault = require("../handlers/modules/tokenVault");

const DISCORD_API = "https://discord.com/api/v10";
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

class SQLiteSessionStore extends expressSession.Store {
  constructor(filename) {
    super();
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS dashboard_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)");
    this.getStmt = this.db.prepare("SELECT sess, expires FROM dashboard_sessions WHERE sid = ?");
    this.setStmt = this.db.prepare("INSERT INTO dashboard_sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires");
    this.destroyStmt = this.db.prepare("DELETE FROM dashboard_sessions WHERE sid = ?");
    this.touchStmt = this.db.prepare("UPDATE dashboard_sessions SET expires = ? WHERE sid = ?");
    this.db.prepare("DELETE FROM dashboard_sessions WHERE expires <= ?").run(Date.now());
  }
  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.destroyStmt.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.setStmt.run(sid, JSON.stringify(sess), expires);
      if (callback) callback(null);
    } catch (error) { if (callback) callback(error); }
  }
  destroy(sid, callback) {
    try { this.destroyStmt.run(sid); if (callback) callback(null); }
    catch (error) { if (callback) callback(error); }
  }
  touch(sid, sess, callback) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.touchStmt.run(expires, sid);
      if (callback) callback(null);
    } catch (error) { if (callback) callback(error); }
  }
}

function hasGuildManagement(permission, owner) {
  if (owner) return true;
  try {
    const bits = BigInt(permission || "0");
    return (bits & ADMINISTRATOR) === ADMINISTRATOR || (bits & MANAGE_GUILD) === MANAGE_GUILD;
  } catch { return false; }
}

function setupDashboard(app, { bots, db }) {
  const publicDir = path.join(__dirname, "public");
  let publicStatsCache = null;
  let publicStatsCacheAt = 0;
  const clientId = process.env.DASHBOARD_CLIENT_ID;
  const clientSecret = process.env.DASHBOARD_CLIENT_SECRET;
  const redirectUri = process.env.DASHBOARD_REDIRECT_URI;
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
  const envDeveloperIds = new Set((process.env.DASHBOARD_DEVELOPER_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
  const developerIds = new Set([maker.MAKER_OWNER_ID, ...envDeveloperIds]);
  const developerIdsReady = db.get("dashboard_developer_ids").then(ids => {
    if (Array.isArray(ids)) ids.filter(id => typeof id === "string" && /^\d{17,20}$/.test(id)).forEach(id => developerIds.add(id));
  }).catch(error => console.error("[Dashboard developer access load]", error.message));

  if (!sessionSecret) console.warn("[Dashboard] Set DASHBOARD_SESSION_SECRET to enable secure sessions.");
  app.set("trust proxy", 1);
  app.use("/dashboard", expressSession({
    name: "screentranslator.sid",
    secret: sessionSecret || crypto.randomBytes(32).toString("hex"),
    store: new SQLiteSessionStore(path.resolve(process.cwd(), "dashboard_sessions.sqlite")),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // Match the cookie transport to the OAuth callback origin. On HTTPS deployments the cookie is secure; plain HTTP is only suitable for temporary testing and should be replaced with HTTPS.
      secure: Boolean(redirectUri && redirectUri.startsWith("https://")),
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  }));
  app.use("/dashboard/assets", express.static(publicDir));
  app.use("/dashboard/api", require("express").json({ limit: "256kb" }));

  const json = (res, status, data) => res.status(status).json(data);

  // Public dashboard proof points: only list guilds whose owners explicitly enabled showcase.
  app.get("/dashboard/api/public-stats", async (_req, res) => {
    try {
      if (publicStatsCache && Date.now() - publicStatsCacheAt < 60000) return json(res, 200, publicStatsCache);
      const uniqueGuilds = new Map();
      let ratingTotal = 0;
      let ratingCount = 0;
      const processedRatingGuilds = new Set();
      for (const bot of bots.filter(client => client && client.isReady() && client.user)) {
        for (const guild of bot.guilds.cache.values()) {
          if (!uniqueGuilds.has(guild.id)) uniqueGuilds.set(guild.id, guild);
          if (processedRatingGuilds.has(guild.id)) continue;
          processedRatingGuilds.add(guild.id);
          const ratingChannelId = await db.get("rating_ch_" + guild.id);
          if (!ratingChannelId) continue;
          const ratingChannel = guild.channels.cache.get(ratingChannelId);
          if (!ratingChannel || !ratingChannel.isTextBased() || !ratingChannel.messages) continue;
          const messages = await ratingChannel.messages.fetch({ limit: 100 }).catch(() => null);
          if (!messages) continue;
          for (const message of messages.values()) {
            const content = [message.content, ...(message.embeds || []).map(embed => embed.description || "")].join("\n");
            const match = content.match(/التقييم:\s*⭐+\s*\((\d)\/5\)/);
            if (!match) continue;
            const score = Number(match[1]);
            if (score >= 1 && score <= 5) { ratingTotal += score; ratingCount++; }
          }
        }
      }
      const allGuilds = [...uniqueGuilds.values()];
      const showcase = [];
      for (const guild of allGuilds) {
        if (await db.get("dashboard_public_showcase_" + guild.id) !== true) continue;
        showcase.push({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 96 }), memberCount: Number(guild.memberCount || 0) });
      }
      showcase.sort((a, b) => b.memberCount - a.memberCount);
      publicStatsCache = {
        botCount: bots.filter(client => client && client.isReady() && client.user).length,
        serverCount: allGuilds.length,
        memberCount: allGuilds.reduce((sum, guild) => sum + Number(guild.memberCount || 0), 0),
        ratingCount,
        ratingAverage: ratingCount ? Number((ratingTotal / ratingCount).toFixed(2)) : null,
        topGuilds: showcase.slice(0, 5)
      };
      publicStatsCacheAt = Date.now();
      json(res, 200, publicStatsCache);
    } catch (error) {
      console.error("[Dashboard public stats]", error.message);
      json(res, 200, { botCount: 0, serverCount: 0, memberCount: 0, ratingCount: 0, ratingAverage: null, topGuilds: [] });
    }
  });
  const requireOAuthConfig = (res) => {
    if (!clientId || !clientSecret || !redirectUri || !sessionSecret) {
      json(res, 503, { error: "Dashboard OAuth is not configured. Set DASHBOARD_CLIENT_ID, DASHBOARD_CLIENT_SECRET, DASHBOARD_REDIRECT_URI and DASHBOARD_SESSION_SECRET." });
      return false;
    }
    return true;
  };
  const requireUser = (req, res, next) => {
    if (!req.session.user || !req.session.accessToken) return json(res, 401, { error: "يرجى تسجيل الدخول أولاً." });
    developerIdsReady.then(() => next()).catch(() => json(res, 503, { error: "تعذر تحميل صلاحيات الداشبورد." }));
  };
  const discordFetch = async (url, token) => {
    const response = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("Discord API returned " + response.status);
    return response.json();
  };
  const ensureAccessToken = async (req) => {
    if (req.session.tokenExpiresAt > Date.now() + 30000) return req.session.accessToken;
    if (!req.session.refreshToken) throw new Error("Discord session expired");
    const refreshBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: req.session.refreshToken
    });
    const refreshed = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody
    });
    if (!refreshed.ok) throw new Error("Discord session refresh failed");
    const tokens = await refreshed.json();
    req.session.accessToken = tokens.access_token;
    req.session.refreshToken = tokens.refresh_token;
    req.session.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    return req.session.accessToken;
  };
  const getUserGuilds = async (req) => {
    const accessToken = await ensureAccessToken(req);
    if (!req.session.guilds || req.session.guildsFetchedAt < Date.now() - 60000) {
      req.session.guilds = await discordFetch(DISCORD_API + "/users/@me/guilds", accessToken);
      req.session.guildsFetchedAt = Date.now();
    }
    return req.session.guilds;
  };
  const getAllPremiumRecords = async () => {
    const rows = await db.all();
    if (!Array.isArray(rows)) throw new Error("QuickDB all() did not return an array");
    return rows
      .filter(row => row && String(row.id || "").startsWith("premium_user_") && row.value && row.value.active && Number(row.value.endDate) > Date.now())
      .map(row => row.value);
  };
  const getBot = (id) => bots.find(client => client.user && client.user.id === id);
  const isDeveloper = (userId) => developerIds.has(userId);
  const getBotOwnerId = async (client) => {
    if (!client) return null;
    if (client._dashboardOwnerId) return client._dashboardOwnerId;
    try {
      const application = await client.application.fetch();
      const owner = application.owner;
      const ownerId = owner && (owner.ownerId || owner.id);
      if (ownerId) client._dashboardOwnerId = ownerId;
      return ownerId || null;
    } catch {
      return null;
    }
  };

  const requireMaker = (req, res, next) => {
    if (!req.session.user || !isDeveloper(req.session.user.id)) return json(res, 403, { error: "هذا القسم متاح للمبرمج فقط." });
    next();
  };
  const requireMakerOwner = (req, res, next) => {
    if (!req.session.user || req.session.user.id !== maker.MAKER_OWNER_ID) return json(res, 403, { error: "إدارة صلاحيات الميكر متاحة للمالك الأساسي فقط." });
    next();
  };
  app.post("/dashboard/api/maker/settings/premium", requireUser, requireMaker, async (req, res) => {
    try {
      const settings = await db.get("premium_settings");
      if (!settings) return json(res, 404, { error: "إعدادات Premium غير موجودة؛ نفّذ إعداد الميكر أولاً." });
      const priceMonthly = Number(req.body?.priceMonthly), price3Months = Number(req.body?.price3Months);
      if (!Number.isInteger(priceMonthly) || priceMonthly < 1 || priceMonthly > 1000000000 || !Number.isInteger(price3Months) || price3Months < 1 || price3Months > 1000000000) return json(res, 400, { error: "أسعار الاشتراك يجب أن تكون أرقاماً صحيحة أكبر من صفر." });
      const makerClient = getBot(maker.MAKER_BOT_ID), guild = makerClient?.guilds?.cache?.get(settings.guildId);
      if (!guild) return json(res, 503, { error: "بوت الميكر غير موجود في سيرفر إعدادات Premium." });
      settings.priceMonthly = priceMonthly; settings.price3Months = price3Months;
      await db.set("premium_settings", settings);
      await audit(settings.guildId, req.session.user, "maker-premium-settings", ["تحديث أسعار اشتراكات Premium"]);
      json(res, 200, { saved:true, priceMonthly, price3Months });
    } catch (error) { console.error("[Maker premium settings]", error); json(res, 500, { error: "تعذر حفظ إعدادات Premium." }); }
  });
  app.get("/dashboard/api/maker/developers", requireUser, requireMakerOwner, async (_req, res) => {
    const stored = await db.get("dashboard_developer_ids") || [];
    json(res, 200, { ownerId: maker.MAKER_OWNER_ID, envManaged: [...envDeveloperIds], developers: [...new Set([maker.MAKER_OWNER_ID, ...envDeveloperIds, ...(Array.isArray(stored) ? stored : [])])] });
  });
  app.post("/dashboard/api/maker/developers", requireUser, requireMakerOwner, async (req, res) => {
    const userId = String(req.body?.userId || "");
    if (!/^\d{17,20}$/.test(userId)) return json(res, 400, { error: "آيدي المستخدم غير صالح." });
    if (developerIds.has(userId)) return json(res, 409, { error: "هذا المستخدم لديه صلاحية بالفعل." });
    const stored = await db.get("dashboard_developer_ids") || [];
    const next = [...new Set([...(Array.isArray(stored) ? stored : []), userId])];
    await db.set("dashboard_developer_ids", next);
    developerIds.add(userId);
    json(res, 200, { added: true, developers: [...new Set([maker.MAKER_OWNER_ID, ...envDeveloperIds, ...next])] });
  });
  app.delete("/dashboard/api/maker/developers/:userId", requireUser, requireMakerOwner, async (req, res) => {
    const userId = String(req.params.userId || "");
    if (!/^\d{17,20}$/.test(userId) || userId === maker.MAKER_OWNER_ID) return json(res, 400, { error: "لا يمكن إزالة هذا المستخدم." });
    if (envDeveloperIds.has(userId)) return json(res, 409, { error: "هذه الصلاحية مضبوطة من متغيرات الاستضافة؛ احذفها من DASHBOARD_DEVELOPER_IDS." });
    const stored = await db.get("dashboard_developer_ids") || [];
    const next = (Array.isArray(stored) ? stored : []).filter(id => id !== userId);
    await db.set("dashboard_developer_ids", next);
    developerIds.delete(userId);
    json(res, 200, { removed: true, developers: [...new Set([maker.MAKER_OWNER_ID, ...envDeveloperIds, ...next])] });
  });

  app.get("/dashboard/api/support", requireUser, async (req, res) => {
    try {
      const rows = await db.all();
      const isMaker = isDeveloper(req.session.user.id);
      const tickets = (rows || []).filter(row => String(row.id || "").startsWith("maker_support_ticket_") && row.value && (isMaker || row.value.userId === req.session.user.id)).map(row => row.value).sort((a,b) => Number(b.ticketNo)-Number(a.ticketNo));
      json(res, 200, { tickets });
    } catch (error) { console.error("[Support tickets]", error); json(res, 500, { error: "تعذر تحميل تذاكر الدعم." }); }
  });

  app.post("/dashboard/api/support", requireUser, async (req, res) => {
    try {
      const category = String(req.body?.category || ""), title = String(req.body?.title || "").trim().slice(0, 100), body = String(req.body?.body || "").trim().slice(0, 2000);
      if (!["complaint","premium","purchase","suggestion"].includes(category) || title.length < 5 || body.length < 10) return json(res, 400, { error: "اختر نوع التذكرة واكتب عنواناً ووصفاً واضحين." });
      const ticketNo = Number(await db.get("maker_support_counter") || 0) + 1;
      await db.set("maker_support_counter", ticketNo);
      const user = req.session.user;
      const ticket = { ticketNo, userId: user.id, username: user.globalName || user.username, category, title, status: "open", createdAt: Date.now(), updatedAt: Date.now(), messages: [{ userId: user.id, username: user.globalName || user.username, body, at: Date.now(), staff: false }] };
      await db.set("maker_support_ticket_" + ticketNo, ticket);
      json(res, 201, { ticket });
    } catch (error) { console.error("[Support ticket create]", error); json(res, 500, { error: "تعذر إنشاء تذكرة الدعم." }); }
  });

  app.post("/dashboard/api/support/:ticketNo/replies", requireUser, async (req, res) => {
    try {
      const ticketNo = Number(req.params.ticketNo), body = String(req.body?.body || "").trim().slice(0, 2000);
      if (!Number.isSafeInteger(ticketNo) || ticketNo < 1 || body.length < 2) return json(res, 400, { error: "رقم التذكرة أو نص الرد غير صالح." });
      const key = "maker_support_ticket_" + ticketNo, ticket = await db.get(key);
      if (!ticket) return json(res, 404, { error: "التذكرة غير موجودة." });
      const staff = isDeveloper(req.session.user.id);
      if (!staff && ticket.userId !== req.session.user.id) return json(res, 403, { error: "لا تملك صلاحية الوصول إلى هذه التذكرة." });
      if (ticket.status !== "open") return json(res, 409, { error: "التذكرة مغلقة؛ أعد فتحها قبل إضافة رد." });
      const user = req.session.user;
      ticket.messages = Array.isArray(ticket.messages) ? ticket.messages : [];
      ticket.messages.push({ userId: user.id, username: user.globalName || user.username, body, at: Date.now(), staff });
      ticket.updatedAt = Date.now();
      await db.set(key, ticket);
      json(res, 200, { ticket });
    } catch (error) { console.error("[Support ticket reply]", error); json(res, 500, { error: "تعذر إرسال الرد." }); }
  });

  app.post("/dashboard/api/support/:ticketNo/status", requireUser, requireMaker, async (req, res) => {
    try {
      const ticketNo = Number(req.params.ticketNo), status = String(req.body?.status || "");
      if (!Number.isSafeInteger(ticketNo) || ticketNo < 1 || !["open","closed"].includes(status)) return json(res, 400, { error: "حالة التذكرة غير صالحة." });
      const key = "maker_support_ticket_" + ticketNo, ticket = await db.get(key);
      if (!ticket) return json(res, 404, { error: "التذكرة غير موجودة." });
      ticket.status = status; ticket.updatedAt = Date.now(); ticket.closedBy = status === "closed" ? req.session.user.id : null;
      await db.set(key, ticket); json(res, 200, { success: true, status });
    } catch (error) { console.error("[Support ticket status]", error); json(res, 500, { error: "تعذر تحديث حالة التذكرة." }); }
  });
  app.get("/dashboard/api/maker/console", requireUser, requireMaker, async (_req, res) => {
    try {
      const logs = await db.get("maker_host_console_logs") || [];
      json(res, 200, { logs: Array.isArray(logs) ? logs.slice(-300).reverse() : [], source: "node-process" });
    } catch (error) { console.error("[Maker host console]", error.message); json(res, 500, { error: "تعذر تحميل سجل تشغيل الهوست." }); }
  });

  app.get("/dashboard/api/maker/trials", requireUser, requireMaker, async (_req, res) => {
    try {
      const rows = await db.all();
      const trials = (rows || []).filter(row => String(row.id || "").startsWith("maker_free_trial_") && row.value)
        .map(row => row.value)
        .sort((a, b) => Number(b.startDate || 0) - Number(a.startDate || 0));
      json(res, 200, { trials });
    } catch (error) { console.error("[Maker trials]", error); json(res, 500, { error: "تعذر تحميل فترات التشغيل التجريبية." }); }
  });

  app.post("/dashboard/api/maker/trials", requireUser, requireMaker, async (req, res) => {
    let token = "";
    try {
      token = String(req.body?.token || "").trim();
      const guildId = String(req.body?.guildId || "");
      const ownerId = String(req.body?.ownerId || "");
      const durationHours = Number(req.body?.durationHours);
      const allowedHours = new Set([1, 6, 12, 24, 72, 168]);
      if (!token || token.length > 300 || !snowflake(guildId) || !snowflake(ownerId) || !allowedHours.has(durationHours)) {
        return json(res, 400, { error: "تحقق من التوكن وآيدي السيرفر وآيدي المالك والمدة المحددة." });
      }
      if (!tokenVault.isConfigured()) return json(res, 503, { error: "مفتاح تشفير التوكنات غير مضبوط في الاستضافة." });
      const identityResponse = await fetch(DISCORD_API + "/users/@me", { headers: { Authorization: "Bot " + token } });
      if (!identityResponse.ok) return json(res, 400, { error: "التوكن غير صالح أو تعذر التحقق منه." });
      const identity = await identityResponse.json();
      if (!snowflake(identity.id) || identity.id === maker.MAKER_BOT_ID) return json(res, 400, { error: "لا يمكن استخدام بوت الميكر كتجربة." });
      const guildResponse = await fetch(DISCORD_API + "/guilds/" + guildId, { headers: { Authorization: "Bot " + token } });
      if (!guildResponse.ok) return json(res, 400, { error: "البوت غير موجود في السيرفر المحدد أو لا يستطيع الوصول إليه." });
      const trialKey = "maker_free_trial_" + identity.id;
      const existingTrial = await db.get(trialKey);
      if (existingTrial && existingTrial.status === "active" && Number(existingTrial.endDate) > Date.now()) return json(res, 409, { error: "لدى هذا البوت فترة تجريبية نشطة بالفعل." });
      const rows = await db.all();
      const paid = (rows || []).some(row => String(row.id || "").startsWith("premium_user_") && row.value?.botId === identity.id && row.value.active && Number(row.value.endDate) > Date.now());
      if (paid) return json(res, 409, { error: "هذا البوت لديه اشتراك Premium مدفوع نشط بالفعل." });
      const makerClient = getBot(maker.MAKER_BOT_ID);
      if (!makerClient?._registerPremiumBot) return json(res, 503, { error: "نظام تشغيل البوتات غير جاهز حالياً." });
      if (tokenVault.hasToken(token) || makerClient._hasRegisteredBotToken?.(token)) return json(res, 409, { error: "هذا التوكن مسجل مسبقاً في النظام." });
      tokenVault.addToken(token);
      let runtimeClient;
      try {
        runtimeClient = await makerClient._registerPremiumBot(token);
        if (!runtimeClient) throw new Error("Bot runtime was not created");
        runtimeClient._dashboardBotId = identity.id;
        runtimeClient._dashboardOwnerId = ownerId;
      } catch (error) {
        tokenVault.removeToken(token);
        throw error;
      }
      const now = Date.now();
      const trial = { botId: identity.id, botName: identity.username, guildId, ownerId, issuedBy: req.session.user.id, startDate: now, endDate: now + durationHours * 3600000, durationHours, active: true, status: "active", planLabel: "Premium مجاني مؤقت", createdAt: now };
      await db.set(trialKey, trial);
      json(res, 201, { created: true, trial });
    } catch (error) {
      console.error("[Maker free Premium trial]", error.message);
      json(res, 500, { error: "تعذر إنشاء فترة Premium التجريبية وتشغيل البوت." });
    } finally { token = ""; }
  });

  app.post("/dashboard/api/maker/trials/:botId/revoke", requireUser, requireMaker, async (req, res) => {
    try {
      const botId = String(req.params.botId || "");
      if (!snowflake(botId)) return json(res, 400, { error: "آيدي البوت غير صالح." });
      const key = "maker_free_trial_" + botId, trial = await db.get(key);
      if (!trial) return json(res, 404, { error: "الفترة التجريبية غير موجودة." });
      trial.active = false; trial.status = "revoked"; trial.endDate = Math.min(Number(trial.endDate || Date.now()), Date.now()); trial.revokedAt = Date.now(); trial.revokedBy = req.session.user.id;
      await db.set(key, trial);
      const makerClient = getBot(maker.MAKER_BOT_ID);
      if (makerClient?._controlPremiumBot) await makerClient._controlPremiumBot(botId, false);
      json(res, 200, { revoked: true });
    } catch (error) { console.error("[Maker trial revoke]", error); json(res, 500, { error: "تعذر إيقاف الفترة التجريبية." }); }
  });

  app.post("/dashboard/api/maker/tokens", requireUser, requireMaker, async (req, res) => {
    let token = "";
    try {
      token = String(req.body?.token || "").trim();
      if (!token || token.length > 300) return json(res, 400, { error: "أدخل توكن بوت صالحاً." });
      if (!tokenVault.isConfigured()) return json(res, 503, { error: "مفتاح تشفير التوكنات غير مضبوط في الاستضافة." });
      const identityResponse = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bot " + token } });
      if (!identityResponse.ok) return json(res, 400, { error: "التوكن غير صالح أو لا يمكن التحقق منه." });
      const identity = await identityResponse.json();
      if (!snowflake(identity.id) || identity.id === maker.MAKER_BOT_ID) return json(res, 400, { error: "لا يمكن إضافة هذا البوت." });
      const makerClient = getBot(maker.MAKER_BOT_ID);
      if (tokenVault.hasToken(token) || makerClient?._hasRegisteredBotToken?.(token)) return json(res, 409, { error: "هذا التوكن مسجل مسبقاً." });
      if (!makerClient?._registerPremiumBot) return json(res, 503, { error: "نظام تشغيل البوتات غير جاهز حالياً." });
      tokenVault.addToken(token);
      try { const runtimeClient = await makerClient._registerPremiumBot(token); if (runtimeClient) runtimeClient._dashboardBotId = identity.id; } catch (error) { tokenVault.removeToken(token); throw error; }
      json(res, 201, { added: true, bot: { id: identity.id, username: identity.username } });
    } catch (error) { console.error("[Maker add bot token]", error.message); json(res, 500, { error: "تعذر إضافة البوت وتشغيله." }); }
    finally { token = ""; }
  });

  app.delete("/dashboard/api/maker/bots/:botId", requireUser, requireMaker, async (req, res) => {
    try {
      const botId = String(req.params.botId || "");
      if (!snowflake(botId) || botId === maker.MAKER_BOT_ID) return json(res, 400, { error: "لا يمكن حذف هذا البوت." });
      const client = bots.find(item => (item._dashboardBotId || item.user?.id) === botId);
      if (!client?._botToken) return json(res, 404, { error: "لم يتم العثور على توكن محفوظ لهذا البوت." });
      if (client._dashboardTokenSource !== "config") return json(res, 409, { error: "هذا التوكن مرتبط بمتغير أو إعداد أساسي في الاستضافة ولا يمكن حذفه من لوحة الميكر." });
      const rows = await db.all();
      const activePremium = (rows || []).some(row => String(row.id || "").startsWith("premium_user_") && row.value?.botId === botId && row.value.active && Number(row.value.endDate) > Date.now());
      if (activePremium) return json(res, 409, { error: "لا يمكن حذف بوت لديه اشتراك Premium نشط." });
      const removed = tokenVault.removeToken(client._botToken);
      if (!removed) return json(res, 409, { error: "هذا التوكن مُدار من متغيرات الاستضافة ولا يمكن حذفه من ملف الإعدادات." });
      if (client.isReady()) await client.destroy();
      if (client._dashboardTokenHash) await db.delete("maker_bot_control_" + client._dashboardTokenHash);
      const index = bots.indexOf(client); if (index >= 0) bots.splice(index, 1);
      json(res, 200, { deleted: true });
    } catch (error) { console.error("[Maker remove bot]", error); json(res, 500, { error: "تعذر حذف البوت." }); }
  });
  app.get("/dashboard/api/maker/overview", requireUser, requireMaker, async (_req, res) => {
    try {
      const rows = await db.all();
      const premiumRows = (rows || []).filter(row => String(row.id || "").startsWith("premium_user_") && row.value && typeof row.value === "object");
      const premiumRecords = premiumRows.map(row => row.value);
      const premiumBotIds = new Set(premiumRecords.map(record => String(record.botId || "")));
      const botList = bots.map(client => {
        const botId = client._dashboardBotId || client.user?.id || null;
        if (botId) client._dashboardBotId = botId;
        const subscription = premiumRecords.find(record => record.botId === botId);
        return { id: botId, username: client.user?.username || (botId ? "بوت غير متصل" : "بوت لم يسجل الدخول"), avatar: client.user?.displayAvatarURL?.({ size: 96 }) || null, ready: Boolean(client.isReady()), guildCount: client.guilds?.cache?.size || 0, ping: Number.isFinite(client.ws?.ping) ? client.ws.ping : null, uptime: client.uptime || null, kind: botId === maker.MAKER_BOT_ID ? "maker" : premiumBotIds.has(botId) ? "premium" : "standard", ownerId: subscription?.userId || client._dashboardOwnerId || null, canControl: Boolean(botId && botId !== maker.MAKER_BOT_ID && client._botToken), canDelete: Boolean(client._dashboardTokenSource === "config") };
      });
      const subscriptions = premiumRecords.map(record => ({ userId: String(record.userId || ""), botId: String(record.botId || ""), guildId: String(record.guildId || ""), plan: String(record.planLabel || record.plan || "Premium"), active: Boolean(record.active), startDate: Number(record.startDate || 0), endDate: Number(record.endDate || 0), status: record.active && Number(record.endDate) > Date.now() ? "active" : Number(record.endDate) <= Date.now() ? "expired" : "inactive", renewalCount: Number(record.renewalCount || 0), price: Number(record.price || 0) }));
      const settings = await db.get("premium_settings") || null;
      const pendingCount = (rows || []).filter(row => String(row.id || "").startsWith("premium_temp_")).length;
      const pendingRequests = (rows || []).filter(row => String(row.id || "").startsWith("premium_temp_") && row.value).map(row => ({ userId:String(row.value.userId || ""), plan:String(row.value.planLabel || row.value.plan || ""), price:Number(row.value.price || 0), botId:String(row.value.botId || ""), guildId:String(row.value.guildId || ""), channelId:String(row.value.channelId || ""), timestamp:Number(row.value.timestamp || 0), tokenStored:Boolean(row.value.botTokenEncrypted) }));
      const logs = bots.flatMap(client => (client._makerLogs || []).map(log => ({ ...log, botId:client._dashboardBotId || client.user?.id || null, botName:client.user?.username || "بوت غير متصل" }))).sort((a,b)=>b.at-a.at).slice(0,50);
      const trials = (rows || []).filter(row => String(row.id || "").startsWith("maker_free_trial_") && row.value).map(row => row.value).sort((a,b)=>Number(b.startDate||0)-Number(a.startDate||0));
      const hostConsoleLogs = await db.get("maker_host_console_logs") || [];
      json(res, 200, { trials, hostConsoleLogs: Array.isArray(hostConsoleLogs) ? hostConsoleLogs.slice(-300).reverse() : [], stats: { totalBots: botList.length, readyBots: botList.filter(bot => bot.ready).length, totalGuilds: botList.reduce((sum, bot) => sum + bot.guildCount, 0), totalSubscriptions: subscriptions.length, activeSubscriptions: subscriptions.filter(item => item.status === "active").length, pendingPremiumRequests: pendingCount }, bots: botList, subscriptions: subscriptions.sort((a, b) => b.endDate - a.endDate), pendingRequests, logs, storedTokenCount: tokenVault.countTokens(), premiumSettings: settings ? { guildId: settings.guildId || null, bankId: settings.bankId || null, logChannelId: settings.logChannelId || null, premiumRoleId: settings.premiumRoleId || null, notificationChannelId: settings.notificationChannelId || null, ticketCategoryId: settings.ticketCategoryId || null, priceMonthly: Number(settings.priceMonthly || 0), price3Months: Number(settings.price3Months || 0), setupDate: Number(settings.setupDate || 0) } : null, tokenEncryptionConfigured: Boolean(process.env.TOKEN_ENCRYPTION_KEY) });
    } catch (error) { console.error("[Maker dashboard overview]", error); json(res, 500, { error: "تعذر تحميل بيانات الميكر." }); }
  });

  app.post("/dashboard/api/maker/bots/:botId/action", requireUser, requireMaker, async (req, res) => {
    try {
      const botId = String(req.params.botId || ""), action = String(req.body?.action || "");
      if (!snowflake(botId) || !["start", "stop", "restart"].includes(action)) return json(res, 400, { error: "إجراء البوت أو معرّفه غير صالح." });
      if (botId === maker.MAKER_BOT_ID) return json(res, 403, { error: "لا يمكن إيقاف بوت الميكر من لوحته." });
      const client = bots.find(item => (item._dashboardBotId || item.user?.id) === botId);
      if (!client) return json(res, 404, { error: "لم يتم العثور على عميل هذا البوت في قائمة التشغيل الحالية." });
      if (!client._botToken) return json(res, 409, { error: "لا يتوفر توكن تشغيل محفوظ لهذا البوت؛ لم يتم تنفيذ أي تغيير." });
      const controlKey = client._dashboardTokenHash ? "maker_bot_control_" + client._dashboardTokenHash : null;
      if (action === "stop") {
        if (!client.isReady()) return json(res, 409, { error: "البوت متوقف بالفعل." });
        if (controlKey) await db.set(controlKey, { botId, stopped:true, updatedAt:Date.now(), reason:"maker_manual" });
        client._dashboardBotId = botId; await client.destroy();
        return json(res, 200, { success: true, status: "stopped" });
      }
      if (action === "start" && client.isReady()) return json(res, 409, { error: "البوت يعمل بالفعل." });
      if (controlKey) await db.set(controlKey, { botId, stopped:false, updatedAt:Date.now(), reason:"maker_manual" });
      if (action === "restart" && client.isReady()) { client._dashboardBotId = botId; await client.destroy(); }
      await client.login(client._botToken); client._dashboardBotId = botId;
      return json(res, 200, { success: true, status: action === "start" ? "started" : "restarted" });
    } catch (error) { console.error("[Maker bot lifecycle]", error); json(res, 500, { error: "تعذر تنفيذ إجراء البوت. راجع سجل الاستضافة." }); }
  });

  app.post("/dashboard/api/maker/premium/:userId/extend", requireUser, requireMaker, async (req, res) => {
    try {
      const userId = String(req.params.userId || ""), days = Number(req.body?.days || 30);
      if (!snowflake(userId) || !Number.isInteger(days) || days < 1 || days > 3650) return json(res, 400, { error: "المستخدم أو عدد أيام التمديد غير صالح." });
      const key = "premium_user_" + userId, record = await db.get(key);
      if (!record) return json(res, 404, { error: "لم يتم العثور على اشتراك لهذا المستخدم." });
      record.endDate = Math.max(Date.now(), Number(record.endDate || 0)) + days * 86400000; record.active = true; record.notified3d = false; record.notified24h = false;
      await db.set(key, record);
      const makerClient = getBot(maker.MAKER_BOT_ID);
      if (makerClient?._controlPremiumBot) await makerClient._controlPremiumBot(record.botId, true).catch(error => console.error("[Maker premium restart]", error.message));
      json(res, 200, { success: true, endDate: record.endDate, active: true });
    } catch (error) { console.error("[Maker premium extend]", error); json(res, 500, { error: "تعذر تمديد الاشتراك." }); }
  });

  app.post("/dashboard/api/maker/premium/:userId/transfer", requireUser, requireMaker, async (req, res) => {
    try {
      const userId = String(req.params.userId || ""), newOwnerId = String(req.body?.newOwnerId || "");
      if (!snowflake(userId) || !snowflake(newOwnerId) || userId === newOwnerId) return json(res, 400, { error: "معرّف المالك الجديد غير صالح." });
      const oldKey = "premium_user_" + userId, record = await db.get(oldKey);
      if (!record) return json(res, 404, { error: "الاشتراك غير موجود." });
      if (await db.get("premium_user_" + newOwnerId)) return json(res, 409, { error: "المالك الجديد لديه اشتراك مسجل بالفعل." });
      const makerClient = getBot(maker.MAKER_BOT_ID); if (makerClient?.users?.fetch) await makerClient.users.fetch(newOwnerId);
      await db.delete(oldKey); record.userId = newOwnerId; record.dashboardOwnerId = newOwnerId; await db.set("premium_user_" + newOwnerId, record);
      json(res, 200, { transferred: true, userId: newOwnerId });
    } catch (error) { console.error("[Maker premium transfer]", error.message); json(res, 400, { error: "تعذر نقل الملكية؛ تحقق من آيدي المستخدم." }); }
  });
  app.post("/dashboard/api/maker/premium/:userId/status", requireUser, requireMaker, async (req, res) => {
    try {
      const userId = String(req.params.userId || ""), active = req.body?.active;
      if (!snowflake(userId) || typeof active !== "boolean") return json(res, 400, { error: "بيانات حالة الاشتراك غير صالحة." });
      const key = "premium_user_" + userId, record = await db.get(key);
      if (!record) return json(res, 404, { error: "لم يتم العثور على الاشتراك." });
      if (active && Number(record.endDate || 0) <= Date.now()) return json(res, 409, { error: "انتهت مدة الاشتراك؛ مدده أولاً قبل إعادة تفعيله." });
      record.active = active; await db.set(key, record);
      const makerClient = getBot(maker.MAKER_BOT_ID);
      if (makerClient?._controlPremiumBot) await makerClient._controlPremiumBot(record.botId, active).catch(error => console.error("[Maker premium lifecycle]", error.message));
      json(res, 200, { success: true, active });
    } catch (error) { console.error("[Maker premium status]", error); json(res, 500, { error: "تعذر تحديث حالة الاشتراك." }); }
  });
  app.get("/dashboard", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/dashboard/login", (req, res) => {
    if (!requireOAuthConfig(res)) return;
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify guilds",
      state
    });
    res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
  });
  app.get("/dashboard/callback", async (req, res) => {
    try {
      if (!requireOAuthConfig(res)) return;
      if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) {
        return res.status(400).send("OAuth state validation failed. Return to the dashboard and try again.");
      }
      delete req.session.oauthState;
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: redirectUri
      });
      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!tokenResponse.ok) throw new Error("Discord OAuth token exchange failed: " + tokenResponse.status);
      const tokens = await tokenResponse.json();
      const user = await discordFetch(DISCORD_API + "/users/@me", tokens.access_token);
      req.session.regenerate(error => {
        if (error) return res.status(500).send("Unable to create a secure session.");
        req.session.user = { id: user.id, username: user.username, globalName: user.global_name, avatar: user.avatar };
        req.session.accessToken = tokens.access_token;
        req.session.refreshToken = tokens.refresh_token;
        req.session.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);
        req.session.save(saveError => {
          if (saveError) return res.status(500).send("Unable to save session.");
          res.redirect("/dashboard");
        });
      });
    } catch (error) {
      console.error("[Dashboard OAuth]", error.message);
      res.status(502).send("تعذر تسجيل الدخول عبر Discord. حاول مرة أخرى.");
    }
  });
  app.post("/dashboard/logout", (req, res) => req.session.destroy(() => {
    res.clearCookie("screentranslator.sid");
    res.status(204).end();
  }));

  app.get("/dashboard/api/me", async (req, res) => {
    if (!req.session.user) return json(res, 200, { authenticated: false });
    try {
      await developerIdsReady;
      const userId = req.session.user.id;
      const records = await getAllPremiumRecords();
      const trialRows = await db.all();
      const activeTrials = (trialRows || []).filter(row => String(row.id || "").startsWith("maker_free_trial_") && row.value?.active && Number(row.value.endDate) > Date.now()).map(row => row.value);
      const premiumAvailable = records.some(record =>
        record.userId === userId || record.dashboardOwnerId === userId
      ) || activeTrials.some(trial => trial.ownerId === userId);
      json(res, 200, {
        authenticated: true,
        user: req.session.user,
        developer: isDeveloper(userId),
        premiumAvailable
      });
    } catch (error) {
      console.error("[Dashboard account access]", error.message);
      json(res, 503, { error: "تعذر التحقق من حالة اشتراك Premium. حاول تحديث الصفحة." });
    }
  });

  app.get("/dashboard/api/bots", requireUser, async (req, res) => {
    try {
      const developer = isDeveloper(req.session.user.id);
      // Developer bot listing must not depend on the Premium database.
      // This keeps the developer workspace available even if Premium records are temporarily unavailable.
      let availableBots = bots.filter(client => client.user && client.isReady());
      if (developer) {
        availableBots = availableBots.filter(client => client.user.id !== maker.MAKER_BOT_ID);
      } else {
        const records = await getAllPremiumRecords();
        const premiumBotIds = new Set(records.map(record => record.botId).filter(Boolean));
        availableBots = availableBots.filter(client => client.user.id !== maker.MAKER_BOT_ID && !premiumBotIds.has(client.user.id));
        const visibleBots = [];
        for (const client of availableBots) {
          const ownerId = await getBotOwnerId(client);
          if (ownerId === req.session.user.id) visibleBots.push(client);
        }
        availableBots = visibleBots;
      }
      json(res, 200, { bots: availableBots.map(client => ({ id: client.user.id, username: client.user.username, avatar: client.user.displayAvatarURL({ size: 128 }), guildCount: client.guilds.cache.size })) });
    } catch (error) {
      console.error("[Dashboard bot list]", error && (error.stack || error.message) || error);
      json(res, 500, { error: "تعذر تحميل البوتات. راجع سجل الاستضافة لمعرفة سبب الخطأ." });
    }
  });

  app.get("/dashboard/api/guilds", requireUser, async (req, res) => {
    try {
      const requestedMode = String(req.query.mode || "normal");
      const mode = requestedMode === "premium" ? "premium" : requestedMode === "developer" ? "developer" : "normal";
      const developer = isDeveloper(req.session.user.id);
      const records = await getAllPremiumRecords();
      if (mode === "developer" && !developer) return json(res, 403, { error: "هذا القسم متاح للمبرمج فقط." });
      if (mode === "premium") {
        const userGuilds = await getUserGuilds(req);
        const manageableGuildIds = new Set(userGuilds.filter(item => hasGuildManagement(item.permissions, item.owner)).map(item => item.id));
        const owned = records.filter(record => (record.userId === req.session.user.id || record.dashboardOwnerId === req.session.user.id) && manageableGuildIds.has(record.guildId));
        const guilds = owned.map(record => {
          const bot = getBot(record.botId);
          const guild = bot && bot.guilds.cache.get(record.guildId);
          if (!guild) return null;
          return { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }), botId: bot.user.id, botName: bot.user.username, status: "available", plan: record.planLabel || "Premium", endDate: record.endDate };
        }).filter(Boolean);
        return json(res, 200, { mode, guilds, message: guilds.length ? null : "لا يوجد سيرفر مرتبط باشتراك Premium نشط." });
      }

      const botId = String(req.query.botId || "");
      const bot = getBot(botId);
      const premiumBotIds = new Set(records.map(record => record.botId).filter(Boolean));
      if (!bot || !bot.isReady() || (!developer && (bot.user.id === maker.MAKER_BOT_ID || premiumBotIds.has(bot.user.id)))) {
        return json(res, 400, { error: "البوت العادي المحدد غير متاح." });
      }
      if (!developer && await getBotOwnerId(bot) !== req.session.user.id) {
        return json(res, 403, { error: "هذا البوت غير مملوك لحسابك." });
      }

      const userGuilds = await getUserGuilds(req);
      const guilds = userGuilds.map(item => {
        const manageable = hasGuildManagement(item.permissions, item.owner);
        const present = bot.guilds.cache.has(item.id);
        return {
          id: item.id,
          name: item.name,
          icon: item.icon ? "https://cdn.discordapp.com/icons/" + item.id + "/" + item.icon + ".png?size=128" : null,
          manageable,
          botPresent: present,
          status: !manageable ? "no_permission" : present ? "manage" : "invite"
        };
      });
      json(res, 200, { mode, guilds });
    } catch (error) {
      console.error("[Dashboard guild list]", error.message);
      json(res, 502, { error: "تعذر جلب السيرفرات من Discord." });
    }
  });

  app.get("/dashboard/api/access", requireUser, async (req, res) => {
    try {
      const guildId = String(req.query.guildId || "");
      const requestedMode = String(req.query.mode || "normal");
      const mode = requestedMode === "premium" ? "premium" : requestedMode === "developer" ? "developer" : "normal";
      const botId = String(req.query.botId || "");
      if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "معرّف السيرفر غير صالح." });
      const bot = getBot(botId);
      if (!bot || !bot.isReady()) return json(res, 404, { error: "البوت غير متاح حالياً." });
      const guild = bot.guilds.cache.get(guildId);
      if (!guild) return json(res, 403, { error: "البوت غير موجود في هذا السيرفر." });
      const developer = isDeveloper(req.session.user.id);
      if (mode === "developer") {
        if (!developer) return json(res, 403, { error: "هذا القسم متاح للمبرمج فقط." });
        const userGuilds = await getUserGuilds(req);
        const membership = userGuilds.find(item => item.id === guildId);
        if (!membership || !hasGuildManagement(membership.permissions, membership.owner)) {
          return json(res, 403, { error: "لا توجد صلاحية لإدارة هذا السيرفر." });
        }
      } else if (mode === "premium") {
        const records = await getAllPremiumRecords();
        const allowed = records.some(record =>
          record.guildId === guildId &&
          record.botId === botId &&
          (record.userId === req.session.user.id || record.dashboardOwnerId === req.session.user.id)
        );
        if (!allowed) return json(res, 403, { error: "هذا السيرفر غير مرتبط باشتراك Premium نشط لحسابك." });
      } else {
        const records = await getAllPremiumRecords();
        const isPremiumBot = records.some(record => record.botId === botId);
        if (bot.user.id === maker.MAKER_BOT_ID || isPremiumBot) return json(res, 403, { error: "هذا البوت ليس ضمن البوتات العادية." });
        if (!developer && await getBotOwnerId(bot) !== req.session.user.id) {
          return json(res, 403, { error: "هذا البوت غير مملوك لحسابك." });
        }
        const userGuilds = await getUserGuilds(req);
        const membership = userGuilds.find(item => item.id === guildId);
        if (!membership || !hasGuildManagement(membership.permissions, membership.owner)) {
          return json(res, 403, { error: "لا توجد صلاحية لإدارة هذا السيرفر." });
        }
      }
      json(res, 200, { allowed: true, guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) }, bot: { id: bot.user.id, username: bot.user.username }, developer });
    } catch (error) {
      console.error("[Dashboard access check]", error.message);
      json(res, 502, { error: "تعذر التحقق من صلاحيات السيرفر." });
    }
  });

  app.get("/dashboard/api/premium", requireUser, async (req, res) => {
    try {
      const records = await getAllPremiumRecords();
      const guilds = records.filter(record => record.userId === req.session.user.id || record.dashboardOwnerId === req.session.user.id).map(record => ({
        guildId: record.guildId, botId: record.botId, active: record.active, endDate: record.endDate, plan: record.planLabel || record.plan
      }));
      json(res, 200, { subscriptions: guilds });
    } catch { json(res, 500, { error: "تعذر تحميل الاشتراكات." }); }
  });


  // Dashboard JSON APIs are mounted here so the bot's existing QuickDB keys stay canonical.

  const snowflake = value => typeof value === "string" && /^\d{17,20}$/.test(value);
  const fieldMap = {
    tickets: {
      logsRoom: ["logs", "channel"], orderRoom: ["orderroom", "channel"], auctionRoom: ["auctionroom", "channel"],
      shopCategory: ["catbuy_shop", "category"], auctionCategory: ["catbuy_auction", "category"], orderCategory: ["catbuy_order", "category"],
      rolesCategory: ["roles_cat", "category"], supportCategory: ["support_cat", "category"], scamRoom: ["scam_room", "channel"],
      commandsRoom: ["commandsRoom", "channel"], ratingChannel: ["rating_ch", "channel"],
      highStaff: ["highstaff", "role"], shopAdmin: ["shopad", "role"], orderAdmin: ["orderad", "role"],
      auctionAdmin: ["auctionad", "role"], rolesAdmin: ["roles_admin", "role"], supportAdmin: ["support_admin", "role"],
      scamAdmin: ["scam_admin", "role"], auctionMentionRole: ["auctionmzadrole", "role"], orderMentionRole: ["order-mentionrole", "role"],
      bankId: ["bank", "user"]
    },
    permissions: {
      highStaff: ["highstaff", "role"], shopAdmin: ["shopad", "role"], orderAdmin: ["orderad", "role"],
      auctionAdmin: ["auctionad", "role"], rolesAdmin: ["roles_admin", "role"], supportAdmin: ["support_admin", "role"],
      scamAdmin: ["scam_admin", "role"], warningStaffRole: ["warning_staff_role", "role"]
    },
    appearance: { embedColor: ["embed_color", "color"], imageUrl: ["image", "url"] },
    applications: {
      applyRoom: ["apply_room", "channel"], applyType: ["apply_type", "applyType"], applyRoles: ["apply_roles", "roles"],
      applyAdmin: ["apply_admin", "channel"], applyTicketCategory: ["apply_ticketcat", "category"],
      applyDisabled: ["apply_disabled", "boolean"], applyQuestions: ["apply_qs", "questions"]
    },
    stores: {
      shopAdmin: ["shopad", "role"], highStaff: ["highstaff", "role"],
      shopVacationPrice: ["shopvacation", "money"], disableAutoPrice: ["disableauto", "money"],
      activateShopPrice: ["activateshopprice", "money"], sellShopPrice: ["sellshopprice", "money"],
      autoMessagePrice: ["automessage", "money"]
    },
    auction: {
      auctionAdmin: ["auctionad", "role"], auctionRoom: ["auctionroom", "channel"],
      auctionMentionRole: ["auctionmzadrole", "role"], auctionRules: ["mzad_rules", "words"],
      auctionInfo: ["mzad_info", "longText"], middlemanLink: ["mzad_middleman_link", "url"],
      publicAuctionCategory: ["mzad2_pub_cat", "category"], privateAuctionCategory: ["mzad2_ticket_cat", "category"]
    },
    orders: {
      orderAdmin: ["orderad", "role"], orderRoom: ["orderroom", "channel"],
      orderMentionRole: ["order-mentionrole", "role"], orderEveryPrice: ["order-evrypri", "money"],
      orderHerePrice: ["order-herepri", "money"], orderBasePrice: ["order-orderpri", "money"]
    },
    shortcuts: {
      mention: ["shortcut_mention", "string"], warning: ["shortcut_warning", "string"],
      delete: ["shortcut_delete", "string"], tax: ["shortcut_tax", "string"],
      call: ["shortcut_call", "string"], ping: ["shortcut_ping", "string"],
      setShopOwner: ["shortcut_setshopowner", "string"], addMentions: ["shortcut_addmentions", "string"],
      setMentions: ["shortcut_setmentions", "string"], addShopData: ["shortcut_addshopdata", "string"],
      createShop: ["shortcut_createshop", "string"]
    },
    pricing: {
      everyonePrice: ["evrypri", "money"], herePrice: ["herepri", "money"],
      shopMentionPrice: ["shopprice", "money"], orderEveryonePrice: ["order-evrypri", "money"],
      orderHerePrice: ["order-herepri", "money"], orderBasePrice: ["order-orderpri", "money"],
      auctionEveryonePrice: ["auction-evrypri", "money"], auctionHerePrice: ["auction-herepri", "money"],
      auctionBidPrice: ["auction-mzadpri", "money"], changeNamePrice: ["changename", "money"],
      changeOwnerPrice: ["changeowner", "money"], rolePrice: ["customroleprice", "money"]
    },
    rules: {
      serverRules: ["server_rules", "words"], rulesImage: ["rulesImage", "url"],
      auctionRules: ["mzad_rules", "words"]
    },
    showcase: { publicShowcase: ["dashboard_public_showcase", "boolean"] },
    ratings: { ratingChannel: ["rating_ch", "channel"] },
    auto: {
      forbiddenWords: ["forbidden_words", "words"], forbiddenMode: ["forbidden_words_mode", "mode"],
      forbiddenRoom: ["forbidden_words_room", "channel"], warningStaffRole: ["warning_staff_role", "role"],
      autoDisable: ["auto_disable", "boolean"], warnLimit: ["warn_limit", "number"],
      resetDays: ["auto_mention_reset", "resetDays"], resetRoom: ["auto_mention_reset", "resetRoom"],
      resetMessage: ["auto_mention_reset", "resetMessage"], resetType: ["auto_mention_reset", "resetType"],
      shortcutCall: ["shortcut_call", "string"], shortcutTax: ["shortcut_tax", "string"],
      taxChannel: ["tax-channel", "channel"], emojiChannel: ["emoji-channel", "channel"]
    }
  };

  async function resolveWorkspace(req, res, input) {
    const guildId = String(input.guildId || "");
    const botId = String(input.botId || "");
    const requestedMode = String(input.mode || "normal");
    const mode = requestedMode === "premium" ? "premium" : requestedMode === "developer" ? "developer" : "normal";
    if (!snowflake(guildId) || !snowflake(botId)) {
      json(res, 400, { error: "معرّف السيرفر أو البوت غير صالح." });
      return null;
    }
    const bot = getBot(botId);
    if (!bot || !bot.isReady()) {
      json(res, 404, { error: "البوت غير متصل حالياً." });
      return null;
    }
    const guild = bot.guilds.cache.get(guildId);
    if (!guild) {
      json(res, 403, { error: "البوت غير موجود في السيرفر المحدد." });
      return null;
    }
    const developer = isDeveloper(req.session.user.id);
    if (mode === "developer") {
      if (!developer) {
        json(res, 403, { error: "هذا القسم متاح للمبرمج فقط." });
        return null;
      }
      const userGuilds = await getUserGuilds(req);
      const membership = userGuilds.find(item => item.id === guildId);
      if (!membership || !hasGuildManagement(membership.permissions, membership.owner)) {
        json(res, 403, { error: "لا تملك صلاحية إدارة هذا السيرفر." });
        return null;
      }
    } else if (mode === "premium") {
      const records = await getAllPremiumRecords();
      const allowed = records.some(record => record.guildId === guildId && record.botId === botId &&
        (record.userId === req.session.user.id || record.dashboardOwnerId === req.session.user.id));
      if (!allowed) {
        json(res, 403, { error: "السيرفر غير مرتبط باشتراك Premium نشط لحسابك." });
        return null;
      }
      const userGuilds = await getUserGuilds(req);
      const membership = userGuilds.find(item => item.id === guildId);
      if (!membership || !hasGuildManagement(membership.permissions, membership.owner)) {
        json(res, 403, { error: "يجب أن تملك صلاحية إدارة السيرفر المرتبط باشتراك Premium." });
        return null;
      }
    } else {
      const records = await getAllPremiumRecords();
      if (bot.user.id === maker.MAKER_BOT_ID || records.some(record => record.botId === botId)) {
        json(res, 403, { error: "هذا البوت ليس بوتاً عادياً." });
        return null;
      }
      if (!developer && await getBotOwnerId(bot) !== req.session.user.id) {
        json(res, 403, { error: "هذا البوت غير مملوك لحسابك." });
        return null;
      }
      if (!developer) {
        const userGuilds = await getUserGuilds(req);
        const membership = userGuilds.find(item => item.id === guildId);
        if (!membership || !hasGuildManagement(membership.permissions, membership.owner)) {
          json(res, 403, { error: "لا تملك صلاحية إدارة هذا السيرفر." });
          return null;
        }
      }
    }
    return { bot, guild, developer, guildId, botId, mode };
  }

  const getGuildValue = async (guildId, field, section) => {
    const spec = fieldMap[section]?.[field];
    if (!spec) return null;
    const [key, type] = spec;
    if (section === "auto" && key === "auto_mention_reset") {
      const cfg = await db.get(key + "_" + guildId) || {};
      return type === "resetDays" ? (cfg.days || "") :
        type === "resetRoom" ? (cfg.roomId || "") :
        type === "resetMessage" ? (cfg.message || "") : (cfg.type || "");
    }
    if (type === "questions") return await db.get(key + "_" + guildId) || {};
    return await db.get(key + "_" + guildId);
  };

  const audit = async (guildId, user, section, changes) => {
    try {
      const key = "dashboard_audit_" + guildId;
      const rows = await db.get(key) || [];
      rows.unshift({ at: Date.now(), userId: user.id, username: user.username, section, changes });
      await db.set(key, rows.slice(0, 100));
    } catch (error) {
      console.warn("[Dashboard audit]", error.message);
    }
  };

  app.get("/dashboard/api/premium/exchange", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.query); if (!access) return; if (access.mode !== "premium") return json(res, 403, { error: "هذه الميزة متاحة لبوتات Premium فقط." });
      const cfg = await db.get("xch_cfg_" + access.guildId) || { enabled:false, allowedRoles:[], rooms:[], schedule:"*/15 * * * *", userLimit:5, price:0, transferRoom:null, bankId:null, logRoom:null, totalPublished:0 };
      json(res, 200, { config: cfg });
    } catch (error) { console.error("[Premium exchange get]", error); json(res, 500, { error: "تعذر تحميل إعدادات التبادل." }); }
  });

  app.post("/dashboard/api/premium/exchange", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.body || {}); if (!access) return; if (access.mode !== "premium") return json(res, 403, { error: "هذه الميزة متاحة لبوتات Premium فقط." });
      await access.guild.channels.fetch().catch(() => {}); await access.guild.roles.fetch().catch(() => {});
      const body = req.body || {}, current = await db.get("xch_cfg_" + access.guildId) || {};
      const schedules = ["*/5 * * * *","*/10 * * * *","*/15 * * * *","*/30 * * * *","0 * * * *","0 */2 * * *","0 */6 * * *","0 */12 * * *"];
      const allowedRoles = Array.isArray(body.allowedRoles) ? [...new Set(body.allowedRoles)] : [];
      const rooms = Array.isArray(body.rooms) ? [...new Set(body.rooms)] : [];
      const userLimit = Number(body.userLimit), price = Number(body.price);
      if (allowedRoles.length > 25 || allowedRoles.some(id => !snowflake(id) || !access.guild.roles.cache.has(id))) return json(res, 400, { error: "قائمة رتب التبادل غير صالحة." });
      if (rooms.length > 25 || rooms.some(id => !snowflake(id) || ![0,5].includes(access.guild.channels.cache.get(id)?.type))) return json(res, 400, { error: "قائمة قنوات التبادل غير صالحة." });
      for (const id of [body.transferRoom, body.logRoom]) if (id && (!snowflake(id) || ![0,5].includes(access.guild.channels.cache.get(id)?.type))) return json(res, 400, { error: "روم التحويل أو اللوق غير صالح." });
      if (body.bankId && !snowflake(String(body.bankId))) return json(res, 400, { error: "آيدي البنك غير صالح." });
      if (!schedules.includes(String(body.schedule)) || !Number.isInteger(userLimit) || userLimit < 1 || userLimit > 100 || !Number.isInteger(price) || price < 0 || price > 1000000000) return json(res, 400, { error: "الوقت أو الحد أو السعر غير صالح." });
      const cfg = { ...current, enabled:Boolean(body.enabled), allowedRoles, rooms, schedule:String(body.schedule), userLimit, price, transferRoom:body.transferRoom || null, bankId:body.bankId || null, logRoom:body.logRoom || null };
      await db.set("xch_cfg_" + access.guildId, cfg);
      if (typeof access.bot._dashboardRefreshExchangeCron === "function") await access.bot._dashboardRefreshExchangeCron(access.guildId);
      await audit(access.guildId, req.session.user, "premium-exchange", ["تحديث إعدادات نظام التبادل"]); json(res, 200, { saved:true, config:cfg });
    } catch (error) { console.error("[Premium exchange save]", error); json(res, 500, { error: "تعذر حفظ إعدادات التبادل." }); }
  });

  app.get("/dashboard/api/premium/private-auction", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.query); if (!access) return; if (access.mode !== "premium") return json(res, 403, { error: "المزاد الخاص متاح لبوتات Premium فقط." });
      json(res, 200, { types: await db.get("mzad2_types_" + access.guildId) || [], ticketCategory: await db.get("mzad2_ticket_cat_" + access.guildId) || "", roomCategory: await db.get("mzad2_pub_cat_" + access.guildId) || "" });
    } catch (error) { console.error("[Premium private auction get]", error); json(res, 500, { error: "تعذر تحميل أنواع المزاد الخاص." }); }
  });

  app.post("/dashboard/api/premium/private-auction", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.body || {}); if (!access) return; if (access.mode !== "premium") return json(res, 403, { error: "المزاد الخاص متاح لبوتات Premium فقط." });
      await access.guild.channels.fetch().catch(() => {});
      const body = req.body || {}, types = Array.isArray(body.types) ? body.types : [];
      if (types.length > 25) return json(res, 400, { error: "الحد الأقصى 25 نوع مزاد." });
      const normalized = types.map(t => ({ name:String(t.name || "").trim().slice(0,50), hours:Number(t.hours), every:Number(t.every || 0), here:Number(t.here || 0), price:Number(t.price), notice:String(t.notice || "").slice(0,1000) }));
      if (normalized.some(t => !t.name || !Number.isInteger(t.hours) || t.hours < 1 || t.hours > 168 || !Number.isInteger(t.every) || t.every < 0 || t.every > 1000 || !Number.isInteger(t.here) || t.here < 0 || t.here > 1000 || !Number.isInteger(t.price) || t.price < 0 || t.price > 1000000000) || new Set(normalized.map(t => t.name.toLowerCase())).size !== normalized.length) return json(res, 400, { error: "بيانات أنواع المزاد غير صالحة أو الأسماء مكررة." });
      for (const id of [body.ticketCategory, body.roomCategory]) if (id && (!snowflake(id) || access.guild.channels.cache.get(id)?.type !== 4)) return json(res, 400, { error: "اختر كاتيغوري صحيحاً." });
      await db.set("mzad2_types_" + access.guildId, normalized);
      if (body.ticketCategory) await db.set("mzad2_ticket_cat_" + access.guildId, body.ticketCategory); else await db.delete("mzad2_ticket_cat_" + access.guildId);
      if (body.roomCategory) await db.set("mzad2_pub_cat_" + access.guildId, body.roomCategory); else await db.delete("mzad2_pub_cat_" + access.guildId);
      await audit(access.guildId, req.session.user, "premium-private-auction", ["تحديث أنواع وإعدادات المزاد الخاص"]); json(res, 200, { saved:true, types:normalized });
    } catch (error) { console.error("[Premium private auction save]", error); json(res, 500, { error: "تعذر حفظ إعدادات المزاد الخاص." }); }
  });

  app.get("/dashboard/api/premium/promotions", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.query); if (!access) return; if (access.mode !== "premium") return json(res, 403, { error: "نظام نقاط وترقيات الإدارة متاح لبوتات Premium فقط." });
      const memberships = await getUserGuilds(req); if (!memberships.some(item => item.id === access.guildId && item.owner)) return json(res, 403, { error: "إعدادات الترقيات متاحة لمالك السيرفر فقط." });
      const rows = await db.all(), suffix = "_" + access.guildId;
      const points = (rows || []).filter(row => String(row.id || "").startsWith("ticket_pts_") && String(row.id).endsWith(suffix)).map(row => ({ userId:String(row.id).slice("ticket_pts_".length, -suffix.length), points:Number(row.value || 0) })).sort((a,b)=>b.points-a.points).slice(0,50);
      json(res, 200, { points, levels: await db.get("ticket_promotion_levels_" + access.guildId) || [] });
    } catch (error) { console.error("[Premium promotions get]", error); json(res, 500, { error: "تعذر تحميل نقاط الإدارة." }); }
  });

  app.post("/dashboard/api/premium/promotions", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.body || {}); if (!access) return; if (access.mode !== "premium") return json(res, 403, { error: "نظام نقاط وترقيات الإدارة متاح لبوتات Premium فقط." });
      const memberships = await getUserGuilds(req); if (!memberships.some(item => item.id === access.guildId && item.owner)) return json(res, 403, { error: "إعدادات الترقيات متاحة لمالك السيرفر فقط." });
      await access.guild.roles.fetch().catch(() => {});
      const levels = Array.isArray(req.body?.levels) ? req.body.levels : [];
      const botMember = await access.guild.members.fetchMe().catch(() => null);
      if (!botMember || !botMember.permissions.has("ManageRoles")) return json(res, 403, { error: "يحتاج البوت إلى صلاحية Manage Roles لتطبيق الترقيات." });
      if (levels.length > 20 || levels.some(level => {
        const roleId = String(level.roleId || ""), role = access.guild.roles.cache.get(roleId);
        return !Number.isInteger(Number(level.points)) || Number(level.points) < 1 || Number(level.points) > 100000 || !snowflake(roleId) || !role || role.managed || role.position >= botMember.roles.highest.position;
      })) return json(res, 400, { error: "مستويات الترقية أو الرتب غير صالحة أو أعلى من رتبة البوت." });
      const normalized = levels.map(level => ({ points:Number(level.points), roleId:String(level.roleId) })).sort((a,b)=>a.points-b.points);
      if (new Set(normalized.map(level => level.points)).size !== normalized.length || new Set(normalized.map(level => level.roleId)).size !== normalized.length) return json(res, 400, { error: "لا تكرر عدد النقاط أو الرتبة في مستويات الترقية." });
      await db.set("ticket_promotion_levels_" + access.guildId, normalized); await audit(access.guildId, req.session.user, "premium-promotions", ["تحديث مستويات ترقية الإدارة"]); json(res, 200, { saved:true, levels:normalized });
    } catch (error) { console.error("[Premium promotions save]", error); json(res, 500, { error: "تعذر حفظ مستويات الترقية." }); }
  });
  app.get("/dashboard/api/identity", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const me = await access.guild.members.fetchMe().catch(() => null);
      json(res, 200, {
        botName: access.bot.user.username,
        avatar: access.bot.user.displayAvatarURL({ size: 256 }),
        nickname: me?.nickname || "",
        guildName: access.guild.name
      });
    } catch (error) {
      console.error("[Dashboard identity]", error.message);
      json(res, 500, { error: "تعذر تحميل هوية البوت." });
    }
  });

  app.post("/dashboard/api/identity", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const nickname = String(req.body?.nickname || "").trim();
      const avatarUrl = String(req.body?.avatarUrl || "").trim();
      if (nickname.length > 32) return json(res, 400, { error: "اسم البوت داخل السيرفر يجب ألا يتجاوز 32 حرفاً." });
      if (avatarUrl) {
        let parsed;
        try { parsed = new URL(avatarUrl); } catch { return json(res, 400, { error: "رابط الصورة غير صالح." }); }
        const allowedHosts = new Set(["cdn.discordapp.com", "media.discordapp.net", "i.imgur.com"]);
        if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname) || parsed.href.length > 500) {
          return json(res, 400, { error: "ارفع الصورة إلى Discord CDN أو Imgur واستخدم رابط HTTPS مباشر." });
        }
      }
      const me = await access.guild.members.fetchMe();
      const currentNickname = me.nickname || "";
      if (nickname !== currentNickname && !me.permissions.has("ManageNicknames")) {
        return json(res, 403, { error: "البوت يحتاج صلاحية Manage Nicknames لتغيير اسمه داخل السيرفر." });
      }
      if (nickname !== currentNickname) await me.setNickname(nickname || null, "Dashboard bot identity update");
      if (avatarUrl) await access.bot.user.setAvatar(avatarUrl);
      await audit(access.guildId, req.session.user, "identity", [
        ...(nickname !== currentNickname ? ["تحديث الاسم الظاهر للبوت"] : []),
        ...(avatarUrl ? ["تحديث صورة حساب البوت"] : [])
      ]);
      json(res, 200, { saved: true, nickname, avatar: access.bot.user.displayAvatarURL({ size: 256 }) });
    } catch (error) {
      console.error("[Dashboard identity update]", error.message);
      json(res, 500, { error: "تعذر تحديث اسم البوت. تحقق من صلاحياته وترتيب رتبته." });
    }
  });

  app.get("/dashboard/api/tickets", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const entries = await db.all();
      const prefixes = [
        ["shop_ticket_channel_", "متجر"],
        ["auction_ticket_channel_", "مزاد"],
        ["order_ticket_channel_", "طلب"],
        ["roles_ticket_channel_", "رتبة"],
        ["support_ticket_ch_", "دعم / بلاغ"]
      ];
      const tickets = [];
      for (const entry of entries || []) {
        const key = String(entry.id || "");
        const prefix = prefixes.find(([value]) => key.startsWith(value));
        if (!prefix) continue;
        const value = entry.value || {};
        if (value.guildId !== access.guildId) continue;
        const channelId = key.slice(prefix[0].length);
        const channel = await access.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;
        tickets.push({ channelId, channelName: channel.name, type: value.type === "scam" ? "بلاغ" : prefix[1], ticketNum: value.ticketNum || null, status: value.status || "open", ownerId: value.ownerId || value.userId || null, createdAt: value.createdAt || null, url: "https://discord.com/channels/" + access.guildId + "/" + channelId });
      }
      json(res, 200, { tickets: tickets.slice(0, 100) });
    } catch (error) {
      console.error("[Dashboard tickets]", error.message);
      json(res, 500, { error: "تعذر تحميل التذاكر المفتوحة." });
    }
  });

  app.post("/dashboard/api/tickets/:channelId/action", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const channelId = String(req.params.channelId || "");
      const action = String(req.body?.action || "");
      if (!snowflake(channelId) || !["close", "reopen"].includes(action)) return json(res, 400, { error: "بيانات إجراء التذكرة غير صالحة." });
      const channel = await access.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.permissionOverwrites) return json(res, 404, { error: "قناة التذكرة غير موجودة أو لا تدعم الصلاحيات." });
      const prefixes = [
        { prefix: "shop_ticket_channel_", type: "shop", adminKey: "shopad_" },
        { prefix: "auction_ticket_channel_", type: "auction", adminKey: "auctionad_" },
        { prefix: "order_ticket_channel_", type: "order", adminKey: "orderad_" },
        { prefix: "roles_ticket_channel_", type: "roles", adminKey: "roles_admin_" },
        { prefix: "support_ticket_ch_", type: "support", adminKey: "support_admin_" }
      ];
      let match = null;
      for (const item of prefixes) { if (await db.get(item.prefix + channelId) != null) { match = item; break; } }
      if (!match) return json(res, 404, { error: "لم يتم العثور على سجل لهذه التذكرة." });
      const key = match.prefix + channelId;
      const meta = await db.get(key);
      if (!meta || meta.guildId !== access.guildId) return json(res, 404, { error: "سجل التذكرة لا يخص هذا السيرفر." });
      if (action === "close" && meta.status === "closed") return json(res, 409, { error: "التذكرة مغلقة بالفعل." });
      if (action === "reopen" && meta.status !== "closed") return json(res, 409, { error: "التذكرة ليست مغلقة." });
      const ownerId = String(meta.ownerId || meta.userId || "");
      if (!snowflake(ownerId)) return json(res, 409, { error: "لا يوجد صاحب معروف لهذه التذكرة؛ لم يتم تغيير الصلاحيات." });
      const adminKey = match.type === "support" && meta.type === "scam" ? "scam_admin_" : match.adminKey;
      const adminRoleId = await db.get(adminKey + access.guildId);
      const adminRole = adminRoleId ? access.guild.roles.cache.get(adminRoleId) : null;
      if (action === "close") {
        await channel.permissionOverwrites.edit(ownerId, { ViewChannel: false, SendMessages: false });
        if (adminRole) await channel.permissionOverwrites.edit(adminRole.id, { ViewChannel: true, SendMessages: true });
        meta.status = "closed";
        meta.closedAt = Date.now();
        meta.closedBy = req.session.user.id;
      } else {
        await channel.permissionOverwrites.edit(ownerId, { ViewChannel: true, SendMessages: true, EmbedLinks: true, AttachFiles: true });
        if (adminRole) await channel.permissionOverwrites.edit(adminRole.id, { ViewChannel: true, SendMessages: true, EmbedLinks: true, AttachFiles: true });
        meta.status = "open";
        meta.reopenedAt = Date.now();
        meta.reopenedBy = req.session.user.id;
      }
      await db.set(key, meta);
      if (meta.dbKey && meta.dbKey !== key) await db.set(meta.dbKey, meta);
      await audit(access.guildId, req.session.user, "tickets", [(action === "close" ? "إغلاق " : "إعادة فتح ") + channelId]);
      return json(res, 200, { saved: true, status: meta.status });
    } catch (error) {
      console.error("[Dashboard ticket action]", error);
      return json(res, 500, { error: "تعذر تحديث التذكرة. تحقق من صلاحيات البوت على القناة." });
    }
  });

  app.get("/dashboard/api/embed-templates", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const key = "dashboard_embed_templates_" + access.guildId + "_" + access.mode;
      json(res, 200, { templates: await db.get(key) || [] });
    } catch (error) {
      console.error("[Dashboard embed templates]", error.message);
      json(res, 500, { error: "تعذر تحميل قوالب الإمبد." });
    }
  });

  app.post("/dashboard/api/embeds", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const { action, channelId } = req.body || {};
      const title = String(req.body?.title || "").trim().slice(0, 256);
      const description = String(req.body?.description || "").trim().slice(0, 4000);
      const footer = String(req.body?.footer || "").trim().slice(0, 2048);
      const imageUrl = String(req.body?.imageUrl || "").trim();
      const rawColor = String(req.body?.color || "#5865F2").trim();
      if (!title && !description) return json(res, 400, { error: "أدخل عنواناً أو وصفاً للإمبد." });
      if (!/^#?[0-9a-fA-F]{6}$/.test(rawColor)) return json(res, 400, { error: "لون الإمبد غير صالح." });
      if (imageUrl && (!/^https:\/\/\S+$/i.test(imageUrl) || imageUrl.length > 500)) return json(res, 400, { error: "رابط الصورة يجب أن يبدأ بـ HTTPS." });
      const template = { id: crypto.randomUUID(), title, description, footer, imageUrl, color: rawColor.startsWith("#") ? rawColor : "#" + rawColor, updatedAt: Date.now() };
      const key = "dashboard_embed_templates_" + access.guildId + "_" + access.mode;
      if (action === "save") {
        const templates = await db.get(key) || [];
        templates.unshift(template);
        await db.set(key, templates.slice(0, access.mode === "premium" ? 50 : 20));
        await audit(access.guildId, req.session.user, "embeds", ["حفظ قالب " + (title || "بدون عنوان")]);
        return json(res, 200, { saved: true, template });
      }
      if (action !== "send") return json(res, 400, { error: "الإجراء غير معروف." });
      if (!snowflake(channelId)) return json(res, 400, { error: "اختر روم إرسال صحيحاً." });
      const channel = access.guild.channels.cache.get(channelId);
      if (!channel || ![0,5].includes(channel.type)) return json(res, 400, { error: "روم الإرسال غير صالح." });
      const { EmbedBuilder } = require("discord.js");
      const embed = new EmbedBuilder().setColor(parseInt(template.color.replace("#", ""), 16));
      if (title) embed.setTitle(title);
      if (description) embed.setDescription(description);
      if (footer) embed.setFooter({ text: footer });
      if (imageUrl) embed.setImage(imageUrl);
      const message = await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
      });
      await audit(access.guildId, req.session.user, "embeds", ["إرسال إمبد " + (title || "بدون عنوان") + " في " + channelId]);
      json(res, 200, { sent: true, url: message.url, template });
    } catch (error) {
      console.error("[Dashboard embed send]", error.message);
      json(res, 500, { error: "تعذر حفظ أو إرسال الإمبد. تحقق من صلاحيات البوت." });
    }
  });

  app.get("/dashboard/api/store-types", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const entries = await db.all();
      const suffix = "_" + access.guildId;
      const types = [];
      for (const entry of entries || []) {
        const key = String(entry.id || "");
        if (!key.startsWith("categoryMentions_") || !key.endsWith(suffix)) continue;
        const categoryId = key.slice("categoryMentions_".length, -suffix.length);
        const category = access.guild.channels.cache.get(categoryId);
        const value = entry.value || {};
        types.push({
          categoryId, categoryName: category?.name || "كاتيغوري غير موجود",
          name: String(value.nametype || ""), everyoneMentions: Number(value.everyoneMentions || 0),
          hereMentions: Number(value.hereMentions || 0), shopRoleMentions: Number(value.shopRoleMentions || 0),
          pirefix: String(value.pirefix || ""), shopEmoji: String(value.shopEmoji || ""),
          shoprole: value.shoprole || "", shopmen: value.shopmen || "",
          maxWarns: Number(value.maxWarns || 0), hasTax: Boolean(value.hasTax),
          taxPrice: Number(value.taxPrice || 0), shopPrice: Number(value.shopPrice || 0)
        });
      }
      json(res, 200, { types });
    } catch (error) {
      console.error("[Dashboard store types]", error.message);
      json(res, 500, { error: "تعذر تحميل أنواع المتاجر." });
    }
  });

  app.post("/dashboard/api/store-types", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const body = req.body || {};
      const categoryId = String(body.categoryId || "");
      const name = String(body.name || "").trim().slice(0, 60);
      const count = (value, max, label) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(label + " غير صالح.");
        return n;
      };
      if (!snowflake(categoryId)) return json(res, 400, { error: "اختر كاتيغوري صحيحاً." });
      const category = access.guild.channels.cache.get(categoryId);
      if (!category || category.type !== 4) return json(res, 400, { error: "الكاتيغوري المحدد غير موجود." });
      if (!name) return json(res, 400, { error: "اكتب اسم نوع المتجر." });
      const shoprole = String(body.shoprole || "");
      const shopmen = String(body.shopmen || "");
      if (![shoprole, shopmen].every(id => snowflake(id) && access.guild.roles.cache.has(id) && !access.guild.roles.cache.get(id).managed)) {
        return json(res, 400, { error: "اختر رتبتي المتجر والمنشن من رتب السيرفر." });
      }
      const hasTax = Boolean(body.hasTax);
      const taxPrice = count(body.taxPrice ?? 0, 1000000000, "سعر الضريبة");
      if (hasTax && taxPrice < 1) return json(res, 400, { error: "سعر الضريبة مطلوب عند تفعيلها." });
      const value = {
        categoryId, nametype: name,
        everyoneMentions: count(body.everyoneMentions ?? 0, 9999, "عدد Everyone"),
        hereMentions: count(body.hereMentions ?? 0, 9999, "عدد Here"),
        shopRoleMentions: count(body.shopRoleMentions ?? 0, 9999, "عدد منشن المتجر"),
        pirefix: String(body.pirefix || "").trim().slice(0, 24),
        shopEmoji: String(body.shopEmoji || "").trim().slice(0, 64),
        shoprole, shopmen, maxWarns: count(body.maxWarns ?? 0, 999, "حد التحذيرات"),
        hasTax, taxPrice: hasTax ? taxPrice : 0,
        shopPrice: count(body.shopPrice ?? 0, 1000000000, "سعر المتجر"),
        guildId: access.guildId
      };
      await db.set("categoryMentions_" + categoryId + "_" + access.guildId, value);
      await audit(access.guildId, req.session.user, "store-types", ["حفظ نوع " + name]);
      json(res, 200, { saved: true, type: value });
    } catch (error) {
      const message = error.message || "";
      if (/غير صالح|مطلوب|اختر|اكتب/.test(message)) return json(res, 400, { error: message });
      console.error("[Dashboard save store type]", error);
      json(res, 500, { error: "تعذر حفظ نوع المتجر." });
    }
  });

  app.delete("/dashboard/api/store-types/:categoryId", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const categoryId = String(req.params.categoryId || "");
      if (!snowflake(categoryId)) return json(res, 400, { error: "معرّف الكاتيغوري غير صالح." });
      await db.delete("categoryMentions_" + categoryId + "_" + access.guildId);
      await audit(access.guildId, req.session.user, "store-types", ["حذف تعريف نوع " + categoryId]);
      json(res, 200, { deleted: true });
    } catch (error) {
      console.error("[Dashboard delete store type]", error.message);
      json(res, 500, { error: "تعذر حذف نوع المتجر." });
    }
  });

  app.get("/dashboard/api/operations", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const entries = await db.all();
      const suffix = "_" + access.guildId;
      const stores = [];
      const types = [];
      const orders = [];
      const auctions = [];
      for (const entry of entries || []) {
        const key = String(entry.id || "");
        if (key.startsWith("shop_") && key.endsWith(suffix) && !/ticket|lastmsg/.test(key)) {
          const channelId = key.slice(5, -suffix.length);
          if (!snowflake(channelId)) continue;
          const channel = access.guild.channels.cache.get(channelId);
          const value = entry.value || {};
          stores.push({
            channelId, channelName: channel?.name || "قناة غير موجودة",
            sellerId: value.sellerId || null, status: String(value.status ?? "1"),
            warns: Number(value.warns || 0), partners: Array.isArray(value.partners) ? value.partners.length : 0,
            type: value.nametype || value.type || "غير محدد"
          });
        } else if (key.startsWith("categoryMentions_") && key.endsWith(suffix)) {
          const categoryId = key.slice("categoryMentions_".length, -suffix.length);
          const value = entry.value || {};
          types.push({ categoryId, name: value.nametype || "نوع غير مسمى", price: Number(value.shopPrice || 0), maxWarns: Number(value.maxWarns || 0), mentions: Number(value.shopRoleMentions || 0) });
        } else if (key.startsWith("order_ticket_") && key.endsWith(suffix)) {
          const value = entry.value || {};
          if (value.channelId) orders.push({ userId: value.userId || null, channelId: value.channelId, channelName: access.guild.channels.cache.get(value.channelId)?.name || "تكت غير موجود" });
        } else if (key.startsWith("active_auction_")) {
          const roomId = key.slice("active_auction_".length);
          const value = entry.value || {};
          const room = access.guild.channels.cache.get(roomId);
          if (!room || value.guildId !== access.guildId) continue;
          const draft = value.draft || {};
          auctions.push({ roomId, roomName: room.name || "مزاد", ownerId: value.ownerId || draft.owner || null, title: draft.title || draft.name || draft.itemName || "مزاد نشط", status: value.paused ? "متوقف مؤقتاً" : "نشط" });
        } else if (key.startsWith("active_mzad2_")) {
          const roomId = key.slice("active_mzad2_".length);
          const value = entry.value || {};
          const room = access.guild.channels.cache.get(roomId);
          if (!room || (value.guildId && value.guildId !== access.guildId)) continue;
          auctions.push({ roomId, roomName: room.name || "مزاد", ownerId: value.ownerId || value.draft?.owner || null, title: value.draft?.title || value.draft?.name || "مزاد نشط", status: value.paused ? "متوقف مؤقتاً" : "نشط" });
        }
      }
      stores.sort((a,b) => a.channelName.localeCompare(b.channelName));
      types.sort((a,b) => a.name.localeCompare(b.name));
      json(res, 200, { stores, types, orders, auctions });
    } catch (error) {
      console.error("[Dashboard operations]", error.message);
      json(res, 500, { error: "تعذر تحميل بيانات المتاجر والمزاد والطلبات." });
    }
  });

  app.post("/dashboard/api/store-status", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const channelId = String(req.body?.channelId || "");
      const status = String(req.body?.status || "");
      if (!snowflake(channelId) || !["0","1"].includes(status)) return json(res, 400, { error: "بيانات المتجر غير صالحة." });
      const channel = access.guild.channels.cache.get(channelId);
      if (!channel) return json(res, 404, { error: "قناة المتجر غير موجودة في السيرفر." });
      const key = "shop_" + channelId + "_" + access.guildId;
      const data = await db.get(key);
      if (!data || typeof data !== "object") return json(res, 404, { error: "بيانات المتجر غير موجودة." });
      data.status = status;
      await db.set(key, data);
      await audit(access.guildId, req.session.user, "stores", [status === "1" ? "تفعيل " + channelId : "تعطيل " + channelId]);
      json(res, 200, { saved: true, status });
    } catch (error) {
      console.error("[Dashboard store status]", error.message);
      json(res, 500, { error: "تعذر تحديث حالة المتجر." });
    }
  });

  app.get("/dashboard/api/ratings", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const channelId = await db.get("rating_ch_" + access.guildId);
      if (!channelId) return json(res, 200, { channelId: null, count: 0, average: null, ratings: [] });
      const channel = await access.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !channel.messages) {
        return json(res, 200, { channelId, count: 0, average: null, ratings: [], warning: "روم التقييمات غير متاح للبوت." });
      }
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      const ratings = [];
      for (const message of (messages?.values?.() || [])) {
        const description = (message.embeds || []).map(embed => embed.description || "").join("\n");
        const match = description.match(/التقييم:\s*(⭐+)\s*\((\d)\/5\)/);
        if (!match) continue;
        const score = Number(match[2]);
        if (score < 1 || score > 5) continue;
        ratings.push({ score, stars: match[1], at: message.createdTimestamp, author: message.embeds[0]?.author?.name || "مقيّم" });
      }
      const count = ratings.length;
      const average = count ? Number((ratings.reduce((sum, item) => sum + item.score, 0) / count).toFixed(2)) : null;
      json(res, 200, { channelId, count, average, ratings: ratings.slice(0, 30) });
    } catch (error) {
      console.error("[Dashboard ratings]", error.message);
      json(res, 500, { error: "تعذر تحميل تقييمات السيرفر." });
    }
  });

  app.get("/dashboard/api/commands", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      const globalCommands = await access.bot.application.commands.fetch().catch(() => null);
      const guildCommands = await access.guild.commands.fetch().catch(() => null);
      const all = new Map();
      for (const command of [...(globalCommands?.values?.() || []), ...(guildCommands?.values?.() || [])]) {
        all.set(command.id, {
          id: command.id,
          name: command.name,
          description: command.description || "بدون وصف",
          options: (command.options || []).map(option => ({
            name: option.name,
            description: option.description || "",
            required: Boolean(option.required),
            type: option.type
          }))
        });
      }
      const shortcutDefs = [
        ["mention", "المنشنات", "shortcut_mention", "منشن", "اكتب الاختصار داخل قناة المتجر لعرض لوحة المنشنات."],
        ["warning", "التحذير", "shortcut_warning", "+تحذير", "الاستخدام: الاختصار ثم سبب التحذير."],
        ["delete", "الحذف", "shortcut_delete", "+حذف", "الاستخدام: الاختصار ثم سبب الحذف."],
        ["tax", "الضريبة", "shortcut_tax", "+tax", "الاستخدام: الاختصار ثم المبلغ، مثال: +tax 1000."],
        ["call", "النداء", "shortcut_call", "+come", "الاستخدام: الاختصار ثم منشن العضو ثم سبب الاستدعاء."],
        ["ping", "البنق", "shortcut_ping", "!ping", "اكتب الاختصار وحده لعرض استجابة البوت."],
        ["setShopOwner", "تحديد صاحب المتجر", "shortcut_setshopowner", "+تحديد-صاحب-المتجر", "الاستخدام: الاختصار ثم منشن العضو."],
        ["addMentions", "إضافة منشنات", "shortcut_addmentions", "+اضافة-منشنات", "الاستخدام: الاختصار ثم العدد داخل قناة المتجر."],
        ["setMentions", "تحديد المنشنات", "shortcut_setmentions", "+تحديد-المنشنات", "الاستخدام: الاختصار ثم العدد داخل قناة المتجر."],
        ["addShopData", "إضافة متجر للداتا", "shortcut_addshopdata", "+اضافة-متجر-للداتا", "الاستخدام: الاختصار ثم منشن صاحب المتجر ثم اسم المتجر."],
        ["createShop", "إنشاء متجر", "shortcut_createshop", "+انشاء-متجر", "الاستخدام: الاختصار ثم منشن صاحب المتجر."]
      ];
      const textCommands = await Promise.all(shortcutDefs.map(async ([key, label, dbKey, fallback, description]) => ({
        key, label, command: await db.get(dbKey + "_" + access.guildId) || fallback, description
      })));
      json(res, 200, { commands: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)), textCommands });
    } catch (error) {
      console.error("[Dashboard commands]", error.message);
      json(res, 500, { error: "تعذر تحميل أوامر البوت." });
    }
  });

  app.get("/dashboard/api/workspace", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.query);
      if (!access) return;
      await access.guild.channels.fetch().catch(() => {});
      await access.guild.roles.fetch().catch(() => {});
      const config = {};
      for (const section of Object.keys(fieldMap)) {
        config[section] = {};
        for (const field of Object.keys(fieldMap[section])) {
          config[section][field] = await getGuildValue(access.guildId, field, section);
        }
      }
      const channels = [...access.guild.channels.cache.values()]
        .filter(ch => ch && (ch.type === 0 || ch.type === 5 || ch.type === 4))
        .map(ch => ({ id: ch.id, name: ch.name, type: ch.type === 4 ? "category" : "text", parentId: ch.parentId || null }));
      const roles = [...access.guild.roles.cache.values()]
        .filter(role => role.id !== access.guild.id && !role.managed)
        .map(role => ({ id: role.id, name: role.name, position: role.position }))
        .sort((a,b) => b.position-a.position);
      const logsId = await db.get("logs_" + access.guildId);
      const logsChannel = logsId ? await access.guild.channels.fetch(logsId).catch(() => null) : null;
      let messages = [];
      if (logsChannel && logsChannel.isTextBased() && logsChannel.messages) {
        const fetched = await logsChannel.messages.fetch({ limit: 25 }).catch(() => null);
        if (fetched) messages = [...fetched.values()].map(m => ({
          id: m.id, content: m.content || (m.embeds[0]?.description || m.embeds[0]?.title || "رسالة بدون نص"),
          author: m.author?.tag || "Unknown", at: m.createdTimestamp
        }));
      }
      const auditRows = await db.get("dashboard_audit_" + access.guildId) || [];
      json(res, 200, { guild: { id: access.guild.id, name: access.guild.name }, bot: { id: access.bot.user.id, name: access.bot.user.username },
        config, channels, roles, logs: { channelId: logsId || null, messages, audit: auditRows } });
    } catch (error) {
      console.error("[Dashboard workspace]", error.message);
      json(res, 500, { error: "تعذر تحميل إعدادات لوحة التحكم." });
    }
  });

  app.post("/dashboard/api/workspace", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const { section, values } = req.body || {};
      if (!fieldMap[section] || !values || typeof values !== "object" || Array.isArray(values)) {
        return json(res, 400, { error: "بيانات القسم غير صالحة." });
      }
      await access.guild.channels.fetch().catch(() => {});
      await access.guild.roles.fetch().catch(() => {});
      const changed = [];
      for (const [field, value] of Object.entries(values)) {
        const spec = fieldMap[section][field];
        if (!spec) continue;
        const [key, type] = spec;
        if (type === "channel" || type === "category") {
          if (value === "" || value === null) {
            await db.delete(key + "_" + access.guildId);
          } else {
            if (!snowflake(value)) return json(res, 400, { error: "معرّف قناة غير صالح: " + field });
            const channel = access.guild.channels.cache.get(value);
            if (!channel || (type === "category" ? channel.type !== 4 : ![0,5].includes(channel.type))) {
              return json(res, 400, { error: "القناة المحددة غير مناسبة للحقل: " + field });
            }
            await db.set(key + "_" + access.guildId, value);
          }
        } else if (type === "role") {
          if (value === "" || value === null) {
            await db.delete(key + "_" + access.guildId);
          } else {
            if (!snowflake(value) || !access.guild.roles.cache.has(value) || access.guild.roles.cache.get(value).managed) {
              return json(res, 400, { error: "الرتبة المحددة غير صالحة: " + field });
            }
            await db.set(key + "_" + access.guildId, value);
          }
        } else if (type === "roles") {
          const ids = Array.isArray(value) ? [...new Set(value)] : [];
          if (ids.length > 10 || ids.some(id => !snowflake(id) || !access.guild.roles.cache.has(id) || access.guild.roles.cache.get(id).managed)) {
            return json(res, 400, { error: "قائمة الرتب غير صالحة." });
          }
          await db.set(key + "_" + access.guildId, ids);
        } else if (type === "user") {
          if (value === "" || value === null) await db.delete(key + "_" + access.guildId);
          else if (!snowflake(value)) return json(res, 400, { error: "آيدي المستخدم غير صالح." });
          else await db.set(key + "_" + access.guildId, value);
        } else if (type === "color") {
          const raw = String(value || "").trim();
          if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return json(res, 400, { error: "اللون يجب أن يكون HEX مثل #5865F2." });
          const normalized = "0x" + raw.replace("#", "");
          await db.set(key + "_" + access.guildId, normalized);
          try { require("./../handlers/modules/embedColor").setGuildColor(access.guildId, normalized); } catch {}
        } else if (type === "url") {
          const raw = String(value || "").trim();
          if (raw && (!/^https:\/\/\S+$/i.test(raw) || raw.length > 500)) return json(res, 400, { error: "الرابط يجب أن يبدأ بـ HTTPS." });
          if (raw) await db.set(key + "_" + access.guildId, raw);
          else await db.delete(key + "_" + access.guildId);
        } else if (type === "boolean") {
          await db.set(key + "_" + access.guildId, Boolean(value));
        } else if (type === "number") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > 365) return json(res, 400, { error: "أدخل رقماً صحيحاً بين 1 و365." });
          await db.set(key + "_" + access.guildId, n);
        } else if (type === "money") {
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) return json(res, 400, { error: "أدخل مبلغاً صحيحاً بين 0 و1,000,000,000." });
          await db.set(key + "_" + access.guildId, n);
        } else if (type === "applyType" || type === "mode") {
          const allowed = type === "applyType" ? ["dm","channel"] : ["auto","room"];
          if (!allowed.includes(value)) return json(res, 400, { error: "الخيار المحدد غير صالح." });
          await db.set(key + "_" + access.guildId, value);
        } else if (type === "questions") {
          const questions = {};
          for (let n=1;n<=5;n++) {
            const q = String(value?.[n] || "").trim();
            if (q.length > 200) return json(res, 400, { error: "السؤال الواحد يجب ألا يتجاوز 200 حرف." });
            if (q) questions[n] = q;
          }
          await db.set(key + "_" + access.guildId, questions);
        } else if (type === "words") {
          const words = Array.isArray(value) ? value : String(value || "").split(",");
          const clean = [...new Set(words.map(x => String(x).trim()).filter(Boolean))].slice(0, 100);
          if (clean.some(x => x.length > 60)) return json(res, 400, { error: "الكلمة الواحدة طويلة جداً." });
          await db.set(key + "_" + access.guildId, clean);
        } else if (type === "resetDays" || type === "resetRoom" || type === "resetMessage" || type === "resetType") {
          const resetKey = key + "_" + access.guildId;
          const cfg = await db.get(resetKey) || {};
          if (type === "resetDays") {
            if (value === "" || value === null) delete cfg.days;
            else {
              const n = Number(value);
              if (!Number.isInteger(n) || n < 1 || n > 365) return json(res, 400, { error: "مدة الريست يجب أن تكون بين 1 و365 يوم." });
              cfg.days = n;
              if (!cfg.lastReset) cfg.lastReset = Date.now();
            }
          } else if (type === "resetRoom") {
            if (value === "" || value === null) delete cfg.roomId;
            else {
              if (!snowflake(value) || !access.guild.channels.cache.has(value) || ![0,5].includes(access.guild.channels.cache.get(value).type)) return json(res, 400, { error: "روم الريست غير صالح." });
              cfg.roomId = value;
            }
          } else if (type === "resetMessage") {
            cfg.message = String(value || "").slice(0, 1800);
          } else {
            cfg.type = String(value || "").slice(0, 80);
          }
          await db.set(resetKey, cfg);
        } else if (type === "string") {
          const raw = String(value || "").trim();
          if (raw.length > 40) return json(res, 400, { error: "النص طويل جداً." });
          if (raw) await db.set(key + "_" + access.guildId, raw);
          else await db.delete(key + "_" + access.guildId);
        } else if (type === "longText") {
          const raw = String(value || "").trim();
          if (raw.length > 1800) return json(res, 400, { error: "النص يتجاوز 1800 حرف." });
          if (raw) await db.set(key + "_" + access.guildId, raw);
          else await db.delete(key + "_" + access.guildId);
        }
        changed.push(field);
      }
      await audit(access.guildId, req.session.user, section, changed);
      json(res, 200, { saved: true, changed });
    } catch (error) {
      console.error("[Dashboard save]", error.message);
      json(res, 500, { error: "تعذر حفظ الإعدادات." });
    }
  });

  app.get("/dashboard/api/purchasable-roles", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.query); if (!access) return; const roles = await db.get("buy_roles_" + access.guildId) || []; json(res, 200, { roles: Array.isArray(roles) ? roles.map((item, index) => ({ roleId: String(item.roleId || ""), name: String(item.name || ""), price: Number(item.price || 0), benefits: String(item.benefits || ""), index })) : [] }); }
    catch (error) { console.error("[Dashboard purchasable roles]", error.message); json(res, 500, { error: "تعذر تحميل الرتب الشرائية." }); }
  });
  app.post("/dashboard/api/purchasable-roles", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.body || {}); if (!access) return; const member = await access.guild.members.fetch(req.session.user.id).catch(() => null); if (!member || !member.permissions.has(ADMINISTRATOR)) return json(res, 403, { error: "إدارة الرتب الشرائية تتطلب صلاحية Administrator." });
      const body = req.body || {}, roleId = String(body.roleId || ""), role = access.guild.roles.cache.get(roleId), price = Number(body.price), benefits = String(body.benefits || "").trim().slice(0, 1000);
      if (!snowflake(roleId) || !role || role.managed || role.id === access.guild.id) return json(res, 400, { error: "اختر رتبة سيرفر صالحة وغير مُدارة." }); if (!Number.isSafeInteger(price) || price < 1 || price > 1000000000) return json(res, 400, { error: "سعر الرتبة يجب أن يكون عدداً صحيحاً أكبر من صفر." }); if (!benefits) return json(res, 400, { error: "اكتب مميزات الرتبة." });
      const roles = await db.get("buy_roles_" + access.guildId) || []; if (!Array.isArray(roles)) return json(res, 500, { error: "بيانات الرتب المخزنة غير صالحة." }); const at = roles.findIndex(item => String(item.roleId) === roleId), entry = { roleId, name: role.name, price, benefits };
      if (at >= 0) roles[at] = entry; else { if (roles.length >= 5) return json(res, 400, { error: "الحد الأقصى 5 رتب شرائية." }); roles.push(entry); } await db.set("buy_roles_" + access.guildId, roles); await audit(access.guildId, req.session.user, "purchasable-roles", [(at >= 0 ? "تعديل " : "إضافة ") + role.name]); json(res, 200, { saved: true, roles });
    } catch (error) { console.error("[Dashboard save purchasable role]", error.message); json(res, 500, { error: "تعذر حفظ الرتبة الشرائية." }); }
  });
  app.delete("/dashboard/api/purchasable-roles/:roleId", requireUser, async (req, res) => {
    try { const access = await resolveWorkspace(req, res, req.query); if (!access) return; const member = await access.guild.members.fetch(req.session.user.id).catch(() => null); if (!member || !member.permissions.has(ADMINISTRATOR)) return json(res, 403, { error: "حذف الرتب الشرائية يتطلب صلاحية Administrator." }); const roleId = String(req.params.roleId || ""); if (!snowflake(roleId)) return json(res, 400, { error: "معرّف الرتبة غير صالح." }); const roles = await db.get("buy_roles_" + access.guildId) || []; if (!Array.isArray(roles)) return json(res, 500, { error: "بيانات الرتب المخزنة غير صالحة." }); const next = roles.filter(item => String(item.roleId) !== roleId); if (next.length === roles.length) return json(res, 404, { error: "الرتبة غير موجودة في قائمة الشراء." }); await db.set("buy_roles_" + access.guildId, next); await audit(access.guildId, req.session.user, "purchasable-roles", ["حذف " + roleId]); json(res, 200, { deleted: true }); }
    catch (error) { console.error("[Dashboard delete purchasable role]", error.message); json(res, 500, { error: "تعذر حذف الرتبة الشرائية." }); }
  });
  app.post("/dashboard/api/panels", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const { type, channelId, title, description, applicationType } = req.body || {};
      if (!["tickets","support","application","shop","order","auction","prices","roles","rules","all","panel-ticket"].includes(type)) return json(res, 400, { error: "نوع البانل غير معروف." });
      if (!snowflake(channelId)) return json(res, 400, { error: "اختر روم إرسال صحيح." });
      const channel = access.guild.channels.cache.get(channelId);
      if (!channel || ![0,5].includes(channel.type)) return json(res, 400, { error: "روم الإرسال غير صالح." });
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
      const colorRaw = await db.get("embed_color_" + access.guildId) || "0x00AE86";
      const color = parseInt(String(colorRaw).replace("#","").replace("0x",""),16);
      const embed = new EmbedBuilder().setColor(Number.isFinite(color) ? color : 0x00AE86)
        .setTitle(String(title || (type === "tickets" ? "قسم التكتات والمبيعات" : type === "support" ? "مركز الدعم" : "التقديم")).slice(0, 256))
        .setDescription(String(description || "اختر الخدمة المناسبة من الأزرار بالأسفل.").slice(0, 4000))
        .setFooter({ text: access.guild.name }).setTimestamp();
      const panelImage = await db.get("image_" + access.guildId);
      if (panelImage && /^https:\/\//i.test(panelImage)) embed.setImage(panelImage);
      const rows = [];
      if (["rules","all","panel-ticket","tickets"].includes(type)) {
        const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder, MediaGalleryItemBuilder } = require("discord.js");
        const customText = String(description || "").trim();
        const container = new ContainerBuilder().setAccentColor(Number.isFinite(color) ? color : 0x00AE86);
        const guildBanner = access.guild.bannerURL({ size: 1024, extension: "png" });
        const imageUrl = guildBanner || panelImage || null;
        if (type === "rules") {
          const rules = await db.get("server_rules_" + access.guildId) || [];
          if (!Array.isArray(rules) || !rules.length) return json(res, 400, { error: "أضف القوانين أولاً من قسم القوانين." });
          container.addTextDisplayComponents(new TextDisplayBuilder().setContent("# قوانين سيرفر " + access.guild.name), new TextDisplayBuilder().setContent(customText || "اضغط على أي زر لعرض القانون بالتفصيل."));
          const rulesImage = await db.get("rulesImage_" + access.guildId), chosenImage = rulesImage || imageUrl;
          if (chosenImage && /^https:\/\//i.test(chosenImage)) { container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)); container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(chosenImage))); }
          for (let offset=0; offset<rules.length; offset+=5) {
            const buttons = rules.slice(offset,offset+5).map(rule => new ButtonBuilder().setCustomId("rule_show_" + access.guildId + "_" + rule.id).setLabel(String(rule.label || "قانون").slice(0,80)).setStyle(ButtonStyle.Secondary));
            rows.push(new ActionRowBuilder().addComponents(buttons));
          }
          rows.forEach(row => container.addActionRowComponents(row));
        } else if (type === "all") {
          container.addTextDisplayComponents(new TextDisplayBuilder().setContent("# البانل الشامل لسيرفر " + access.guild.name), new TextDisplayBuilder().setContent(customText || "اختر القسم المطلوب من الأزرار بالأسفل."));
          if (imageUrl && /^https:\/\//i.test(imageUrl)) { container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)); container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageUrl))); }
          rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("allinone_prices_" + access.guildId).setLabel("الأسعار").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("allinone_rules_" + access.guildId).setLabel("القوانين").setStyle(ButtonStyle.Secondary)));
          rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("allinone_tickets_" + access.guildId).setLabel("التكتات").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("allinone_roles_" + access.guildId).setLabel("الرتب").setStyle(ButtonStyle.Secondary)));
          rows.forEach(row => container.addActionRowComponents(row));
        } else {
          const [shopCat, shopAdmin, auctionCat, auctionAdmin, orderCat, orderAdmin, rolesCat, rolesAdmin, buyRoles] = await Promise.all([
            db.get("catbuy_shop_" + access.guildId), db.get("shopad_" + access.guildId), db.get("catbuy_auction_" + access.guildId), db.get("auctionad_" + access.guildId), db.get("catbuy_order_" + access.guildId), db.get("orderad_" + access.guildId), db.get("roles_cat_" + access.guildId), db.get("roles_admin_" + access.guildId), db.get("buy_roles_" + access.guildId)
          ]);
          container.addTextDisplayComponents(new TextDisplayBuilder().setContent("# قسم التكتات والمبيعات"), new TextDisplayBuilder().setContent(customText || "اختر الخدمة المناسبة لفتح تذكرة."));
          if (imageUrl && /^https:\/\//i.test(imageUrl)) { container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)); container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageUrl))); }
          rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("buy_shop").setLabel("شراء متجر").setStyle(ButtonStyle.Secondary).setDisabled(!shopCat || !shopAdmin), new ButtonBuilder().setCustomId("ticket-auction").setLabel("تكت مزاد").setStyle(ButtonStyle.Secondary).setDisabled(!auctionCat || !auctionAdmin), new ButtonBuilder().setCustomId("ticket-order").setLabel("تكت طلبات").setStyle(ButtonStyle.Secondary).setDisabled(!orderCat || !orderAdmin), new ButtonBuilder().setCustomId("ticket-roles").setLabel("شراء رتبة").setStyle(ButtonStyle.Secondary).setDisabled(!rolesCat || !rolesAdmin || !Array.isArray(buyRoles) || !buyRoles.length)));
          rows.forEach(row => container.addActionRowComponents(row));
        }
        const message = await channel.send({ components: [container], flags: 32768,
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },});
        await audit(access.guildId, req.session.user, "panels", [type + ":" + message.id]);
        return json(res, 200, { sent: true, channelId: channel.id, messageId: message.id, url: message.url });
      }
      if (["shop","order","auction","prices","roles"].includes(type)) {
        const panelConfigs = {
          shop: { title: "بـانـل شــراء مـتـاجـر", description: "أهلاً وسهلاً بك في قسم شراء المتاجر.", imageKey: "buyshopimage", buttons: [["buy_shop","شراء متجر"],["shoppri","أسعار المتاجر"]] },
          order: { title: "بانل شراء طلبات", description: "أهلاً بك في قسم شراء الطلبات.", imageKey: "buyorderimage", buttons: [["ticket-order","شراء طلب"],["order-price","أسعار الطلبات"]] },
          auction: { title: "بانل شراء مزاد", description: "أهلاً بك في قسم شراء المزادات.", imageKey: "buyauctionimage", buttons: [["ticket-auction","شراء مزاد"],["auctionpri","أسعار المزادات"]] },
          prices: { title: "الأسعار", description: "اختر القسم لمعرفة الأسعار.", imageKey: "priceImage", buttons: [["mzad2_prices_" + access.guildId,"أسعار المزاد الخاص"],["roles_prices_" + access.guildId,"أسعار الرتب"],["additions_prices_" + access.guildId,"أسعار الإضافات"],["order-price","أسعار الطلبات"],["auctionpri","أسعار المزادات"],["shoppri","أسعار المتاجر"]] },
          roles: { title: "الرتب المتاحة للشراء", description: "اختر زر شراء رتبة لعرض الرتب المتاحة.", imageKey: "image", buttons: [["ticket-roles","شراء رتبة"]] }
        };
        const cfg = panelConfigs[type], customImage = await db.get(cfg.imageKey + "_" + access.guildId); embed.setTitle(String(title || cfg.title).slice(0,256)).setDescription(String(description || cfg.description).slice(0,4000)); if (customImage && /^https:\/\//i.test(customImage)) embed.setImage(customImage);
        if (type === "roles") { const [category, adminRole, purchasable] = await Promise.all([db.get("roles_cat_" + access.guildId),db.get("roles_admin_" + access.guildId),db.get("buy_roles_" + access.guildId)]); if (!category || !adminRole || !Array.isArray(purchasable) || !purchasable.length) return json(res,400,{error:"أكمل إعداد كاتيغوري تكت الرتب ورتبة المسؤول وأضف رتبة واحدة على الأقل."}); }
        const buttons = cfg.buttons.map(([id,label]) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)); const rows = []; for (let offset=0; offset<buttons.length; offset+=5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(offset,offset+5)));
        const message = await channel.send({ embeds: [embed], components: rows }); await audit(access.guildId, req.session.user, "panels", [type + ":" + message.id]); return json(res, 200, { sent: true, channelId: channel.id, messageId: message.id, url: message.url });
      } else if (type === "tickets") {
        const [shopCat, shopAdmin, auctionCat, auctionAdmin, orderCat, orderAdmin, rolesCat, rolesAdmin, buyRoles] = await Promise.all([
          db.get("catbuy_shop_" + access.guildId), db.get("shopad_" + access.guildId),
          db.get("catbuy_auction_" + access.guildId), db.get("auctionad_" + access.guildId),
          db.get("catbuy_order_" + access.guildId), db.get("orderad_" + access.guildId),
          db.get("roles_cat_" + access.guildId), db.get("roles_admin_" + access.guildId),
          db.get("buy_roles_" + access.guildId)
        ]);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("buy_shop").setLabel("شراء متجر").setStyle(ButtonStyle.Secondary).setDisabled(!shopCat || !shopAdmin),
          new ButtonBuilder().setCustomId("ticket-auction").setLabel("تكت مزاد").setStyle(ButtonStyle.Secondary).setDisabled(!auctionCat || !auctionAdmin),
          new ButtonBuilder().setCustomId("ticket-order").setLabel("تكت طلبات").setStyle(ButtonStyle.Secondary).setDisabled(!orderCat || !orderAdmin),
          new ButtonBuilder().setCustomId("ticket-roles").setLabel("شراء رتبة").setStyle(ButtonStyle.Secondary).setDisabled(!rolesCat || !rolesAdmin || !Array.isArray(buyRoles) || !buyRoles.length)
        );
        rows.push(row);
      } else if (type === "support") {
        const [supportCat, supportAdmin, scamAdmin] = await Promise.all([
          db.get("support_cat_" + access.guildId), db.get("support_admin_" + access.guildId), db.get("scam_admin_" + access.guildId)
        ]);
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket-support").setLabel("الدعم الفني").setStyle(ButtonStyle.Primary).setDisabled(!supportCat || !supportAdmin),
          new ButtonBuilder().setCustomId("ticket-scam").setLabel("التشهير والبلاغات").setStyle(ButtonStyle.Danger).setDisabled(!supportCat || !(scamAdmin || supportAdmin))
        ));
      } else {
        const category = await db.get("apply_ticketcat_" + access.guildId);
        const adminRoom = await db.get("apply_admin_" + access.guildId);
        const questions = await db.get("apply_qs_" + access.guildId) || {};
        if (!adminRoom) return json(res, 400, { error: "حدد روم استقبال التقديمات للإدارة أولاً." });
        if (applicationType === "ticket" && !category) return json(res, 400, { error: "حدد كاتيغوري تكت التقديم أولاً." });
        if (applicationType !== "ticket" && !Object.values(questions).some(Boolean)) return json(res, 400, { error: "أضف أسئلة التقديم أولاً." });
        if (await db.get("apply_disabled_" + access.guildId)) return json(res, 400, { error: "نظام التقديم معطل حالياً." });
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(applicationType === "ticket" ? "apply_open_ticket" : "apply_open_questions")
            .setLabel("تقديم").setStyle(ButtonStyle.Success)
        ));
      }
      const message = await channel.send({ embeds: [embed], components: rows });
      await audit(access.guildId, req.session.user, "panels", [type + ":" + message.id]);
      json(res, 200, { sent: true, channelId: channel.id, messageId: message.id, url: message.url });
    } catch (error) {
      console.error("[Dashboard panel send]", error.message);
      json(res, 500, { error: "تعذر إرسال البانل. تأكد من صلاحية البوت لإرسال الرسائل وإضافة المكونات." });
    }
  });

  app.get("/dashboard/api/health", (req, res) => json(res, 200, { ok: true, readyBots: bots.filter(bot => bot.isReady()).length }));
}

module.exports = setupDashboard;
