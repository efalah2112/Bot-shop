const path = require("path");
const crypto = require("crypto");
const expressSession = require("express-session");
const Database = require("better-sqlite3");
const maker = require("../handlers/modules/maker");

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
  const developerIds = new Set([maker.MAKER_OWNER_ID, ...(process.env.DASHBOARD_DEVELOPER_IDS || "").split(",").map(x => x.trim()).filter(Boolean)]);

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
    next();
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
      const userId = req.session.user.id;
      const records = await getAllPremiumRecords();
      const premiumAvailable = records.some(record =>
        record.userId === userId || record.dashboardOwnerId === userId
      );
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
        const owned = records.filter(record => record.userId === req.session.user.id || record.dashboardOwnerId === req.session.user.id);
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
  app.use("/dashboard/api", require("express").json({ limit: "256kb" }));

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
      if (nickname.length > 32) return json(res, 400, { error: "اسم البوت داخل السيرفر يجب ألا يتجاوز 32 حرفاً." });
      const me = await access.guild.members.fetchMe();
      if (!me.permissions.has("ManageNicknames")) return json(res, 403, { error: "البوت يحتاج صلاحية Manage Nicknames لتغيير اسمه داخل السيرفر." });
      await me.setNickname(nickname || null, "Dashboard bot identity update");
      await audit(access.guildId, req.session.user, "identity", ["تحديث الاسم الظاهر للبوت"]);
      json(res, 200, { saved: true, nickname });
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
        ["order_ticket_channel_", "طلب"]
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
        tickets.push({ channelId, channelName: channel.name, type: prefix[1], ownerId: value.ownerId || null, url: "https://discord.com/channels/" + access.guildId + "/" + channelId });
      }
      json(res, 200, { tickets: tickets.slice(0, 100) });
    } catch (error) {
      console.error("[Dashboard tickets]", error.message);
      json(res, 500, { error: "تعذر تحميل التذاكر المفتوحة." });
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
      if (imageUrl && (!/^https:\\/\\/\\S+$/i.test(imageUrl) || imageUrl.length > 500)) return json(res, 400, { error: "رابط الصورة يجب أن يبدأ بـ HTTPS." });
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
      const message = await channel.send({ embeds: [embed] });
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
        } else if (key.startsWith("active_mzad2_")) {
          const roomId = key.slice("active_mzad2_".length);
          if (!access.guild.channels.cache.has(roomId)) continue;
          const value = entry.value || {};
          auctions.push({ roomId, roomName: access.guild.channels.cache.get(roomId)?.name || "مزاد", ownerId: value.ownerId || value.draft?.owner || null, title: value.draft?.title || value.draft?.name || "مزاد نشط" });
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
      const callShortcut = await db.get("shortcut_call_" + access.guildId) || "+come";
      const taxShortcut = await db.get("shortcut_tax_" + access.guildId) || "+tax";
      const textCommands = [
        { command: callShortcut, description: "استدعاء مسؤول المتجر (اختصار قابل للتخصيص)" },
        { command: taxShortcut, description: "حساب الضريبة (اختصار قابل للتخصيص)" },
        { command: "+تحذيرات", description: "إعداد تحذيرات المتاجر التلقائية" },
        { command: "+تسطيب التقديم", description: "إعداد التقديمات" },
        { command: "+اضافه", description: "إضافة المتاجر إلى قاعدة البيانات" },
        { command: "!داتا", description: "إغلاق التكت وحذف بياناته" }
      ];
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

  app.post("/dashboard/api/panels", requireUser, async (req, res) => {
    try {
      const access = await resolveWorkspace(req, res, req.body || {});
      if (!access) return;
      const { type, channelId, title, description, applicationType } = req.body || {};
      if (!["tickets","support","application"].includes(type)) return json(res, 400, { error: "نوع البانل غير معروف." });
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
      if (type === "tickets") {
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
