import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN. Add your bot token to the Railway service variables.");
}

const rootAdminIds = new Set(
  (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (rootAdminIds.size === 0 || [...rootAdminIds].some((id) => !/^\d+$/.test(id))) {
  throw new Error("Set ADMIN_IDS to at least one numeric Telegram user ID (comma-separated).");
}

const dataFile = resolve(process.env.DATA_FILE?.trim() || "./data/telegram-bot-state.json");
const apiBase = `https://api.telegram.org/bot${token}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

class TelegramApiError extends Error {
  constructor(method, payload) {
    super(payload.description || `Telegram API request failed: ${method}`);
    this.name = "TelegramApiError";
    this.retryAfter = payload.parameters?.retry_after ?? 0;
    this.errorCode = payload.error_code ?? 0;
  }
}

async function telegram(method, parameters = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parameters),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram returned an unreadable response for ${method} (HTTP ${response.status}).`);
  }

  if (!response.ok || !payload.ok) {
    throw new TelegramApiError(method, payload);
  }
  return payload.result;
}

function parseChannelList(value, role) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [chatId, suppliedUrl] = item.split("|").map((part) => part.trim());
      const publicName = chatId.replace(/^@/, "");
      const url = suppliedUrl || (/^[a-zA-Z0-9_]{5,}$/.test(publicName) ? `https://t.me/${publicName}` : "");
      if (!chatId || !url) {
        throw new Error(`Channel "${item}" needs an invite link after "|" because it is not a public @username.`);
      }
      return {
        chatId,
        title: chatId,
        url,
        requireJoin: role === "join" || role === "both",
        promoteTo: role === "post" || role === "both",
      };
    });
}

function emptyState() {
  return { users: {}, admins: [], channels: [], files: [] };
}

