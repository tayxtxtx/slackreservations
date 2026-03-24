const { CalendarService, CalendarServiceError } = require('./calendarService');
const Config = require('./configuration');

const calendarService = new CalendarService(Config.autobayCalendars, Config.google || {});

const COMMAND_HELP = `Autobay commands:
status
book <bay_name> <duration>
cancel <bay_name>
upcoming <bay_name>
upcoming <bay_name> for <YYYY-MM-DD|MM/DD/YYYY|today|tomorrow>
help

Examples:
book Bay 1 30
book Bay 2 1h
cancel Bay 1
upcoming Bay 3 for tomorrow`;

function registerAutobayListeners(controller, options = {}) {
  const service = options.calendarService || calendarService;
  const adminUserId = options.adminUserId || Config.slackAdminUserId || null;

  controller.on(['direct_message', 'direct_mention'], async (bot, message) => {
    const text = sanitizeIncomingText(message.text);

    if (!text) {
      return;
    }

    try {
      const caller = await getSlackCaller(bot, message);
      const responseText = await routeCommand({
        bot,
        message,
        text,
        caller,
        service
      });

      if (responseText) {
        bot.reply(message, responseText);
      }
    } catch (error) {
      const reply = formatErrorForSlack(error);
      bot.reply(message, reply);

      if (adminUserId && shouldNotifyAdmin(error)) {
        notifyAdmin(bot, adminUserId, error, message);
      }
    }
  });
}

async function routeCommand({ text, caller, service }) {
  if (/^(?:autobay\s+)?help$/i.test(text)) {
    return COMMAND_HELP;
  }

  if (/^(?:autobay\s+)?status$/i.test(text) || /^autobay$/i.test(text)) {
    const statuses = await service.getAutobayStatuses();
    return formatStatuses(statuses);
  }

  const bookMatch = text.match(/^(?:autobay\s+)?book\s+(.+?)\s+([0-9]+(?:m(?:in)?|h)?)$/i);
  if (bookMatch) {
    const bayName = bookMatch[1].trim();
    const durationMinutes = parseDuration(bookMatch[2]);

    if (!durationMinutes) {
      throw new CalendarServiceError(
        'Booking duration must look like 30, 60, 30m, 30min, or 1h.',
        'INVALID_DURATION'
      );
    }

    const result = await service.bookBay({
      bayName,
      durationMinutes,
      slackUserId: caller.id,
      slackUserName: caller.name
    });

    return `Booked ${result.bayName} for ${durationMinutes} minutes from ${formatDateTime(
      result.startTime
    )} to ${formatTime(result.endTime)}.`;
  }

  const cancelMatch = text.match(/^(?:autobay\s+)?cancel\s+(.+)$/i);
  if (cancelMatch) {
    const bayName = cancelMatch[1].trim();
    const result = await service.cancelBooking({
      bayName,
      slackUserId: caller.id
    });

    return `Canceled your reservation for ${result.bayName} starting at ${formatDateTime(result.event.start)}.`;
  }

  const upcomingForMatch = text.match(/^(?:autobay\s+)?upcoming\s+(.+?)\s+for\s+(.+)$/i);
  if (upcomingForMatch) {
    const bayName = upcomingForMatch[1].trim();
    const dayRange = buildDayRange(upcomingForMatch[2].trim());
    const result = await service.getUpcomingReservations({
      bayName,
      startTime: dayRange.start,
      endTime: dayRange.end
    });

    return formatUpcoming(result.bayName, result.reservations, dayRange.label);
  }

  const upcomingMatch = text.match(/^(?:autobay\s+)?upcoming\s+(.+)$/i);
  if (upcomingMatch) {
    const bayName = upcomingMatch[1].trim();
    const now = new Date();
    const endOfToday = new Date(now);

    endOfToday.setHours(23, 59, 59, 999);

    const result = await service.getUpcomingReservations({
      bayName,
      startTime: now,
      endTime: endOfToday
    });

    return formatUpcoming(result.bayName, result.reservations, 'today');
  }

  return COMMAND_HELP;
}

function parseDuration(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  const match = value.match(/^(\d+)(m(?:in)?|h)?$/);

  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 'm';

  if (unit === 'h') {
    return amount * 60;
  }

  return amount;
}

function buildDayRange(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  const baseDate = new Date();

  if (value === 'today') {
    return {
      label: 'today',
      start: startOfDay(baseDate),
      end: endOfDay(baseDate)
    };
  }

  if (value === 'tomorrow') {
    const tomorrow = new Date(baseDate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      label: 'tomorrow',
      start: startOfDay(tomorrow),
      end: endOfDay(tomorrow)
    };
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = Number.parseInt(isoMatch[1], 10);
    const month = Number.parseInt(isoMatch[2], 10);
    const day = Number.parseInt(isoMatch[3], 10);
    const date = new Date(year, month - 1, day);

    if (isValidDate(date, year, month, day)) {
      return {
        label: isoMatch[0],
        start: startOfDay(date),
        end: endOfDay(date)
      };
    }
  }

  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = Number.parseInt(slashMatch[1], 10);
    const day = Number.parseInt(slashMatch[2], 10);
    const year = Number.parseInt(slashMatch[3], 10);
    const date = new Date(year, month - 1, day);

    if (isValidDate(date, year, month, day)) {
      return {
        label: `${month}/${day}/${year}`,
        start: startOfDay(date),
        end: endOfDay(date)
      };
    }
  }

  throw new CalendarServiceError(
    'Date must be YYYY-MM-DD, MM/DD/YYYY, today, or tomorrow.',
    'INVALID_DATE'
  );
}

