const Botkit = require('botkit');
const Config = require('./configuration');
const { registerAutobayListeners } = require('./botLogic');

if (!Config.slackBotToken) {
  throw new Error('Missing SLACK_BOT_TOKEN.');
}

const controller = Botkit.slackbot({
  debug: false
});

const bot = controller
  .spawn({
    token: Config.slackBotToken
  })
  .startRTM((error) => {
    if (error) {
      throw error;
    }
  });

registerAutobayListeners(controller, {
  adminUserId: Config.slackAdminUserId || null
});

controller.on('rtm_close', () => {
  process.exit(1);
});

process.on('SIGTERM', () => {
  try {
    bot.closeRTM();
  } catch (error) {
    process.exit(0);
  }

  setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', error => {
  console.error(error);
});

process.on('unhandledRejection', error => {
  console.error(error);
});