async function loadState() {
  let loaded;
  try {
    loaded = JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not read bot state at ${dataFile}: ${error.message}`);
    }
    loaded = emptyState();
  }

  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new Error(`Bot state at ${dataFile} is not a JSON object; refusing to overwrite it.`);
  }
  const state = {
    ...emptyState(),
    ...loaded,
    users: loaded.users && typeof loaded.users === "object" ? loaded.users : {},
    admins: Array.isArray(loaded.admins) ? loaded.admins.map(String) : [],
    channels: Array.isArray(loaded.channels) ? loaded.channels : [],
    files: Array.isArray(loaded.files) ? loaded.files : [],
  };

  for (const channel of [
    ...parseChannelList(process.env.REQUIRED_CHANNELS, "join"),
    ...parseChannelList(process.env.PROMOTION_CHANNELS, "post"),
  ]) {
    const existing = state.channels.find((entry) => entry.chatId === channel.chatId);
    if (existing) {
      existing.requireJoin ||= channel.requireJoin;
      existing.promoteTo ||= channel.promoteTo;
      existing.url ||= channel.url;
    } else {
      state.channels.push(channel);
    }
  }
  return state;
}

let state = await loadState();
let writeQueue = Promise.resolve();

function saveState() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, snapshot, "utf8");
    await rename(temporaryFile, dataFile);
  });
  return writeQueue;
}

function isAdmin(userId) {
  const id = String(userId);
  return rootAdminIds.has(id) || state.admins.includes(id);
}

function isRootAdmin(userId) {
  return rootAdminIds.has(String(userId));
}

function parseCommand(text) {
  const match = text?.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

function hasMedia(message) {
  return Boolean(
    message.document ||
      message.photo ||
      message.video ||
      message.audio ||
      message.animation ||
      message.voice ||
      message.video_note,
  );
}

function userName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Telegram user";
}

async function sendMessage(chatId, text, replyMarkup) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function adminMenuKeyboard(owner) {
  const keyboard = [
    [
      { text: "📊 Bot status", callback_data: "admin:status" },
      { text: "📋 Channels", callback_data: "admin:channels" },
    ],
    [
      { text: "📁 Files", callback_data: "admin:files" },
      { text: "➕ Add channel", callback_data: "admin:addchannel" },
    ],
    [
      { text: "➖ Remove channel", callback_data: "admin:removechannel" },
      { text: "💾 Save file", callback_data: "admin:savefile" },
    ],
    [
      { text: "🗑 Delete file", callback_data: "admin:deletefile" },
      { text: "📣 Channel post", callback_data: "admin:post" },
    ],
    [{ text: "📢 Message users", callback_data: "admin:broadcast" }],
  ];
  if (owner) keyboard.push([{ text: "👮 Manage admins", callback_data: "admin:admins" }]);
  return { inline_keyboard: keyboard };
}

function adminBackKeyboard() {
  return { inline_keyboard: [[{ text: "⬅️ Admin menu", callback_data: "admin:menu" }]] };
}

async function showAdminMenu(chatId, userId) {
  await sendMessage(
    chatId,
    "🛠 Admin Menu\nNeeche button dabayein. Har option ke saath use karne ka example milega.",
    adminMenuKeyboard(isRootAdmin(userId)),
  );
}

async function copyFileToUser(chatId, file) {
  return telegram("copyMessage", {
    chat_id: chatId,
    from_chat_id: file.sourceChatId,
    message_id: file.sourceMessageId,
  });
}

function activeRequiredChannels() {
  return state.channels.filter((channel) => channel.requireJoin);
}

function channelJoinKeyboard(channels, fileId) {
  return {
    inline_keyboard: [
      ...channels.map((channel) => [{ text: `Join ${channel.title}`, url: channel.url }]),
      [{ text: "I've joined — verify", callback_data: `verify:${fileId}` }],
    ],
  };
}

async function checkMembership(userId, channels) {
  const notJoined = [];
  for (const channel of channels) {
    try {
      const member = await telegram("getChatMember", {
        chat_id: channel.chatId,
        user_id: userId,
      });
      if (
        ["left", "kicked"].includes(member.status) ||
        (member.status === "restricted" && member.is_member === false)
      ) {
        notJoined.push(channel);
      }
    } catch (error) {
      console.error(`Membership check failed for ${channel.chatId}: ${error.message}`);
      return { error: true, notJoined: [] };
    }
  }
  return { error: false, notJoined };
}

async function deliverFile(userId, chatId, file) {
  const required = activeRequiredChannels();
  if (required.length) {
    const membership = await checkMembership(userId, required);
    if (membership.error) {
      await sendMessage(
        chatId,
        "I couldn't verify channel membership. Please try again in a moment, or contact the bot admin.",
      );
      return;
    }
    if (membership.notJoined.length) {
      await sendMessage(
        chatId,
        `Join all ${membership.notJoined.length} required channel(s), then tap verify to get "${file.title}".`,
        channelJoinKeyboard(membership.notJoined, file.id),
      );
      return;
    }
  }

  try {
    await copyFileToUser(chatId, file);
  } catch (error) {
    console.error(`Could not deliver saved file "${file.id}": ${error.message}`);
    await sendMessage(chatId, "This file couldn't be delivered. Please contact the bot admin.");
  }
}

function findFile(fileId) {
  return state.files.find((file) => file.id.toLowerCase() === fileId.toLowerCase());
}

async function showFiles(chatId) {
  if (state.files.length === 0) {
    await sendMessage(chatId, "No files are available yet. Please check back later.");
    return;
  }
  await sendMessage(chatId, "Choose a file. Required channel membership is checked before delivery.", {
    inline_keyboard: state.files.slice(0, 100).map((file) => [
      { text: file.title.slice(0, 60), callback_data: `get:${file.id}` },
    ]),
  });
}

function parseChannelArgument(value, role, suppliedUrl) {
  if (!/^(@[a-zA-Z0-9_]{5,}|-?\d+)$/.test(value)) {
    throw new Error("Use a public @channelname or numeric channel ID.");
  }
  const publicName = value.replace(/^@/, "");
  const url = suppliedUrl || (/^[a-zA-Z0-9_]{5,}$/.test(publicName) ? `https://t.me/${publicName}` : "");
  if (!url || !/^https:\/\/t\.me\//i.test(url)) {
    throw new Error("Private channels need an invite link, for example https://t.me/+invitecode.");
  }
  return {
    chatId: value,
    title: value,
    url,
    requireJoin: role === "join" || role === "both",
    promoteTo: role === "post" || role === "both",
  };
}

async function postToChannels(text) {
  const targets = state.channels.filter((channel) => channel.promoteTo);
  if (!targets.length) {
    return { sent: 0, failed: 0, message: "No promotion channels are configured. Add one with /addchannel." };
  }

  let sent = 0;
  let failed = 0;
  for (const channel of targets) {
    try {
      await sendMessage(channel.chatId, text);
      sent += 1;
      await delay(80);
    } catch (error) {
      failed += 1;
      console.error(`Post failed for ${channel.chatId}: ${error.message}`);
    }
  }
  return { sent, failed, message: `Post complete: ${sent} sent, ${failed} failed.` };
}

async function broadcastToSubscribers(text) {
  const subscribers = Object.entries(state.users).filter(([, user]) => user?.active !== false);
  let sent = 0;
  let failed = 0;

  for (const [userId] of subscribers) {
    try {
      await sendMessage(userId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      if (error.errorCode === 403) {
        state.users[userId].active = false;
      }
      if (error.retryAfter) await delay((error.retryAfter + 1) * 1000);
    }
    await delay(45);
  }
  await saveState();
  return { sent, failed };
}

async function answerCallback(callbackQuery, text) {
  await telegram("answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    text,
    show_alert: false,
  });
}

async function handleCallback(callbackQuery) {
  const data = callbackQuery.data ?? "";
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat.id ?? userId;

  if (data.startsWith("get:") || data.startsWith("verify:")) {
    const fileId = data.slice(data.indexOf(":") + 1);
    const file = findFile(fileId);
    if (!file) {
      await answerCallback(callbackQuery, "That file is no longer available.");
      return;
    }
    await answerCallback(callbackQuery, data.startsWith("verify:") ? "Checking your memberships…" : "Checking access…");
    await deliverFile(userId, chatId, file);
    return;
  }

  if (data.startsWith("admin:")) {
    if (!isAdmin(userId)) {
      await answerCallback(callbackQuery, "Admin access required.");
      return;
    }
    await answerCallback(callbackQuery);
    const action = data.slice("admin:".length);
    if (action === "menu") {
      await showAdminMenu(chatId, userId);
      return;
    }
    if (action === "status") {
      const activeUsers = Object.values(state.users).filter((user) => user?.active !== false).length;
      await sendMessage(
        chatId,
        `📊 Bot status\nActive users: ${activeUsers}\nSaved files: ${state.files.length}\nJoin channels: ${activeRequiredChannels().length}\nPromotion channels: ${state.channels.filter((channel) => channel.promoteTo).length}\nAdmins: ${new Set([...rootAdminIds, ...state.admins]).size}`,
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "channels") {
      const lines = state.channels.map(
        (channel) =>
          `${channel.chatId} — ${channel.requireJoin ? "join required" : "no join check"}; ${
            channel.promoteTo ? "receives posts" : "no posts"
          }`,
      );
      await sendMessage(
        chatId,
        lines.length ? `📋 Channels\n${lines.join("\n")}` : "Abhi koi channel add nahi hai.",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "files") {
      const lines = state.files.map((file) => `• ${file.id} — ${file.title}`);
      await sendMessage(
        chatId,
        lines.length ? `📁 Saved files\n${lines.join("\n")}` : "Abhi koi file save nahi hai.",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "addchannel") {
      await sendMessage(
        chatId,
        "➕ Channel add karne ke liye bot ko channel ka admin banayein, phir bhejein:\n/addchannel <channel ID> <join|post|both> <invite link>\nExample:\n/addchannel -1001234567890 both https://t.me/+invitecode\njoin = membership check, post = promotion bhejna, both = dono.",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "removechannel") {
      await sendMessage(
        chatId,
        "➖ Channel hatane ke liye bhejein:\n/removechannel <channel ID>\nExample: /removechannel -1001234567890",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "savefile") {
      await sendMessage(
        chatId,
        "💾 Bot ko file/photo/video bhejein. Us message par Reply karke bhejein:\n/savefile <id> <title>\nExample: /savefile offer1 Latest Offer",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "deletefile") {
      await sendMessage(
        chatId,
        "🗑 Pehle Files button se file ID dekhein. Phir bhejein:\n/deletefile <id>\nExample: /deletefile offer1",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "post") {
      await sendMessage(
        chatId,
        "📣 Promotion channel par post bhejne ke liye:\n/post <aapka message>\nExample: /post Naya offer available hai!",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "broadcast") {
      await sendMessage(
        chatId,
        "📢 Users ko update bhejne ke liye:\n/broadcast <aapka message>\nPehle confirmation aayega. Sirf bot start karke updates lene wale users ko message jayega.",
        adminBackKeyboard(),
      );
      return;
    }
    if (action === "admins") {
      if (!isRootAdmin(userId)) {
        await sendMessage(chatId, "Admin access sirf owner badal sakta hai.", adminBackKeyboard());
        return;
      }
      await sendMessage(
        chatId,
        "👮 Admin add/remove (sirf owner):\n/addadmin <user ID>\n/removeadmin <user ID>\nExample: /addadmin 123456789",
        adminBackKeyboard(),
      );
    }
    return;
  }

  if (data.startsWith("broadcast:")) {
    if (!isAdmin(userId)) {
      await answerCallback(callbackQuery, "Admin access required.");
      return;
    }
    const choice = data.slice("broadcast:".length);
    const pending = pendingBroadcasts.get(String(chatId));
    if (!pending) {
      await answerCallback(callbackQuery, "This broadcast has expired. Send /broadcast again.");
      return;
    }
    pendingBroadcasts.delete(String(chatId));
    if (choice !== "confirm") {
      await answerCallback(callbackQuery, "Broadcast cancelled.");
      return;
    }
    await answerCallback(callbackQuery, "Sending to opted-in users…");
    const result = await broadcastToSubscribers(pending.text);
    await sendMessage(chatId, `Broadcast finished: ${result.sent} delivered, ${result.failed} failed.`);
  }
}

const pendingBroadcasts = new Map();

async function handleMessage(message) {
  if (!message.from || message.chat.type !== "private") return;
  const userId = message.from.id;
  const chatId = message.chat.id;
  const command = parseCommand(message.text);

  if (command?.name === "start") {
    const id = String(userId);
    state.users[id] = {
      active: true,
      name: userName(message.from),
      username: message.from.username ?? "",
      startedAt: state.users[id]?.startedAt ?? new Date().toISOString(),
    };
    await saveState();
    await sendMessage(
      chatId,
      "Welcome! Use /files to browse. Join every required channel and tap verify to unlock a file. Use /stop to stop bot updates.",
    );
    return;
  }

  if (command?.name === "stop") {
    if (state.users[String(userId)]) {
      state.users[String(userId)].active = false;
      await saveState();
    }
    await sendMessage(chatId, "Bot updates are stopped. You can still use /files; send /start to opt back in.");
    return;
  }

  if (command?.name === "help") {
    await sendMessage(
      chatId,
      "Commands:\n/start — start the bot and opt in to updates\n/files — browse available files\n/get <id> — request one file\n/stop — stop future broadcast updates\n\nAdmins: /admin — open the button menu; /status, /channels, /addchannel, /removechannel, /savefile, /deletefile, /post, /broadcast, /addadmin, /removeadmin",
    );
    return;
  }

  if (command?.name === "files") {
    await showFiles(chatId);
    return;
  }

  if (command?.name === "get") {
    const file = findFile(command.args);
    if (!file) {
      await sendMessage(chatId, "File not found. Use /files to see available files.");
      return;
    }
    await deliverFile(userId, chatId, file);
    return;
  }

  if (!command || !isAdmin(userId)) {
    if (command) await sendMessage(chatId, "That command is for bot admins only. Use /help to see user commands.");
    return;
  }

  if (command.name === "admin") {
    await showAdminMenu(chatId, userId);
    return;
  }

  if (command.name === "status") {
    const activeUsers = Object.values(state.users).filter((user) => user?.active !== false).length;
    await sendMessage(
      chatId,
      `Bot status\nActive opted-in users: ${activeUsers}\nSaved files: ${state.files.length}\nRequired channels: ${activeRequiredChannels().length}\nPromotion channels: ${state.channels.filter((channel) => channel.promoteTo).length}\nAdmins: ${new Set([...rootAdminIds, ...state.admins]).size}`,
    );
    return;
  }

  if (command.name === "channels") {
    if (!state.channels.length) {
      await sendMessage(chatId, "No channels yet. Add one with /addchannel @channelname both.");
      return;
    }
    const lines = state.channels.map(
      (channel) =>
        `${channel.chatId} — ${channel.requireJoin ? "join required" : "no join gate"}; ${
          channel.promoteTo ? "receives posts" : "no posts"
        }`,
    );
    await sendMessage(chatId, `Configured channels:\n${lines.join("\n")}`);
    return;
  }

  if (command.name === "addchannel") {
    const [chatIdArg, role, url] = command.args.split(/\s+/);
    if (!chatIdArg || !["join", "post", "both"].includes(role)) {
      await sendMessage(
        chatId,
        "Usage: /addchannel @channelname join|post|both [invite-link]\nThe bot must be an admin in channels used for join verification or posting.",
      );
      return;
    }
    try {
      const channel = parseChannelArgument(chatIdArg, role, url);
      const existing = state.channels.find((entry) => entry.chatId === channel.chatId);
      if (existing) {
        existing.requireJoin ||= channel.requireJoin;
        existing.promoteTo ||= channel.promoteTo;
        existing.url = channel.url;
      } else {
        state.channels.push(channel);
      }
      await saveState();
      await sendMessage(chatId, `Channel saved: ${channel.chatId} (${role}).`);
    } catch (error) {
      await sendMessage(chatId, error.message);
    }
    return;
  }

  if (command.name === "removechannel") {
    const before = state.channels.length;
    state.channels = state.channels.filter((channel) => channel.chatId !== command.args);
    if (before === state.channels.length) {
      await sendMessage(chatId, "That channel was not found. Use /channels to list configured channels.");
    } else {
      await saveState();
      await sendMessage(chatId, `Removed ${command.args} from join checks and promotion posts.`);
    }
    return;
  }

  if (command.name === "savefile") {
    const [rawId, ...titleParts] = command.args.split(/\s+/);
    const title = titleParts.join(" ").trim();
    const source = message.reply_to_message;
    if (!/^[a-z0-9_-]{1,32}$/i.test(rawId ?? "") || !title || !source || !hasMedia(source)) {
      await sendMessage(
        chatId,
        "Reply to a file/photo/video/audio message with:\n/savefile <id> <title>\nExample: /savefile lesson-1 Algebra lesson",
      );
      return;
    }
    if (findFile(rawId)) {
      await sendMessage(chatId, "That file ID is already in use. Choose another ID or delete the old entry first.");
      return;
    }
    state.files.push({
      id: rawId,
      title,
      sourceChatId: source.chat.id,
      sourceMessageId: source.message_id,
      addedAt: new Date().toISOString(),
    });
    await saveState();
    await sendMessage(chatId, `Saved "${title}" as ${rawId}. Users can request it with /get ${rawId}.`);
    return;
  }

  if (command.name === "deletefile") {
    const before = state.files.length;
    state.files = state.files.filter((file) => file.id.toLowerCase() !== command.args.toLowerCase());
    if (state.files.length === before) {
      await sendMessage(chatId, "File ID not found.");
    } else {
      await saveState();
      await sendMessage(chatId, `Removed file ${command.args}.`);
    }
    return;
  }

  if (command.name === "post") {
    if (!command.args) {
      await sendMessage(chatId, "Usage: /post your channel announcement text");
      return;
    }
    const result = await postToChannels(command.args);
    await sendMessage(chatId, result.message);
    return;
  }

  if (command.name === "broadcast") {
    if (!command.args) {
      await sendMessage(chatId, "Usage: /broadcast your update text\nOnly users who started the bot and remain opted in will receive it.");
      return;
    }
    const subscriberCount = Object.values(state.users).filter((user) => user?.active !== false).length;
    if (!subscriberCount) {
      await sendMessage(chatId, "There are no opted-in users to message.");
      return;
    }
    pendingBroadcasts.set(String(chatId), { text: command.args });
    await sendMessage(chatId, `Send this update to ${subscriberCount} opted-in user(s)?`, {
      inline_keyboard: [
        [
          { text: "Confirm broadcast", callback_data: "broadcast:confirm" },
          { text: "Cancel", callback_data: "broadcast:cancel" },
        ],
      ],
    });
    return;
  }

  if (command.name === "addadmin" || command.name === "removeadmin") {
    if (!isRootAdmin(userId)) {
      await sendMessage(chatId, "Only an ADMIN_IDS owner can add or remove admins.");
      return;
    }
    if (!/^\d+$/.test(command.args)) {
      await sendMessage(chatId, `Usage: /${command.name} <numeric Telegram user ID>`);
      return;
    }
    const target = command.args;
    if (rootAdminIds.has(target)) {
      await sendMessage(chatId, "An owner from ADMIN_IDS cannot be changed with this command.");
      return;
    }
    if (command.name === "addadmin") {
      if (!state.admins.includes(target)) state.admins.push(target);
      await saveState();
      await sendMessage(chatId, `Admin added: ${target}`);
    } else {
      state.admins = state.admins.filter((id) => id !== target);
      await saveState();
      await sendMessage(chatId, `Admin removed: ${target}`);
    }
    return;
  }

  await sendMessage(chatId, "Unknown command. Use /help.");
}

async function processUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
  } else if (update.message) {
    await handleMessage(update.message);
  }
}

async function main() {
  await saveState();
  const bot = await telegram("getMe");
  await telegram("deleteWebhook", { drop_pending_updates: false });
  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Start the bot and opt in to updates" },
      { command: "help", description: "Show help and available commands" },
      { command: "files", description: "Browse available files" },
      { command: "get", description: "Get a file by its ID" },
      { command: "stop", description: "Stop future broadcast updates" },
      { command: "admin", description: "Open the admin menu (admins only)" },
    ],
  });

  console.info(`Telegram bot @${bot.username} is running with long polling.`);
  console.info(`State file: ${dataFile}`);
  if (!process.env.DATA_FILE) {
    console.warn("DATA_FILE is not set. On Railway, attach a persistent volume and set DATA_FILE=/data/bot-state.json.");
  }

  let offset = 0;
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await processUpdate(update);
        } catch (error) {
          console.error(`Update ${update.update_id} failed: ${error.message}`);
        }
      }
    } catch (error) {
      const waitMs = error.retryAfter ? (error.retryAfter + 1) * 1000 : 3000;
      console.error(`Polling failed: ${error.message}. Retrying in ${Math.ceil(waitMs / 1000)}s.`);
      await delay(waitMs);
    }
  }
}

main().catch((error) => {
  console.error(`Bot startup failed: ${error.message}`);
  process.exitCode = 1;
});