function isValidDate(date, year, month, day) {
  return (
    date instanceof Date &&
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function sanitizeIncomingText(text) {
  return String(text || '')
    .replace(/<@[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatStatuses(statuses) {
  const lines = statuses.map(status => {
    if (status.state === 'OCCUPIED') {
      return `${status.bayName}: Occupied until ${formatDateTime(status.until)} by ${formatOwner(
        status.currentEvent
      )}`;
    }

    if (!status.freeUntil) {
      return `${status.bayName}: Free with no upcoming reservations`;
    }

    return `${status.bayName}: Free for ${formatDuration(status.availableForMs)} (until ${formatDateTime(
      status.freeUntil
    )})`;
  });

  return `Autobay status:\n${lines.join('\n')}`;
}

function formatUpcoming(bayName, reservations, label) {
  if (!reservations.length) {
    return `No reservations found for ${bayName} ${label}.`;
  }

  const lines = reservations.map(event => {
    const title = event.visibility === 'private' ? 'Busy' : event.summary;
    return `${formatDateTime(event.start)} - ${formatTime(event.end)} | ${title} | ${formatOwner(event)}`;
  });

  return `Upcoming reservations for ${bayName} ${label}:\n${lines.join('\n')}`;
}

function formatOwner(event) {
  if (!event) {
    return 'Unknown';
  }

  const summaryOwner =
    event.summary && /^Reserved by /i.test(event.summary)
      ? event.summary.replace(/^Reserved by /i, '').trim()
      : null;

  return (
    (event.extendedProperties &&
      event.extendedProperties.private &&
      event.extendedProperties.private.slack_user_name) ||
    summaryOwner ||
    (event.creator && event.creator.displayName) ||
    (event.organizer && event.organizer.displayName) ||
    'Unknown'
  );
}

function formatDuration(durationMs) {
  if (durationMs == null) {
    return 'indefinitely';
  }

  const totalMinutes = Math.max(1, Math.round(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }

  if (hours) {
    return `${hours}h`;
  }

  return `${minutes}m`;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: getDisplayTimeZone()
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: getDisplayTimeZone()
  }).format(date);
}

function formatErrorForSlack(error) {
  if (error instanceof CalendarServiceError) {
    if (error.code === 'BOOKING_CONFLICT') {
      const owner = error.details.blockingOwnerName || 'Unknown';
      const nextSlot = error.details.nextAvailableStart
        ? formatDateTime(error.details.nextAvailableStart)
        : 'unknown';

      return `This slot is reserved or overlaps with the reservation by: ${owner}. Next available slot: ${nextSlot}`;
    }

    if (
      ['BAY_NOT_FOUND', 'INVALID_DURATION', 'INVALID_DATE', 'BOOKING_NOT_FOUND', 'RATE_LIMITED', 'INVALID_USER'].includes(
        error.code
      )
    ) {
      return error.message;
    }

    return error.message;
  }

  return 'Please try again in a moment.';
}

function shouldNotifyAdmin(error) {
  if (!(error instanceof CalendarServiceError)) {
    return true;
  }

  return ![
    'BAY_NOT_FOUND',
    'INVALID_DURATION',
    'INVALID_DATE',
    'BOOKING_NOT_FOUND',
    'BOOKING_CONFLICT',
    'RATE_LIMITED',
    'INVALID_USER'
  ].includes(error.code);
}

function getDisplayTimeZone() {
  return (Config.google && Config.google.timeZone) || 'America/Chicago';
}

function getSlackCaller(bot, message) {
  return new Promise(resolve => {
    bot.api.users.info({ user: message.user }, (error, response) => {
      if (error || !response || !response.user) {
        resolve({
          id: message.user,
          name: message.username || message.user
        });
        return;
      }

      const { user } = response;
      const displayName = user.profile.display_name || user.real_name || user.name || message.user;

      resolve({
        id: user.id,
        name: displayName
      });
    });
  });
}

function notifyAdmin(bot, adminUserId, error, message) {
  const details = [
    `Autobay bot error: ${error.stack || error.message || error}`,
    `User: ${message.user}`,
    `Text: ${message.text}`
  ].join('\n');

  bot.startPrivateConversation({ user: adminUserId }, (conversationError, conversation) => {
    if (!conversationError && conversation) {
      conversation.say(details);
    }
  });
}

module.exports = {
  registerAutobayListeners,
  parseDuration,
  buildDayRange
};
