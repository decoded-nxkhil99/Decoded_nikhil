# Telegram File & Promotion Bot

Railway-ready Telegram bot for channel-locked file delivery, channel announcement posts, and opt-in subscriber updates. The bot has no third-party npm dependencies and needs Node.js 20 or later.

## Deploy on Railway

1. Extract this ZIP and add the folder to a GitHub repository (or deploy it using your preferred Railway source flow).
2. Deploy the repository root as a Railway service. `railway.json` starts the bot.
3. Set Railway Variables: `TELEGRAM_BOT_TOKEN` (secret) and `ADMIN_IDS` (your numeric Telegram user ID).
4. Add a Railway Volume mounted at `/data`; set `DATA_FILE=/data/bot-state.json`. This preserves the file list and subscriber/channel settings between deploys.
5. Optionally set `REQUIRED_CHANNELS=@channel_one,@channel_two` and `PROMOTION_CHANNELS=@channel_one,@channel_three`. Private channels use `channel_id|https://t.me/+invitecode`.
6. Make the bot an administrator in channels used for join checks or promotion posts. Keep one service replica per bot token.

## Commands

Users: `/start`, `/files`, `/get <id>`, `/stop`.

Admins: `/savefile <id> <title>` (reply to a media message), `/deletefile <id>`, `/addchannel @channel join|post|both [invite-link]`, `/removechannel @channel`, `/channels`, `/post <text>`, `/broadcast <text>`, `/status`, `/addadmin <user-id>`, `/removeadmin <user-id>`.

Broadcasts require confirmation and only reach users who have started the bot and not opted out. Users who have not started the bot cannot be messaged.
