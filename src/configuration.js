const fs = require('fs');
const path = require('path');

function readJsonFileIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJsonEnv(envName) {
  const value = process.env[envName];

  if (!value) {
    return null;
  }

  return JSON.parse(value);
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getAutobayCalendars() {
  const envCalendars = parseJsonEnv('AUTOBAY_CALENDARS_JSON');

  if (Array.isArray(envCalendars) && envCalendars.length > 0) {
    return envCalendars;
  }

  const localConfigPath = path.resolve(process.cwd(), 'autobayCalendars.json');
  const fileCalendars = readJsonFileIfPresent(localConfigPath);

  if (Array.isArray(fileCalendars) && fileCalendars.length > 0) {
    return fileCalendars;
  }

  throw new Error(
    'Missing Autobay calendar configuration. Set AUTOBAY_CALENDARS_JSON or add autobayCalendars.json.'
  );
}

module.exports = {
  slackBotToken: process.env.SLACK_BOT_TOKEN || process.env.BOT_TOKEN,
  slackAdminUserId: process.env.SLACK_ADMIN_USER_ID || '',
  allowGuestsToUse: parseBoolean(process.env.ALLOW_GUESTS_TO_USE, false),
  autobayCalendars: getAutobayCalendars(),
  google: {
    credentialsPath: path.resolve(process.cwd(), process.env.GOOGLE_CLIENT_SECRET_PATH || 'client_secret.json'),
    tokenPath: path.resolve(process.cwd(), process.env.GOOGLE_TOKEN_PATH || 'token.json'),
    credentialsJson: process.env.GOOGLE_CLIENT_SECRET_JSON || null,
    tokenJson: process.env.GOOGLE_TOKEN_JSON || null,
    serviceAccountKeyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || null,
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
    delegatedUser: process.env.GOOGLE_IMPERSONATED_USER || null,
    timeZone: process.env.GOOGLE_TIME_ZONE || 'America/Chicago'
  }
};
